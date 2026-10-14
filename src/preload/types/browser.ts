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

/** 渲染端请求在主窗口右侧面板新建浏览器 tab（经主进程转发给主窗口）。 */
export type OpenBrowserTabInMainPayload = {
  url: string;
};
