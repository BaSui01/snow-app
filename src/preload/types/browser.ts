/**
 * 独立浏览器窗口「还原为标签页」：把窗口内实例（当前页面）还原回
 * 主窗口右侧面板的浏览器 tab（保持原 instanceId）。
 */

/** 主进程 frame 操作参数，省略 frameId 时选择主 frame。 */
export type BrowserFrameOperationArgs = Record<string, unknown> & {
  frameId?: string | null;
};

/** Frame IDs are opaque document handles, never authentication data or CDP session IDs. */
export type BrowserFrameInfo = {
  frameId: string;
  parentFrameId: string | null;
  isMainFrame: boolean;
  url: string;
  name: string;
};

export type BrowserFramesResult = {
  frames: BrowserFrameInfo[];
  unavailable: { frameTreeNodeId: number; error: string }[];
};

export type BrowserRestorePayload = {
  instanceId: string;
  url: string;
  title: string;
};

/** 独立浏览器窗口内 guest 页面请求打开新标签页 → 主窗口新建浏览器 tab。 */
export type OpenBrowserTabInMainPayload = {
  url: string;
};
