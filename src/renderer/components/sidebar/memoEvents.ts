/**
 * 备忘录数据变更广播。
 *
 * 备忘录页面在增删改后派发该事件，侧栏徽标据此刷新待办数量；
 * 独立成模块是为了让侧栏订阅事件时不必静态引入备忘录页面（懒加载分包）。
 */
export const MEMOS_CHANGED_EVENT = "memo:changed";

/**
 * AI（app-control 工具）改动备忘后派发，备忘面板据此重新拉取列表。
 * 面板自身的增删改只派发 MEMOS_CHANGED_EVENT，不走本事件，避免自动保存时
 * 反复刷新列表。deletedIds 为本次被删除的 memoId，供面板回退选中项。
 */
export const MEMOS_AI_CHANGED_EVENT = "memo:ai-changed";

export interface MemosAiChangedDetail {
  deletedIds: string[];
}

export const notifyMemosChanged = (): void => {
  window.dispatchEvent(new CustomEvent(MEMOS_CHANGED_EVENT));
};

export const notifyMemosAiChanged = (deletedIds: string[] = []): void => {
  const detail: MemosAiChangedDetail = { deletedIds };
  window.dispatchEvent(
    new CustomEvent<MemosAiChangedDetail>(MEMOS_AI_CHANGED_EVENT, { detail }),
  );
  // 同时刷新侧栏徽标（侧栏订阅的是 MEMOS_CHANGED_EVENT）。
  notifyMemosChanged();
};
