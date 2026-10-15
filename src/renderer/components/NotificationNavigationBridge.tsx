import { useEffect } from "react";
import type { WorkspaceDirectoryRecord } from "../../preload";
import { PLUGIN_ACTIVATE_CONVERSATION_EVENT } from "../plugins/pluginEvents";
import type { PluginActivateConversationDetail } from "../plugins/pluginEvents";
import { useConversationNavigation } from "../hooks/useConversationNavigation";
import type { MainContentView } from "./mainContent/types";

type NotificationNavigationBridgeProps = {
  activeDirectory: WorkspaceDirectoryRecord | null;
  onActiveDirectoryChange: (directory: WorkspaceDirectoryRecord | null) => void;
  onSelectMainView: (view: MainContentView) => void;
};

/**
 * 会话跳转桥：系统通知点击与插件 conversations.activate 共用同一条导航流程
 * （校验会话存在 → 必要时激活其所属项目 → 切到 chat 视图 → 选中会话）。
 * 目标会话已删除等异常情况由共享 hook 统一告警并静默丢弃。
 */
export const NotificationNavigationBridge = ({
  activeDirectory,
  onActiveDirectoryChange,
  onSelectMainView,
}: NotificationNavigationBridgeProps): null => {
  const { navigateToConversation } = useConversationNavigation({
    activeDirectory,
    onActiveDirectoryChange,
    onSelectMainView,
  });

  useEffect(() => {
    const dispose = window.snow.onNotificationActivated((target) => {
      void navigateToConversation({
        conversationId: target.conversationId,
        directoryId: target.directoryId,
      });
    });

    return dispose;
  }, [navigateToConversation]);

  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<PluginActivateConversationDetail>)
        .detail;
      detail.accepted = true;
      void navigateToConversation({
        conversationId: detail.conversationId,
        directoryId: detail.directoryId,
      }).then(detail.settle);
    };
    window.addEventListener(PLUGIN_ACTIVATE_CONVERSATION_EVENT, handler);
    return () => {
      window.removeEventListener(PLUGIN_ACTIVATE_CONVERSATION_EVENT, handler);
    };
  }, [navigateToConversation]);

  return null;
};
