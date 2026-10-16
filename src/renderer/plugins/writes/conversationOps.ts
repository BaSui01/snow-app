import { sendMessageToConversation } from "../../components/mainContent/chatMessages/hooks/conversationMessageBridge";
import { requestConversationActivation } from "../pluginEvents";
import { bumpRevision, callSnow } from "./helpers";

/** 插件写动作与 AI 内置工具共用的会话操作（同一实现，避免两套逻辑漂移）。 */

export type CreateConversationInput = {
  directoryId: string;
  title: string;
  text?: string;
  autoReply: boolean;
};

export type CreateConversationResult = {
  conversationId: string;
  directoryId: string;
  title: string;
  initialMessage: boolean;
  autoReply: boolean;
};

export const createConversationInDirectory = async (
  input: CreateConversationInput,
): Promise<CreateConversationResult> => {
  const directoryId = input.directoryId.trim();
  const title = input.title.trim();
  const initialText = input.text?.trim() || undefined;
  if (input.autoReply && !initialText) {
    throw new Error("Parameter 'autoReply' requires a non-blank 'text'");
  }
  const directories = await callSnow<Array<{ directoryId: string }>>(
    "listWorkspaceDirectories",
  );
  if (!directories.some((item) => item.directoryId.trim() === directoryId)) {
    throw new Error(`Unknown workspace directory '${directoryId}'`);
  }
  // 初始内容随创建同事务写入（仅入库不触发回合）；autoReply 时创建空会话后投递为正式回合。
  const conversationId = await callSnow<string>(
    "createChatConversation",
    directoryId,
    title,
    input.autoReply ? undefined : initialText,
  );
  bumpRevision("conversationListRevision");
  if (input.autoReply && initialText) {
    await sendMessageToConversation(conversationId, initialText);
  }
  return {
    conversationId,
    directoryId,
    title,
    initialMessage: !input.autoReply && Boolean(initialText),
    autoReply: input.autoReply && Boolean(initialText),
  };
};

export const activateConversationById = async (
  conversationId: string,
): Promise<{ conversationId: string; directoryId: string }> => {
  const id = conversationId.trim();
  const record = await callSnow<{ directoryId: string } | null>(
    "getChatConversation",
    id,
  );
  if (!record) {
    throw new Error(`Conversation not found: ${id}`);
  }
  const directoryId = record.directoryId.trim();
  const outcome = await requestConversationActivation({
    conversationId: id,
    directoryId,
  });
  if (outcome !== "opened") {
    throw new Error(`Conversation could not be activated (${outcome})`);
  }
  return { conversationId: id, directoryId };
};
