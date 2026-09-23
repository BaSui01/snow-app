/**
 * 备忘录数据变更广播。
 *
 * 备忘录页面在增删改后派发该事件，侧栏徽标据此刷新待办数量；
 * 独立成模块是为了让侧栏订阅事件时不必静态引入备忘录页面（懒加载分包）。
 */
export const MEMOS_CHANGED_EVENT = "memo:changed";

export const notifyMemosChanged = (): void => {
  window.dispatchEvent(new CustomEvent(MEMOS_CHANGED_EVENT));
};
