import { BrowserWindow, nativeTheme } from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  DetachedPanelPayload,
  DetachedPanelRuntimeMirror,
  DetachedPanelTabPayload,
} from "../../shared/detachedPanel";
import { DETACHED_PANEL_RUNTIME_MIRROR_BROADCAST_CHANNEL } from "../../shared/detachedPanel";
import { snowLog } from "../../utils/snowLogger";
import {
  killAllPtyForWebContents,
  reservePtyForHandoff,
} from "../pty/ptyManager";
import { APP_ICON_PATH, isMacOS } from "./constants";
import { buildRendererPageUrl } from "./rendererPageUrl";
import { safeSend } from "../utils/safeSend";

/**
 * 独立面板窗口（右侧面板 tab「在新窗口中打开」）。
 *
 * 窗口承载一个 RightPanel 实例（detachedWindow 模式），初始 tab 由主进程暂存的
 * payload，窗口渲染后凭 token 取回，因此 payload 不经 URL 传输、刷新页面后仍可恢复。
 * 窗口关闭时回收其名下的终端会话（迁移中的会话由 ptyManager 保留）。
 *
 * 系统标题栏隐藏（与主窗口一致）：macOS 保留原生红绿灯（hidden 标题栏），Windows /
 * Linux 无边框，由渲染端 DetachedPanelTitleBar 提供顶部操作栏与窗口控制按钮。
 */

const DEFAULT_WINDOW_WIDTH = 980;
const DEFAULT_WINDOW_HEIGHT = 680;
const MIN_WINDOW_WIDTH = 420;
const MIN_WINDOW_HEIGHT = 320;
/** macOS 红绿灯位置：与 44px 顶部操作栏垂直居中。 */
const TRAFFIC_LIGHT_POSITION = { x: 16, y: 16 };

type DetachedPanelEntry = {
  payload: DetachedPanelPayload;
  window: BrowserWindow;
};

/** token -> 面板窗口与其初始化 payload（窗口关闭时移除）。 */
const panelEntries = new Map<string, DetachedPanelEntry>();

/**
 * 主窗口运行时快照镜像的最近一份：新开的独立窗口挂载时凭此补齐会话 / 项目状态。
 * 镜像只在主进程内存中保存，不落盘。
 */
let latestRuntimeMirror: DetachedPanelRuntimeMirror | null = null;

const getWindowBackgroundColor = (): string =>
  nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff";

/** 终端 tab 携带的 ptyId：迁移时需要交接保留的会话。 */
const readTerminalPtyId = (tab: DetachedPanelTabPayload): string | null => {
  if (tab.type !== "terminal" || !tab.data || typeof tab.data !== "object") {
    return null;
  }
  const ptyId = (tab.data as Record<string, unknown>).ptyId;
  return typeof ptyId === "string" && ptyId.trim() ? ptyId.trim() : null;
};

/**
 * 把即将随 tab 迁移的终端会话登记为交接保留。必须在源 tab 卸载（触发 kill）
 * 之前调用；目标端挂载并 claim 后解除。
 */
export const reserveDetachedTabPty = (tab: DetachedPanelTabPayload): void => {
  const ptyId = readTerminalPtyId(tab);
  if (ptyId) {
    reservePtyForHandoff(ptyId);
  }
};

/** 校验渲染端传入的 tab 快照结构；不合法返回 null。 */
export const parseDetachedTabPayload = (
  value: unknown,
): DetachedPanelTabPayload | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.type !== "string" ||
    typeof record.title !== "string"
  ) {
    return null;
  }
  return {
    id: record.id,
    type: record.type,
    title: record.title,
    data: record.data,
  };
};

/**
 * 打开独立面板窗口承载给定 tab。tab 的终端会话随即进入交接保留状态；
 * 调用方在返回后再从源面板移除该 tab。
 */
