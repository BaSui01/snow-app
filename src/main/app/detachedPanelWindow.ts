import { BrowserWindow, nativeTheme, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  DetachedPanelPayload,
  DetachedPanelRuntimeMirror,
  DetachedPanelTabPayload,
} from "../../shared/detachedPanel";
import {
  DETACHED_PANEL_CLOSE_REQUESTED_CHANNEL,
  DETACHED_PANEL_CONVERSATION_ACTIVATE_BROADCAST_CHANNEL,
  DETACHED_PANEL_RUNTIME_MIRROR_BROADCAST_CHANNEL,
} from "../../shared/detachedPanel";
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
  /**
   * 窗口归属的会话 id：会话 tab 中的会话（含子代理 / Workflow 节点）与仍在运行的会话。
   * 初始值来自 payload，之后由渲染端上报覆盖。
   */
  conversationIds: string[];
};

type ConversationOwnersListener = (conversationIds: string[]) => void;

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

/** 会话 tab 携带的会话 id（仅 conversation 类型 tab 有）。 */
const readConversationId = (tab: DetachedPanelTabPayload): string | null => {
  if (
    tab.type !== "conversation" ||
    !tab.data ||
    typeof tab.data !== "object"
  ) {
    return null;
  }
  const conversationId = (tab.data as Record<string, unknown>).conversationId;
  return typeof conversationId === "string" && conversationId.trim()
    ? conversationId.trim()
    : null;
};

/** 所有独立窗口归属会话 id 变化的监听者（主窗口用于拦截点击与释放缓存）。 */
const conversationOwnersListeners = new Set<ConversationOwnersListener>();

/** 已通过二次确认（或无需确认）、可以真正关闭的窗口。 */
const confirmedCloseWindows = new WeakSet<BrowserWindow>();

/** 应用正在退出：独立窗口随之关闭，不再逐个二次确认。 */
let detachedPanelsQuitting = false;

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
  const initialConversationId = readConversationId(payload.tab);
  panelEntries.set(token, {
    payload,
    window: win,
    conversationIds: initialConversationId ? [initialConversationId] : [],
  });
  notifyConversationOwners();

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

  win.on("close", (event) => {
    if (detachedPanelsQuitting || confirmedCloseWindows.has(win)) {
      return;
    }
    // 用户关闭（标题栏关闭按钮、系统关闭）先二次确认，确认后由渲染端调用 confirmDetachedPanelClose。
    event.preventDefault();
    safeSend(contents, DETACHED_PANEL_CLOSE_REQUESTED_CHANNEL);
  });

  win.on("closed", () => {
    panelEntries.delete(token);
    // 窗口已销毁：归属会话随之释放，主窗口可重新加载这些会话。
    notifyConversationOwners();
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

  // 立即显示：窗口底色在创建时由 backgroundColor 决定（与应用当前深浅色一致），
  // 页面内置的加载占位在样式与脚本就绪前即可绘制，无需等待首帧。
  win.show();

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

/** 判断发送方是否为独立面板窗口（用于校验渲染端发来的广播请求）。 */
export const isDetachedPanelWebContents = (sender: WebContents): boolean => {
  for (const { window } of panelEntries.values()) {
    if (!window.isDestroyed() && window.webContents.id === sender.id) {
      return true;
    }
  }
  return false;
};

/** 当前所有独立窗口归属的会话 id（去重）。 */
export const getDetachedConversationIds = (): string[] => {
  const ids = new Set<string>();
  for (const { conversationIds } of panelEntries.values()) {
    for (const conversationId of conversationIds) {
      ids.add(conversationId);
    }
  }
  return [...ids];
};

/** 归属会话 id 变化时通知所有监听者（携带变化后的完整列表）。 */
const notifyConversationOwners = (): void => {
  const conversationIds = getDetachedConversationIds();
  for (const listener of conversationOwnersListeners) {
    listener(conversationIds);
  }
};

/** 订阅独立窗口归属会话变化；返回取消订阅函数。 */
export const subscribeDetachedConversationOwners = (
  listener: ConversationOwnersListener,
): (() => void) => {
  conversationOwnersListeners.add(listener);
  return () => {
    conversationOwnersListeners.delete(listener);
  };
};

/**
 * 独立窗口渲染端上报其归属会话 id（tab 中的会话与运行中的会话）。
 * 以发送方 webContents 定位窗口；非独立窗口的发送方忽略。
 */
export const reportDetachedPanelConversationIds = (
  sender: WebContents,
  conversationIds: string[],
): void => {
  for (const entry of panelEntries.values()) {
    if (
      entry.window.isDestroyed() ||
      entry.window.webContents.id !== sender.id
    ) {
      continue;
    }
    entry.conversationIds = conversationIds;
    notifyConversationOwners();
    return;
  }
};

/**
 * 聚焦归属某会话的独立窗口并要求其激活该会话 tab。
 * 返回 false 表示没有窗口归属该会话（调用方应按普通会话加载）。
 */
export const focusDetachedPanelConversation = (
  conversationId: string,
): boolean => {
  for (const entry of panelEntries.values()) {
    const win = entry.window;
    if (win.isDestroyed() || !entry.conversationIds.includes(conversationId)) {
      continue;
    }
    if (win.isMinimized()) {
      win.restore();
    }
    win.show();
    win.focus();
    safeSend(
      win.webContents,
      DETACHED_PANEL_CONVERSATION_ACTIVATE_BROADCAST_CHANNEL,
      conversationId,
    );
    return true;
  }
  return false;
};

/**
 * 循环聚焦独立面板窗口：按打开顺序切到下一个窗口；当前焦点不在独立窗口上
 * （如焦点在主窗口）时切到第一个。没有独立窗口时返回 false。
 */
export const focusNextDetachedPanelWindow = (): boolean => {
  const windows = [...panelEntries.values()]
    .map((entry) => entry.window)
    .filter((win) => !win.isDestroyed());
  if (windows.length === 0) {
    return false;
  }
  const focused = BrowserWindow.getFocusedWindow();
  const currentIndex = focused ? windows.indexOf(focused) : -1;
  const next = windows[(currentIndex + 1) % windows.length];
  if (next.isMinimized()) {
    next.restore();
  }
  next.show();
  next.focus();
  return true;
};

/** 渲染端用户确认关闭后调用：标记该窗口已确认并关闭（仅对独立窗口生效）。 */
export const confirmDetachedPanelClose = (sender: WebContents): void => {
  if (!isDetachedPanelWebContents(sender)) {
    return;
  }
  const win = BrowserWindow.fromWebContents(sender);
  if (!win || win.isDestroyed()) {
    return;
  }
  confirmedCloseWindows.add(win);
  win.close();
};

/** 应用开始退出：之后独立窗口的关闭不再弹出二次确认。 */
export const markDetachedPanelsQuitting = (): void => {
  detachedPanelsQuitting = true;
};

/**
 * 关闭所有独立面板窗口（主窗口关闭时调用，避免残留孤儿窗口）。
 * 主窗口本身已完成确认，这里的关闭不再逐个询问。
 */
export const closeAllDetachedPanelWindows = (): void => {
  for (const { window } of panelEntries.values()) {
    if (!window.isDestroyed()) {
      confirmedCloseWindows.add(window);
      window.close();
    }
  }
  panelEntries.clear();
};
