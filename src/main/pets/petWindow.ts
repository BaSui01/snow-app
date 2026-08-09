/**
 * 桌面宠物窗口管理器。
 *
 * 宠物以独立的透明无边框置顶窗口呈现（与 Codex App 的呈现方式一致），
 * 加载渲染进程的 pet.html 页面绘制精灵图动画。主进程负责：
 * - 窗口生命周期（唤醒 / 收起 / 退出清理）
 * - 活动状态机（忙碌 / 等待 / 出错 / 完成 / 待机）并广播给宠物窗口
 * - 拖拽移动（基于主进程光标坐标，1:1 跟手，无 DPI/坐标漂移）
 *
 * 位置策略：每次唤醒都出现在固定的默认位置（应用主窗口右下角），
 * 主窗口不可用时回退到主显示器工作区右下角，不做跨会话位置持久化，
 * 避免宠物出现在屏幕外而"找不到"。
 */
import { BrowserWindow, screen } from "electron";
import { is } from "@electron-toolkit/utils";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { NativeBridge, PetManifestRecord } from "../native/types";
import { snowLog } from "../../utils/snowLogger";
import { safeSend } from "../utils/safeSend";
import { getMainWindow } from "../app/mainWindow";
import {
  loadPetSettings,
  type PetActivityState,
  type PetSettings,
} from "./petSettings";

/** Codex 精灵图单帧宽度（像素）。 */
const PET_FRAME_WIDTH = 192;
/** Codex 精灵图单帧高度（像素）。 */
const PET_FRAME_HEIGHT = 208;
/** 窗口四周预留空间（跳跃/挥手等动作的位移余量）。 */
const PET_WINDOW_PADDING = 12;
/** 一次流结束到回落 idle 的延迟（避免连续工具调用间状态抖动）。 */
const SETTLE_DELAY_MS = 3000;
/** 拖拽停止后回落到基础状态的延迟（毫秒）。 */
const DRAG_DIRECTION_SETTLE_MS = 160;
/** 唤醒时与屏幕边缘的间距。 */
const WAKE_EDGE_MARGIN = 24;

/** 发送给宠物窗口 / 设置界面的完整配置。 */
export type PetWindowConfig = {
  settings: PetSettings;
  manifest: PetManifestRecord | null;
};

let petWindow: BrowserWindow | null = null;
let currentConfig: PetWindowConfig | null = null;
let currentState: PetActivityState = "idle";
let activeStreams = 0;
let waitingCount = 0;
let settleTimer: NodeJS.Timeout | null = null;

const computeWindowSize = (
  scale: number
): { width: number; height: number } => ({
  width: Math.round(PET_FRAME_WIDTH * scale) + PET_WINDOW_PADDING * 2,
  height: Math.round(PET_FRAME_HEIGHT * scale) + PET_WINDOW_PADDING * 2,
});

/**
 * 唤醒位置：优先贴靠应用主窗口右下角（跟随主窗口所在显示器），
 * 并 clamp 到该显示器工作区内，防止主窗口贴近屏幕边缘时宠物出界；
 * 主窗口不可用时回退到主显示器工作区右下角。
 */
const resolveWakePosition = (
  width: number,
  height: number
): { x: number; y: number } => {
  const mainWindow = getMainWindow();
  if (!mainWindow) {
    const workArea = screen.getPrimaryDisplay().workArea;
    return {
      x: workArea.x + workArea.width - width - WAKE_EDGE_MARGIN,
      y: workArea.y + workArea.height - height - WAKE_EDGE_MARGIN,
    };
  }

  const bounds = mainWindow.getBounds();
  const { x: areaX, y: areaY, width: areaWidth, height: areaHeight } =
    screen.getDisplayMatching(bounds).workArea;
  return {
    x: Math.min(
      Math.max(bounds.x + bounds.width - width - WAKE_EDGE_MARGIN, areaX),
      areaX + areaWidth - width
    ),
    y: Math.min(
      Math.max(bounds.y + bounds.height - height - WAKE_EDGE_MARGIN, areaY),
      areaY + areaHeight - height
    ),
  };
};

const clearSettleTimer = (): void => {
  if (settleTimer) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
};

/** 根据当前计数解析应展示的活动状态。 */
const resolveActivityState = (): PetActivityState => {
  if (waitingCount > 0) {
    return "waiting";
  }
  if (activeStreams > 0) {
    return "busy";
  }
  return "idle";
};

const broadcastState = (): void => {
  if (petWindow && !petWindow.isDestroyed()) {
    safeSend(petWindow.webContents, "pets:activity-changed", currentState);
  }
};

const applyState = (state: PetActivityState): void => {
  if (state === currentState) {
    return;
  }
  currentState = state;
  broadcastState();
};

/** 向所有常规窗口广播宠物配置变化（设置界面据此刷新列表）。 */
const broadcastPetsChanged = (): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window === petWindow || window.isDestroyed()) {
      continue;
    }
    safeSend(window.webContents, "pets:changed");
  }
};

const broadcastConfig = (): void => {
  if (petWindow && !petWindow.isDestroyed() && currentConfig) {
    safeSend(petWindow.webContents, "pets:config-changed", currentConfig);
  }
};

/** 向宠物窗口广播拖拽方向（左/右奔跑），null 表示拖拽停止。 */
const broadcastDragState = (
  state: "running-right" | "running-left" | null
): void => {
  if (petWindow && !petWindow.isDestroyed()) {
    safeSend(petWindow.webContents, "pets:drag-state", state);
  }
};

