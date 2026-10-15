/**
 * 新建会话请求事件：顶栏新建按钮、侧栏新建按钮与新建快捷键触发时广播。
 *
 * 侧栏（Sidebar）监听该事件，若当前显示的是设置内容则切回主侧栏，
 * 与设置页是否已打开无关（用户可能只点了页脚的「设置」而未选择设置项）。
 */
export const NEW_CHAT_REQUESTED_EVENT = "snow:new-chat-requested";

export const emitNewChatRequested = (): void => {
  window.dispatchEvent(new Event(NEW_CHAT_REQUESTED_EVENT));
};
