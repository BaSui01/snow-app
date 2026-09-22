import type { StreamInterruptionReason, StreamRecoveryOutcome } from "./api";

export type ChatConversationRecord = {
  conversationId: string;
  title: string;
  summary: string;
  lastMessagePreview: string;
  messageCount: number;
  model: string;
  apiProfileName: string;
  status: string;
  directoryId: string;
  forkedFromConversationId: string;
  forkMessageCount: number;
  conversationType: string;
  parentConversationId: string;
  subAgentId: string;
  subAgentName: string;
  subAgentStatus: string;
  subAgentError: string;
  createdAt: string;
  updatedAt: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalDurationMs: number;
  /** 最近一次 AI run 的累计用量与墙钟总耗时（run 摘要条回显用）。 */
  runInputTokens: number;
  runOutputTokens: number;
  runCacheCreationInputTokens: number;
  runCacheReadInputTokens: number;
  lastRunDurationMs: number;
  /** 会话累计 TTFT 总和（ms）与产生 TTFT 的请求数。 */
  runTtftSumMs: number;
  runRequestCount: number;
  emoji: string;
};

export type ChatConversationPage = {
  items: ChatConversationRecord[];
  total: number;
};

export type ConversationSearchResult = {
  conversationId: string;
  title: string;
  summary: string;
  lastMessagePreview: string;
  messageCount: number;
  model: string;
  status: string;
  directoryId: string;
  forkedFromConversationId: string;
  forkMessageCount: number;
  createdAt: string;
  updatedAt: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  matchedContent: string;
};

export type ChatMessageRecord = {
  id: string;
  role: string;
  content: string;
  thinking: string;
  /** Thinking-phase duration (ms) recorded for this assistant message. */
  thinkingDurationMs: number;
  /** Thinking-only token count recorded for this assistant message. */
  thinkingTokenCount: number;
  status: string;
  model: string;
  responseId: string;
  checkpointId: string;
  toolCallsJson: string;
  interruptionReason?: StreamInterruptionReason | null;
  recoveryOutcome?: StreamRecoveryOutcome | null;
  /** Token usage of the API request that produced this assistant message
   *  (zero for user/tool rows and rows persisted before schema v46). */
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  createdAt: string;
};

export type ChatMessagePage = {
  items: ChatMessageRecord[];
  total: number;
  hasMore: boolean;
  checkpointIds: string[];
};

export type UserMessageSummary = {
  id: string;
  content: string;
  createdAt: string;
  isContextCompaction: boolean;
};

/** 单个导入文件的处理进度。 */
export type ConversationImportProgress = {
  processed: number;
  total: number;
  fileName: string;
  success: boolean;
  error: string | null;
};

export type ImportedConversationSummary = {
  conversationId: string;
  title: string;
  messageCount: number;
};

export type ConversationImportFileResult = {
  filePath: string;
  success: boolean;
  error: string | null;
  conversations: ImportedConversationSummary[];
};

export type ConversationImportSummary = {
  total: number;
  importedCount: number;
  failedCount: number;
  results: ConversationImportFileResult[];
};