/** 解析当前激活宠物的清单（从 Rust 后端的宠物列表中查找）。 */
const resolveActiveManifest = async (
  native: NativeBridge,
  settings: PetSettings
): Promise<PetManifestRecord | null> => {
  if (!settings.activePetId) {
    return null;
  }
  try {
    const pets = await native.listInstalledPets();
    return pets.find((pet) => pet.id === settings.activePetId) ?? null;
  } catch (error) {
    snowLog.warn({
      module: "pets/petWindow",
      func: "resolveActiveManifest",
      message: "Failed to list installed pets",
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

const destroyPetWindow = (): void => {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.destroy();
  }
  petWindow = null;
};

/** 刷新配置并按需创建/更新/关闭宠物窗口。 */
export const refreshPetWindow = async (
  native: NativeBridge
): Promise<void> => {
  const settings = await loadPetSettings(native);
  const manifest = await resolveActiveManifest(native, settings);
  currentConfig = { settings, manifest };

  const shouldShow = settings.enabled && manifest !== null;
  if (!shouldShow) {
    destroyPetWindow();
    broadcastPetsChanged();
    return;
  }

  if (!petWindow || petWindow.isDestroyed()) {
    createPetWindow(settings);
  } else {
    const { width, height } = computeWindowSize(settings.scale);
    petWindow.setSize(width, height);
  }

  broadcastConfig();
  broadcastState();
  broadcastPetsChanged();
};

const createPetWindow = (settings: PetSettings): void => {
  const { width, height } = computeWindowSize(settings.scale);
  const { x, y } = resolveWakePosition(width, height);

  petWindow = new BrowserWindow({
    width,
    height,
    x,
    y,
    title: "Snow Pet",
    transparent: true,
    frame: false,
    resizable: false,
    movable: true, // 程序化 setPosition 需要；无边框窗口无 OS 拖拽入口
    alwaysOnTop: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    roundedCorners: false,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/pet.mjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  petWindow.setAlwaysOnTop(true, "screen-saver");
  petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  petWindow.once("ready-to-show", () => {
    petWindow?.show();
  });

  petWindow.on("closed", () => {
    petWindow = null;
  });

  // OS 级拖拽时渲染层收不到指针事件，改由窗口 move 事件推断移动方向，
  // 驱动左/右奔跑动画；停止移动一小段时间后回落到基础状态。
  let lastDragX: number | null = null;
  let dragIdleTimer: NodeJS.Timeout | null = null;
  petWindow.on("move", () => {
    if (!petWindow || petWindow.isDestroyed()) {
      return;
    }
    const [x] = petWindow.getPosition();
    if (lastDragX !== null && x !== lastDragX) {
      broadcastDragState(x > lastDragX ? "running-right" : "running-left");
      if (dragIdleTimer) {
        clearTimeout(dragIdleTimer);
      }
      dragIdleTimer = setTimeout(() => {
        dragIdleTimer = null;
        broadcastDragState(null);
      }, DRAG_DIRECTION_SETTLE_MS);
    }
    lastDragX = x;
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    petWindow
      .loadURL(`${process.env.ELECTRON_RENDERER_URL}/pet.html`)
      .catch((error) => {
        snowLog.error({
          module: "pets/petWindow",
          func: "createPetWindow",
          message: "Failed to load pet renderer (dev)",
          error: error instanceof Error ? error.message : String(error),
        });
      });
  } else {
    petWindow
      .loadURL(
        pathToFileURL(join(import.meta.dirname, "../renderer/pet.html")).toString()
      )
      .catch((error) => {
        snowLog.error({
          module: "pets/petWindow",
          func: "createPetWindow",
          message: "Failed to load pet renderer",
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
};

/** 应用启动后调用：若宠物处于唤醒状态则恢复宠物窗口。 */
export const restorePetWindow = async (
  native: NativeBridge
): Promise<void> => {
  try {
    await refreshPetWindow(native);
  } catch (error) {
    snowLog.warn({
      module: "pets/petWindow",
      func: "restorePetWindow",
      message: "Failed to restore pet window",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

/** 获取当前宠物配置（宠物窗口 preload 启动时拉取）。 */
export const getCurrentPetConfig = (): PetWindowConfig | null => currentConfig;

// ── AI 活动状态联动 ─────────────────────────────────────────────────

/** 一个 AI 回合（整条 agent loop）开始。 */
export const reportPetTurnStarted = (): void => {
  activeStreams += 1;
  clearSettleTimer();
  applyState(resolveActivityState());
};

/** 一个 AI 回合彻底结束。failed=true 时宠物短暂播放失败动画。 */
export const reportPetTurnEnded = (failed: boolean): void => {
  activeStreams = Math.max(0, activeStreams - 1);
  clearSettleTimer();

  if (activeStreams > 0 || waitingCount > 0) {
    applyState(resolveActivityState());
    return;
  }

  if (failed) {
    applyState("error");
  } else {
    applyState("completed");
  }

  // 短暂展示结果状态后回落到 idle。
  settleTimer = setTimeout(() => {
    settleTimer = null;
    applyState(resolveActivityState());
  }, SETTLE_DELAY_MS);
};

/** AI 向用户提问的等待计数（宠物展示 waiting 动画）。 */
export const reportPetWaiting = (active: boolean): void => {
  waitingCount = Math.max(0, waitingCount + (active ? 1 : -1));
  clearSettleTimer();
  applyState(resolveActivityState());
};

/** 应用退出前清理。 */
export const disposePetWindow = (): void => {
  clearSettleTimer();
  destroyPetWindow();
};
