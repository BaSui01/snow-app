import type { WorkspaceDirectoryRecord } from "../../preload";

/** 右侧面板 tab 的实时视图（插件元数据 runtime 域使用）。 */
export type RuntimePanelTab = {
  id: string;
  type: string;
  title: string;
  isActive: boolean;
  pluginId?: string;
  panelId?: string;
};

export type RuntimePanelState = {
  tabs: RuntimePanelTab[];
  activeTabId: string | null;
  isCollapsed: boolean;
  isFullscreen: boolean;
};

export type RuntimeConversationState = {
  conversationId: string;
  sessionKey: string;
  title: string;
  directoryId: string;
  isStreaming: boolean;
  isPaused: boolean;
  isAborting: boolean;
  messageCount: number;
  pendingMessageCount: number;
  tokenUsage: unknown;
  runTokenUsage: unknown;
  conversationTokenUsage: unknown;
  streamElapsedMs: number;
  streamTtftMs: number;
  streamStartedAt: number;
  runTtftMs: number;
  lastRunDurationMs: number;
  streamTokenCount: number;
  planMode: boolean;
  goalMode: boolean;
  liteMode: boolean;
  yoloMode: boolean;
  fileChangeStats: unknown;
  streamingConversationIds: string[];
  completedConversationIds: string[];
  attentionRequiredConversationIds: string[];
  subAgentSessions: unknown;
  todos: unknown;
};

export type RuntimeStreamingSession = {
  sessionKey: string;
  conversationId: string;
  title: string;
  directoryId: string;
  isStreaming: boolean;
  isPaused: boolean;
  isAborting: boolean;
  messageCount: number;
  tokenCount: number;
  elapsedMs: number;
  ttftMs: number;
  runTtftMs: number;
  startedAt: number;
  lastRunDurationMs: number;
  runTokenUsage: unknown;
};

/**
 * 输入区实时数据（插件运行时域）：与输入框右侧 Token 用量环（TokenUsageRing）
 * 同源。`tokenUsage` 来自 `RuntimeConversationState.tokenUsage`，这里补齐环的
 * 另外两个输入：当前生效的上下文窗口上限与 API 配置加载态。
 * 由 ChatInputView 在输入区挂载期间发布（同「流式指标条」数据由会话上下文
 * 发布的方式一致），值反映最后一次发布，且仅对 `conversationId` 对应的会话有效。
 */
export type RuntimeChatInputState = {
  /** 输入区当前绑定的会话；null = 新会话输入区（尚未绑定真实会话）。 */
  conversationId: string | null;
  /** 输入框原始内容（保留 @@file:...@@ 等标签标记；空串表示未输入）。 */
  inputText: string;
  /** 会话生效 API 档案的上下文窗口上限（null = 未知 / 未配置）。 */
  maxContextTokens: number | null;
  /**
   * API 配置是否仍在加载：为 true 时 `maxContextTokens` 未就绪，
   * 按 TokenUsageRing 的口径应显示占位环而不是把 total 当分母算比例。
   */
  isLoadingApiConfig: boolean;
};

export type RuntimeSnapshot = {
  activeDirectory: WorkspaceDirectoryRecord | null;
  conversation: RuntimeConversationState | null;
  chatInput: RuntimeChatInputState | null;
  streamingSessions: RuntimeStreamingSession[];
  panels: RuntimePanelState;
  activeSessionDirectoryIds: string[];
  workspaceRevision: number;
  memoriesRevision: number;
  scheduledTasksRevision: number;
  conversationListRevision: number;
  pluginsRevision: number;
};

const EMPTY_PANELS: RuntimePanelState = {
  tabs: [],
  activeTabId: null,
  isCollapsed: false,
  isFullscreen: false,
};

let snapshot: RuntimeSnapshot = {
  activeDirectory: null,
  conversation: null,
  chatInput: null,
  streamingSessions: [],
  panels: EMPTY_PANELS,
  activeSessionDirectoryIds: [],
  workspaceRevision: 0,
  memoriesRevision: 0,
  scheduledTasksRevision: 0,
  conversationListRevision: 0,
  pluginsRevision: 0,
};

const listeners = new Set<(next: RuntimeSnapshot) => void>();

/** 实时状态快照：渲染层各组件写入，插件元数据 runtime 域读取。 */
export const runtimeSnapshot = {
  get(): RuntimeSnapshot {
    return snapshot;
  },
  patch(partial: Partial<RuntimeSnapshot>): void {
    const next = { ...snapshot, ...partial };
    let changed = false;
    for (const key of Object.keys(partial) as (keyof RuntimeSnapshot)[]) {
      if (snapshot[key] !== next[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) {
      return;
    }
    snapshot = next;
    for (const listener of listeners) {
      listener(next);
    }
  },
  bump(
    key:
      | "workspaceRevision"
      | "memoriesRevision"
      | "scheduledTasksRevision"
      | "conversationListRevision"
      | "pluginsRevision",
  ): void {
    runtimeSnapshot.patch({
      [key]: snapshot[key] + 1,
    } as Partial<RuntimeSnapshot>);
  },
  subscribe(listener: (next: RuntimeSnapshot) => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
