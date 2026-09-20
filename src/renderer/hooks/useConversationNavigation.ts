import { useCallback, useEffect, useRef } from "react";
import type {
  ChatConversationRecord,
  WorkspaceDirectoryRecord,
} from "../../preload";
import { useChatConversationContext } from "../components/mainContent/chatMessages";
import type { MainContentView } from "../components/mainContent/types";

/** 会话跳转目标：会话 ID + 其所属项目（跨项目时自动切换项目）。 */
export type ConversationNavigationTarget = {
  conversationId: string;
  directoryId: string;
};

/**
 * 跳转结果：
 * - opened：目标会话存在，项目已切换（如需）并进入 chat 视图选中该会话；
 * - missing：目标会话已被删除（调用方可据此渲染降级态）；
 * - error：参数为空、校验/切换项目/打开失败，或已被更新的一次跳转取代。
 */
export type ConversationNavigationOutcome = "opened" | "missing" | "error";

type UseConversationNavigationOptions = {
  activeDirectory: WorkspaceDirectoryRecord | null;
  onActiveDirectoryChange?: (
    directory: WorkspaceDirectoryRecord | null,
  ) => void;
  onSelectMainView?: (view: MainContentView) => void;
};

const WARNING_PREFIX = "[ConversationNavigation]";

/**
 * 跳转到某个历史会话的共享流程：校验会话仍存在 → 必要时切换所属项目 →
 * 切到 chat 视图 → 选中会话加载历史。通知激活（NotificationNavigationBridge）
 * 与项目记忆「来自会话」徽章共用这条管道，避免逻辑重复。
 */
export const useConversationNavigation = ({
  activeDirectory,
  onActiveDirectoryChange,
  onSelectMainView,
}: UseConversationNavigationOptions): {
  navigateToConversation: (
    target: ConversationNavigationTarget,
  ) => Promise<ConversationNavigationOutcome>;
} => {
  const { handleSelectConversation } = useChatConversationContext();
  const activeDirectoryRef = useRef(activeDirectory);
  const onActiveDirectoryChangeRef = useRef(onActiveDirectoryChange);
  const onSelectMainViewRef = useRef(onSelectMainView);
  const handleSelectConversationRef = useRef(handleSelectConversation);
  const requestIdRef = useRef(0);
  const mountedRef = useRef(false);

  activeDirectoryRef.current = activeDirectory;
  onActiveDirectoryChangeRef.current = onActiveDirectoryChange;
  onSelectMainViewRef.current = onSelectMainView;
  handleSelectConversationRef.current = handleSelectConversation;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // 卸载后作废在途跳转：不再触发任何后续副作用
      requestIdRef.current += 1;
    };
  }, []);

  const navigateToConversation = useCallback(
    async (
      target: ConversationNavigationTarget,
    ): Promise<ConversationNavigationOutcome> => {
      const requestId = ++requestIdRef.current;
      const conversationId = target.conversationId.trim();
      const directoryId = target.directoryId.trim();
      const isCurrentRequest = (): boolean =>
        mountedRef.current && requestId === requestIdRef.current;

      if (!conversationId || !directoryId) {
        console.warn(
          `${WARNING_PREFIX} Ignored navigation because its conversationId or directoryId is empty.`,
        );
        return "error";
      }

      let conversation: ChatConversationRecord | null;
      try {
        conversation = await window.snow.getChatConversation(conversationId);
      } catch (error) {
        if (!isCurrentRequest()) {
          return "error";
        }
        console.warn(
          `${WARNING_PREFIX} Failed to validate the target conversation.`,
          { conversationId, directoryId, error },
        );
        return "error";
      }
      if (!isCurrentRequest()) {
        return "error";
      }

      if (!conversation) {
        console.warn(
          `${WARNING_PREFIX} Ignored navigation because the target conversation no longer exists.`,
          { conversationId, directoryId },
        );
        return "missing";
      }
      if (conversation.directoryId.trim() !== directoryId) {
        console.warn(
          `${WARNING_PREFIX} Ignored navigation because the conversation directory does not match the target.`,
          {
            conversationId,
            expectedDirectoryId: directoryId,
            actualDirectoryId: conversation.directoryId,
          },
        );
        return "error";
      }

      if (activeDirectoryRef.current?.directoryId.trim() !== directoryId) {
        let directories: WorkspaceDirectoryRecord[];
        try {
          directories =
            await window.snow.activateWorkspaceDirectory(directoryId);
        } catch (error) {
          if (!isCurrentRequest()) {
            return "error";
          }
          console.warn(
            `${WARNING_PREFIX} Failed to activate the target workspace directory.`,
            { conversationId, directoryId, error },
          );
          return "error";
        }
        if (!isCurrentRequest()) {
          return "error";
        }

        const nextDirectory =
          directories.find(
            (directory) =>
              directory.directoryId.trim() === directoryId && directory.isActive,
          ) ??
          directories.find(
            (directory) => directory.directoryId.trim() === directoryId,
          );
        if (!nextDirectory) {
          console.warn(
            `${WARNING_PREFIX} Ignored navigation because the target workspace directory is unavailable after activation.`,
            { conversationId, directoryId },
          );
          return "error";
        }

        activeDirectoryRef.current = nextDirectory;
        onActiveDirectoryChangeRef.current?.(nextDirectory);
      }

      if (!isCurrentRequest()) {
        return "error";
      }
      onSelectMainViewRef.current?.("chat");

      try {
        await handleSelectConversationRef.current(
          conversationId,
          conversation.summary || conversation.title,
          {
            inputTokens: conversation.inputTokens,
            outputTokens: conversation.outputTokens,
            cacheCreationInputTokens: conversation.cacheCreationInputTokens,
            cacheReadInputTokens: conversation.cacheReadInputTokens,
          },
          directoryId,
        );
      } catch (error) {
        if (!isCurrentRequest()) {
          return "error";
        }
        console.warn(
          `${WARNING_PREFIX} Failed to select the target conversation.`,
          { conversationId, directoryId, error },
        );
        return "error";
      }

      if (!isCurrentRequest()) {
        return "error";
      }
      return "opened";
    },
    [],
  );

  return { navigateToConversation };
};
