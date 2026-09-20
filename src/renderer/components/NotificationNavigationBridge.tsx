import { useEffect } from "react";
import type { WorkspaceDirectoryRecord } from "../../preload";
import { useConversationNavigation } from "../hooks/useConversationNavigation";
import type { MainContentView } from "./mainContent/types";

type NotificationNavigationBridgeProps = {
  activeDirectory: WorkspaceDirectoryRecord | null;
  onActiveDirectoryChange: (
    directory: WorkspaceDirectoryRecord | null
  ) => void;
  onSelectMainView: (view: MainContentView) => void;
};

/**
 * 系统通知点击激活会话时的跳转桥：复用共享的会话跳转流程（校验会话存在 →
 * 必要时激活其所属项目 → 切到 chat 视图 → 选中会话）。目标会话已删除等
 * 异常情况由共享 hook 统一告警并静默丢弃。
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

  return null;
};
