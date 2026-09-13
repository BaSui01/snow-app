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
 * - 输入区卸载（如桌面切到设置页）时快照不清空而是保留：实时读取
 *   返回 null（setter 链已随组件销毁，变更 / 指令必须要求挂载中），
 *   展示读取回退到最后一次快照，手机端仍能显示模型 / Profile /
 *   思考强度，而不是退化成「未选择」。
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
  /** 会话生效的思考强度值（会话覆盖已解析，回退 Profile 默认）。 */
  effectiveThinkingValue: string;
  thinkingOptions: Array<{ value: string; label: string }>;
  responsesFastModeEnabled: boolean;
  maxContextTokens: number | null;
  /** 真实 createChatCommands 产物：携带真实 execute 回调与禁用状态。 */
  commands: ChatCommand[];
  actions: SnowRemoteChatInputActions;
};

let publication: SnowRemoteChatInputPublication | null = null;
/**
 * 输入区卸载后保留的最后一次快照（如桌面停留在设置页不在对话页）。
 * 仅用于远控状态展示：动作与指令仍要求输入区处于挂载状态，
 * 否则 setter 链已随组件销毁，执行不会生效。
 */
let lastSnapshot: SnowRemoteChatInputPublication | null = null;

export const publishRemoteControlChatInput = (
  snapshot: SnowRemoteChatInputPublication,
): void => {
  publication = snapshot;
  lastSnapshot = snapshot;
};

/** 仅当当前快照仍是自己的发布者时才清除，避免误清其他实例的新快照。 */
export const clearRemoteControlChatInput = (
  snapshot: SnowRemoteChatInputPublication,
): void => {
  if (publication === snapshot) {
    publication = null;
  }
};

/** 实时快照：仅输入区挂载时存在；模型 / Profile / 思考强度等变更与指令执行用。 */
export const readLiveRemoteControlChatInput =
  (): SnowRemoteChatInputPublication | null => publication;

/** 展示快照：输入区卸载时回退到最后一次快照（桌面停留在设置页等）。 */
export const readRemoteControlChatInput =
  (): SnowRemoteChatInputPublication | null => publication ?? lastSnapshot;
