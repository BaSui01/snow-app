/**
 * 独立浏览器窗口「还原为标签页」：把窗口内实例（含全部内部标签页）
 * 还原回主窗口右侧面板的浏览器 tab（保持原 instanceId）。
 */

/** 浏览器实例内部的一个标签页快照。 */
export type BrowserRestoreTab = {
  url: string;
  title: string;
};

/** 还原请求载荷：实例 id + 该实例的全部标签页。 */
export type BrowserRestorePayload = {
  instanceId: string;
  tabs: BrowserRestoreTab[];
};
