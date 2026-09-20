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

export type RuntimeSnapshot = {
  activeDirectory: WorkspaceDirectoryRecord | null;
  conversation: RuntimeConversationState | null;
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
