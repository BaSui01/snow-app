import type { ConversationNavigationOutcome } from "../hooks/useConversationNavigation";

export const PLUGIN_INSERT_INPUT_TEXT_EVENT = "snow:plugin-insert-input-text";

export const PLUGIN_SEND_INPUT_MESSAGE_EVENT = "snow:plugin-send-input-message";

export const PLUGIN_ACTIVATE_CONVERSATION_EVENT =
  "snow:plugin-activate-conversation";

export const PLUGIN_OPEN_SETTINGS_EVENT = "app-control:open-settings";

export type PluginActivateConversationDetail = {
  conversationId: string;
  directoryId: string;
  /** 由监听方在同步回调中置为 true，表示导航桥已接收请求。 */
  accepted: boolean;
  settle: (outcome: ConversationNavigationOutcome) => void;
};

/**
 * 请求切换到指定会话（跨项目时自动切换项目）。导航桥未挂载时没有监听方，
 * 直接拒绝而不是悬挂等待。
 */
export const requestConversationActivation = (target: {
  conversationId: string;
  directoryId: string;
}): Promise<ConversationNavigationOutcome> =>
  new Promise((resolve, reject) => {
    const detail: PluginActivateConversationDetail = {
      ...target,
      accepted: false,
      settle: resolve,
    };
    window.dispatchEvent(
      new CustomEvent(PLUGIN_ACTIVATE_CONVERSATION_EVENT, { detail }),
    );
    if (!detail.accepted) {
      reject(new Error("Conversation navigation is not ready"));
    }
  });
