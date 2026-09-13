export type SnowRemoteToolCall = {
  name: string;
  interactionId: string;
  authorizationId?: string;
  status: "pending" | "running" | "completed" | "error";
  arguments?: string;
  result?: string;
  streamingStdout?: string;
  streamingStderr?: string;
  userQuestion?: {
    questionId: string;
    question: string;
    options: string[];
    status: "waiting" | "answered" | "cancelled";
    selectedOptions: string[];
    customAnswers: string[];
  };
};

export type SnowRemoteMessage = {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  contentBlocks?: SnowRemoteContentBlock[];
  thinking?: string;
  model?: string;
  isThinkingActive?: boolean;
  thinkingDurationMs?: number;
  toolCalls?: SnowRemoteToolCall[];
  timestamp: string;
  status?: "sending" | "sent" | "incomplete" | "error";
};

export type SnowRemoteContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; name: string; source: string }
  | { type: "file"; name: string; isDirectory: boolean }
  | {
      type: "reference";
      kind:
        | "commit"
        | "change"
        | "text-snippet"
        | "review"
        | "element"
        | "web"
        | "conversation"
        | "quote"
        | "skill";
      label: string;
      detail?: string;
    };

export type SnowRemoteConversation = {
  conversationId: string;
  title: string;
  summary: string;
  lastMessagePreview: string;
  status: string;
  directoryId: string;
  workspaceName: string;
  updatedAt: string;
};

export type SnowRemoteTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
};

export type SnowRemoteChatCommandInfo = {
  id: string;
  label: string;
  description: string;
  disabled: boolean;
};

export type SnowRemoteThinkingOption = {
  value: string;
  label: string;
};

export type SnowRemoteSkill = {
  id: string;
  name: string;
  description: string;
  location: "project" | "global";
  source: "snow" | "agents";
  allowedTools: string[];
  enabled: boolean;
};

export type SnowRemoteMcpServer = {
  id: string;
  name: string;
  source: "system" | "external" | "project";
  globalEnabled: boolean;
  enabled: boolean;
  available: boolean;
  tools: Array<{ name: string; description: string; enabled: boolean }>;
};

export type SnowRemoteChange = {
  path: string;
  kind: "create" | "edit" | "delete";
  agent: "main" | "sub";
  timestamp: number;
};

/**
 * 远控 Phase A：聊天输入区安全快照。
 * 数据来自 ChatInputView 发布的真实能力（见
 * mainContent/chatInput/remoteControlChatInputRegistry.ts）。
 * 只含展示层安全数据：不含 ApiConfigRecord、baseUrl、apiKey、configJson。
 */
export type SnowRemoteChatInputState = {
  /** 快照绑定的会话；null = 尚未绑定真实会话（新会话输入区）。 */
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
  thinkingOptions: SnowRemoteThinkingOption[];
  responsesFastModeEnabled: boolean;
  maxContextTokens: number | null;
  /** 真实 Token Usage（来自当前会话 session，未在 Renderer 重新计算）。 */
  tokenUsage: SnowRemoteTokenUsage | null;
  commands: SnowRemoteChatCommandInfo[];
};

/**
 * 可远程切换的代理行为模式（会话级）。
 * 与桌面 PlusMenu 的开关一一对应：Plan / Goal / YOLO 由手机端直接启停，
 * Worktree / Workflow 仍复用同一套真实 setter。
 * 安全边界：YOLO 只影响“普通 pending 工具授权自动批准”，
 * 敏感命令仍需桌面端独立确认；YOLO 与远控鉴权无关。
 */
export type SnowRemoteModeId =
  "plan" | "goal" | "worktree" | "workflow" | "yolo";

export type SnowRemoteModesState = {
  plan: boolean;
  goal: boolean;
  worktree: boolean;
  workflow: boolean;
  yolo: boolean;
  lite: boolean;
};

export type SnowRemoteState = {
  workspace: {
    directoryId: string;
    name: string;
    path: string;
  } | null;
  activeConversationId: string | null;
  isStreaming: boolean;
  isAborting: boolean;
  isCompacting: boolean;
  compactionError: string | null;
  attentionRequired: boolean;
  messages: SnowRemoteMessage[];
  pendingAuthorizations: SnowRemoteToolCall[];
  pendingQuestions: Array<{
    questionId: string;
    question: string;
    options: string[];
  }>;
  conversations: SnowRemoteConversation[];
  modes: SnowRemoteModesState;
  chatInput: SnowRemoteChatInputState | null;
};

