import { useEffect, useMemo, useRef } from "react";

import type { WorkspaceDirectoryRecord } from "../../preload";
import { useChatConversationContext } from "../components/mainContent/chatMessages";
import { useTodoPanel } from "../components/mainContent/chatMessages/hooks/useTodoPanel";
import { isPendingSessionKey } from "../components/mainContent/chatMessages/utils/conversationTypes";
import {
  runtimeSnapshot,
  type RuntimeConversationState,
  type RuntimeStreamingSession,
} from "./runtimeSnapshot";

type PluginRuntimeBridgeProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
};

/** 把会话实时状态写入插件运行时快照（元数据 runtime / messages 域的数据源）。 */
export const PluginRuntimeBridge = ({
  activeDirectory,
}: PluginRuntimeBridgeProps): null => {
  const conversation = useChatConversationContext();
  const todoPanel = useTodoPanel(conversation.messages);

  useEffect(() => {
    runtimeSnapshot.patch({ activeDirectory: activeDirectory ?? null });
  }, [activeDirectory]);

  useEffect(() => {
    runtimeSnapshot.bump("conversationListRevision");
  }, [conversation.conversationListVersion]);

  const payload = useMemo<RuntimeConversationState>(() => {
    return {
      conversationId: conversation.activeConversationId ?? "",
      sessionKey: conversation.sessionViewKey ?? "",
      title: conversation.summary ?? "",
      directoryId: conversation.conversationDirectoryId ?? "",
      isStreaming: conversation.isStreaming,
      isPaused: conversation.isPaused,
      isAborting: conversation.isAborting,
      messageCount: conversation.messages.length,
      pendingMessageCount: conversation.pendingMessages.length,
      tokenUsage: conversation.tokenUsage ?? null,
      runTokenUsage: conversation.runTokenUsage ?? null,
      conversationTokenUsage: conversation.conversationTokenUsage ?? null,
      streamElapsedMs: conversation.streamElapsedMs,
      streamTtftMs: conversation.streamTtftMs,
      streamStartedAt: conversation.streamStartedAt,
      runTtftMs: conversation.runTtftMs,
      lastRunDurationMs: conversation.lastRunDurationMs,
      streamTokenCount: conversation.streamTokenCount,
      planMode: conversation.planMode,
      goalMode: conversation.goalMode,
      liteMode: conversation.liteMode,
      yoloMode: conversation.yoloMode,
      fileChangeStats: conversation.fileChangeStats ?? null,
      streamingConversationIds: Array.from(
        conversation.streamingConversationIds,
      ),
      completedConversationIds: Array.from(
        conversation.completedConversationIds,
      ),
      attentionRequiredConversationIds: Array.from(
        conversation.attentionRequiredConversationIds,
      ),
      subAgentSessions: conversation.subAgentSessionEvents ?? null,
      todos: {
        items: todoPanel.todos,
        sessionId: todoPanel.sessionId,
        totalCount: todoPanel.totalCount,
        completedCount: todoPanel.completedCount,
        incompleteCount: todoPanel.incompleteCount,
      },
    };
  }, [
    conversation.activeConversationId,
    conversation.sessionViewKey,
    conversation.summary,
    conversation.conversationDirectoryId,
    conversation.isStreaming,
    conversation.isPaused,
    conversation.isAborting,
    conversation.messages,
    conversation.pendingMessages,
    conversation.tokenUsage,
    conversation.runTokenUsage,
    conversation.conversationTokenUsage,
    conversation.streamElapsedMs,
    conversation.streamTtftMs,
    conversation.streamStartedAt,
    conversation.runTtftMs,
    conversation.lastRunDurationMs,
    conversation.streamTokenCount,
    conversation.planMode,
    conversation.goalMode,
    conversation.liteMode,
    conversation.yoloMode,
    conversation.fileChangeStats,
    conversation.streamingConversationIds,
    conversation.completedConversationIds,
    conversation.attentionRequiredConversationIds,
    conversation.subAgentSessionEvents,
    todoPanel.todos,
    todoPanel.sessionId,
    todoPanel.totalCount,
    todoPanel.completedCount,
    todoPanel.incompleteCount,
  ]);

  const streamingSessions = useMemo<RuntimeStreamingSession[]>(() => {
    const list: RuntimeStreamingSession[] = [];
    for (const [sessionKey, session] of Object.entries(conversation.sessions)) {
      if (!session.isStreaming && session.streamStartedAt <= 0) {
        continue;
      }
      list.push({
        sessionKey,
        conversationId: isPendingSessionKey(sessionKey) ? "" : sessionKey,
        title: session.summary,
        directoryId: session.directoryId ?? "",
        isStreaming: session.isStreaming,
        isPaused: session.isPaused,
        isAborting: session.isAborting,
        messageCount: session.messages.length,
        tokenCount: session.streamTokenCount,
        elapsedMs: session.streamElapsedMs,
        ttftMs: session.streamTtftMs,
        runTtftMs: session.runTtftMs,
        startedAt: session.streamStartedAt,
        lastRunDurationMs: session.lastRunDurationMs,
        runTokenUsage: session.runTokenUsage ?? null,
      });
    }
    list.sort((a, b) => b.startedAt - a.startedAt);
    return list;
  }, [conversation.sessions]);

  const signatureRef = useRef("");
  useEffect(() => {
    const signature = JSON.stringify({ payload, streamingSessions });
    if (signatureRef.current === signature) {
      return;
    }
    signatureRef.current = signature;
    runtimeSnapshot.patch({ conversation: payload, streamingSessions });
  }, [payload, streamingSessions]);

  return null;
};
