import { sendMessageToConversation } from "../../components/mainContent/chatMessages/hooks/conversationMessageBridge";
import { requestConversationActivation } from "../pluginEvents";
import { callSnow, commitConversationListChange } from "./helpers";

/** 插件写动作与 AI 内置工具共用的会话操作（同一实现，避免两套逻辑漂移）。 */

export type CreateConversationInput = {
  directoryId: string;
  title: string;
  text?: string;
  autoReply: boolean;
  /** 会话绑定的 API 档案；缺省时不绑定，回合沿用全局激活档案。 */
  apiProfile?: string;
};

export type CreateConversationResult = {
  conversationId: string;
  directoryId: string;
  title: string;
  initialMessage: boolean;
  autoReply: boolean;
  /** 已绑定的档案名；空串表示未绑定（跟随全局激活档案）。 */
  apiProfile: string;
};

/** 校验档案存在并返回规范化后的档案名（空串表示解除绑定，无需校验）。 */
const resolveExistingApiProfile = async (
  profileName: string,
): Promise<string> => {
  const normalized = profileName.trim();
  if (!normalized) {
    return "";
  }
  const configs =
    await callSnow<Array<{ profileName: string }>>("listApiConfigs");
  if (!configs.some((config) => config.profileName.trim() === normalized)) {
    throw new Error(`Unknown API profile '${normalized}'`);
  }
  return normalized;
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
  // 先校验档案再建会话，避免档案无效时留下一个未绑定的会话。
  const apiProfile = await resolveExistingApiProfile(input.apiProfile ?? "");
  // 初始内容随创建同事务写入（仅入库不触发回合）；autoReply 时创建空会话后投递为正式回合。
  const conversationId = await callSnow<string>(
    "createChatConversation",
    directoryId,
    title,
    input.autoReply ? undefined : initialText,
  );
  // 绑定须在首个回合发出前落库：回合按「请求显式档案 → 会话绑定 → 全局激活」解析。
  if (apiProfile) {
    await callSnow("updateConversationApiProfile", conversationId, apiProfile);
  }
  commitConversationListChange();
  if (input.autoReply && initialText) {
    await sendMessageToConversation(conversationId, initialText);
  }
  return {
    conversationId,
    directoryId,
    title,
    initialMessage: !input.autoReply && Boolean(initialText),
    autoReply: input.autoReply && Boolean(initialText),
    apiProfile,
  };
};

/**
 * 改绑既有主会话的 API 档案（空串解除绑定、回到跟随全局激活档案），
 * 从该会话的下一次请求起生效。
 */
export const setConversationApiProfile = async (
  conversationId: string,
  profileName: string,
): Promise<{ conversationId: string; apiProfile: string }> => {
  const id = conversationId.trim();
  const record = await callSnow<{
    conversationType: string;
    parentConversationId: string;
  } | null>("getChatConversation", id);
  if (!record) {
    throw new Error(`Conversation not found: ${id}`);
  }
  // 子代理 / WorkFlow 节点的档案是运行时快照，改绑只对主会话开放。
  if (
    record.parentConversationId ||
    record.conversationType === "sub_agent" ||
    record.conversationType === "workflow_node"
  ) {
    throw new Error(
      "Only top-level conversations can be re-bound to an API profile",
    );
  }
  const apiProfile = await resolveExistingApiProfile(profileName);
  await callSnow("updateConversationApiProfile", id, apiProfile);
  return { conversationId: id, apiProfile };
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