export const openDetachedPanelWindow = (
  payload: DetachedPanelPayload,
): void => {
  reserveDetachedTabPty(payload.tab);

  const token = randomUUID();
  const win = new BrowserWindow({
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    title: payload.tab.title || "Snow",
    icon: APP_ICON_PATH,
    autoHideMenuBar: true,
    backgroundColor: getWindowBackgroundColor(),
    // 隐藏系统标题栏：macOS 保留原生红绿灯（与主窗口同一组配置），其余平台无边框。
    frame: false,
    titleBarStyle: isMacOS ? "hidden" : "default",
    ...(isMacOS ? { trafficLightPosition: TRAFFIC_LIGHT_POSITION } : {}),
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false,
    },
  });
  const contents = win.webContents;
  panelEntries.set(token, { payload, window: win });

  win.setMenu(null);
  win.setMenuBarVisibility(false);
  win.setAutoHideMenuBar(true);

  // 最大化状态推送给本窗口：主窗口的同名推送只发给主窗口，这里为独立窗口单独推送，
  // 供自绘窗口控制按钮切换图标。macOS 无自绘按钮，不需要推送。
  if (!isMacOS) {
    const notifyMaximizeState = (): void => {
      safeSend(contents, "window:maximize-state-changed", win.isMaximized());
    };
    win.on("maximize", notifyMaximizeState);
    win.on("unmaximize", notifyMaximizeState);
  }

  // 等待首帧渲染后再显示，避免白屏闪烁。
  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) {
      win.show();
    }
  });

  win.on("closed", () => {
    panelEntries.delete(token);
    // 窗口已销毁：回收名下会话（交接中的会话保留，等待目标窗口 claim）。
    killAllPtyForWebContents(contents);
  });

  // 渲染进程异常退出时自动重新加载，避免窗口黑屏卡死；payload 仍在主进程暂存，
  // 重新加载后可重新取回。
  contents.on("render-process-gone", (_event, details) => {
    snowLog.error({
      module: "main/app/detachedPanelWindow",
      func: "render-process-gone",
      message: "Detached panel renderer process gone, reloading window",
      context: JSON.stringify(details),
    });
    if (!win.isDestroyed()) {
      contents.reload();
    }
  });

  // 防御性兜底：渲染进程主框架导航到应用页面之外的 URL 一律阻止。
  contents.on("will-navigate", (event, targetUrl) => {
    const devServerUrl = process.env.ELECTRON_RENDERER_URL;
    if (devServerUrl && targetUrl.startsWith(devServerUrl)) {
      return; // 开发模式放行 Vite dev server 同源导航（HMR 全量刷新场景）
    }
    event.preventDefault();
  });

  void win
    .loadURL(
      buildRendererPageUrl(
        "detachedPanel.html",
        new URLSearchParams({ token }),
      ),
    )
    .catch((error) => {
      console.error("Failed to load detached panel window:", error);
    });
};

/** 渲染端凭 token 取回面板窗口的初始化 payload（窗口不存在时返回 null）。 */
export const takeDetachedPanelPayload = (
  token: string,
): DetachedPanelPayload | null => panelEntries.get(token)?.payload ?? null;

/** 记录主窗口发来的运行时快照镜像，并转发给所有已打开的独立面板窗口。 */
export const publishDetachedRuntimeMirror = (
  mirror: DetachedPanelRuntimeMirror,
): void => {
  latestRuntimeMirror = mirror;
  for (const { window } of panelEntries.values()) {
    if (!window.isDestroyed()) {
      safeSend(
        window.webContents,
        DETACHED_PANEL_RUNTIME_MIRROR_BROADCAST_CHANNEL,
        mirror,
      );
    }
  }
};

/** 取回最近一份运行时快照镜像（独立窗口挂载时调用）。 */
export const takeDetachedRuntimeMirror =
  (): DetachedPanelRuntimeMirror | null => latestRuntimeMirror;

/** 关闭所有独立面板窗口（主窗口关闭时调用，避免残留孤儿窗口）。 */
export const closeAllDetachedPanelWindows = (): void => {
  for (const { window } of panelEntries.values()) {
    if (!window.isDestroyed()) {
      window.close();
    }
  }
  panelEntries.clear();
};