export type SnowRemoteControlApi = {
  getState: () => Promise<SnowRemoteState>;
  getMessageImage: (
    messageId: string,
    imageIndex: number,
  ) => Promise<{ mimeType: string; base64: string }>;
  getSkills: () => Promise<{
    directoryId: string | null;
    skills: SnowRemoteSkill[];
  }>;
  setSkillEnabled: (
    skillId: string,
    enabled: boolean,
    expectedDirectoryId: string | null,
  ) => Promise<{ ok: true }>;
  getMcpServers: () => Promise<{
    directoryId: string;
    servers: SnowRemoteMcpServer[];
  }>;
  setMcpEnabled: (
    target: "server" | "tool",
    id: string,
    enabled: boolean,
    expectedDirectoryId: string,
  ) => Promise<{ ok: true }>;
  getChanges: (expectedConversationId?: string | null) => Promise<{
    conversationId: string | null;
    changes: SnowRemoteChange[];
  }>;
  getPermissions: () => Promise<{ directoryId: string | null; projectApprovedTools: string[]; globalApprovedTools: string[]; readonlyToolCount: number; yolo: boolean }>;
  getRole: () => Promise<{ directoryId: string | null; source: "project" | "ssh" | "global" | "none"; exists: boolean; characterCount: number; preview: string; editable: boolean; reason?: string }>;
  getSensitiveCommands: () => Promise<{ directoryId: string | null; commands: Array<{ commandId: string; pattern: string; description: string; enabled: boolean; scope: "global" | "project"; inherited: boolean; isPreset: boolean }> }>;
  getCodebase: () => Promise<{ directoryId: string | null; enabled: boolean; agentReview: boolean; reranking: boolean; indexed: boolean; totalFiles: number; totalChunks: number; totalSizeBytes: number; remote: boolean; reason?: string }>;
  getReview: () => Promise<{ directoryId: string | null; available: boolean; currentBranch: string; stagedCount: number; unstagedCount: number; untrackedCount: number; statusLimitHit: boolean; remote: boolean; reason?: string }>;
  send: (
    text: string,
    attachmentIds?: string[],
    requestId?: string,
    expectedContext?: {
      directoryId: string | null;
      conversationId: string | null;
    },
    pairingGeneration?: number,
  ) => Promise<{ ok: true }>;
  abort: () => Promise<{ ok: true }>;
  newChat: () => Promise<{ ok: true }>;
  /** 复用真实模式 setter 链；enabled=false 时关闭该模式。 */
  setMode: (mode: SnowRemoteModeId, enabled: boolean) => Promise<{ ok: true }>;
  select: (
    conversationId: string,
    directoryId?: string,
  ) => Promise<{ ok: true }>;
  approve: (authorizationId: string) => Promise<{ ok: true }>;
  reject: (authorizationId: string, reason?: string) => Promise<{ ok: true }>;
  answer: (
    questionId: string,
    selectedOptions: string[],
    customAnswers: string[],
  ) => Promise<{ ok: true }>;
  cancelQuestion: (questionId: string) => Promise<{ ok: true }>;
  /** 复用真实 handleSelectModel setter 链（会话级模型选择）。 */
  setModel: (modelId: string) => Promise<{ ok: true }>;
  /** 复用真实 handleSelectApiProfile setter 链（会话级 Profile 绑定）。 */
  setApiProfile: (profileName: string) => Promise<{ ok: true }>;
  /** 复用真实 handleSelectThinking setter 链；"" = 继承 Profile 默认。 */
  setThinking: (value: string) => Promise<{ ok: true }>;
  /**
   * 复用真实 handleToggleResponsesFastMode setter 链。
   * desired 为布尔时按目标状态幂等处理（已一致则不再翻转）。
   */
  toggleResponsesFastMode: (desired?: boolean) => Promise<{ ok: true }>;
  /** 按真实 createChatCommands 产物执行指令（含禁用状态校验）。 */
  runCommand: (id: string) => Promise<{ ok: true }>;
};
