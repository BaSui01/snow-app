import type { ChatCommand } from "./commands/types";

/**
 * 远控 Phase A：输入区能力快照注册表（Renderer 内部共享）。
 *
 * - ChatInputView 每次渲染后发布当前输入区的真实能力：`commands` 是
 *   createChatCommands 的真实产物（含真实 execute 回调与禁用状态），
 *   `actions` 是 useChatInputController 的真实 setter 链（模型 /
 *   API Profile / 思考强度 / Responses Fast Mode）。
 * - RemoteControlBridge 按 id / 名称复用这些真实对象执行远程操作，
 *   不复制指令注册表，也不重新实现任何 setter 逻辑。
 * - 安全边界：只发布展示层安全数据（模型 id、Profile 名称、思考强度值、
 *   Token 用量上限）。绝不发布 ApiConfigRecord、baseUrl、apiKey、
 *   configJson 或其他配置内容。
 */

export type SnowRemoteChatInputActions = {
  handleSelectModel: (modelId: string) => void | Promise<void>;
  handleSelectApiProfile: (profileName: string) => void | Promise<void>;
  handleSelectThinking: (value: string) => void | Promise<void>;
  handleToggleResponsesFastMode: () => void | Promise<void>;
};

export type SnowRemoteChatInputPublication = {
  /** 输入区当前绑定的会话；null = 尚未绑定真实会话（新会话输入区）。 */
  conversationId: string | null;
  isSubAgentConversation: boolean;
  isLoadingApiConfig: boolean;
  selectedModel: string;
  displayModel: string;
  modelIds: string[];
  selectedApiProfile: string;
  apiProfileNames: string[];
  requestMethod: string;
  /** 会话级思考强度覆盖；"" = 继承 Profile 默认。 */
  thinkingValue: string;
  thinkingOptions: Array<{ value: string; label: string }>;
  responsesFastModeEnabled: boolean;
  maxContextTokens: number | null;
  /** 真实 createChatCommands 产物：携带真实 execute 回调与禁用状态。 */
  commands: ChatCommand[];
  actions: SnowRemoteChatInputActions;
};

let publication: SnowRemoteChatInputPublication | null = null;

export const publishRemoteControlChatInput = (
  snapshot: SnowRemoteChatInputPublication,
): void => {
  publication = snapshot;
};

/** 仅当当前快照仍是自己的发布者时才清除，避免误清其他实例的新快照。 */
export const clearRemoteControlChatInput = (
  snapshot: SnowRemoteChatInputPublication,
): void => {
  if (publication === snapshot) {
    publication = null;
  }
};

export const readRemoteControlChatInput =
  (): SnowRemoteChatInputPublication | null => publication;
