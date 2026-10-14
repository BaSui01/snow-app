import type {
  ChatConversationRecord,
  WorkspaceDirectoryRecord,
} from "../../../../preload";

/**
 * 在新窗口中直接开始一个新会话：独立窗口以新会话草稿 tab 打开（尚无会话 id），
 * 首次发送后该 tab 绑定为真实会话。目录为当前侧边栏所选项目。
 */
export const openNewChatInNewWindow = async (
  directory: WorkspaceDirectoryRecord | null,
  title: string,
): Promise<void> => {
  await window.snow.openDetachedPanelWindow({
    tab: {
      id: `conversation:new:${Date.now()}`,
      type: "conversation",
      title,
      data: { conversationId: "" },
    },
    activeDirectory: directory,
  });
};

/**
 * 在新窗口中打开空闲会话：会话作为独立窗口的会话 tab 打开，其子代理与 Workflow 节点
 * 随之展开为同一窗口的 tab。会话已归属某个独立窗口时直接聚焦该窗口。
 */
export const openConversationInNewWindow = async (
  conversation: ChatConversationRecord,
  title: string,
): Promise<void> => {
  const conversationId = conversation.conversationId;
  if (await window.snow.focusDetachedConversation(conversationId)) {
    return;
  }
  const directories = await window.snow.listWorkspaceDirectories();
  const activeDirectory: WorkspaceDirectoryRecord | null =
    directories.find(
      (directory) => directory.directoryId === conversation.directoryId,
    ) ?? null;
  await window.snow.openDetachedPanelWindow({
    tab: {
      id: `conversation:${conversationId}`,
      type: "conversation",
      title,
      data: { conversationId },
    },
    activeDirectory,
  });
};
