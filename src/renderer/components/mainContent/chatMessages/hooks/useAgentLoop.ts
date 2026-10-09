import { useCallback } from "react";
import {
  startAgentTask,
  bindAgentTask,
  recordTaskResponse,
  finishAgentTask,
} from "./taskHistory";
import { useI18n } from "../../../../i18n";
import type { ChatInputSendOptions } from "../../chatInput/types";
import { summarizeContentAsPlainText } from "../../chatInput/fileTagUtils";
import type {
  ChatConversationMessage,
  ConversationContextValue,
  ConversationSessionRef,
  ToolAuthorizationDecision,
  ToolCallInfo,
} from "../utils/conversationTypes";
import {
  PENDING_SESSION_KEY,
  isPendingSessionKey,
  rejectionKeepsAiFlow,
} from "../utils/conversationTypes";
import {
  createMessageId,
  deleteCheckpoints,
  directoryIdToPath,
  formatMessageTime,
  formatToolResultsContent,
  getErrorMessage,
  parseToolCalls,
  resolveConversationWorkspacePath,
  updateFirstMatchingToolCall,
} from "../utils/conversationHelpers";
import { resolveResponseDisposition } from "../utils/responseDisposition";
import { settleInterruptedMessages } from "../utils/messageSettlement";
import {
  demotePendingSteering,
  hasPendingSteering,
  refreshPendingMessages,
  takeNextQueuedMessage,
  takePendingSteering,
} from "../utils/pendingInputs";
import {
  appendHookExecutionToMessage,
  buildHookExecRecord,
  resolveHookOutcome,
  runHook,
  toNonBlockingRecord,
} from "./hookOutcome";
import {
  accumulateConversationRunStats,
  accumulateRunTokenUsage,
  createAwaitHookDecision,
  createIsRunCancelled,
  createStreamChunkHandler,
  createStreamIdHandler,
  remapPersistedUserMessageIds,
  resetIterationStreamMetrics,
  resetRunStreamMetrics,
} from "./agentLoopHelpers";
import {
  createSubAgentActivation,
  createSubAgentMainToolExecutor,
} from "./subAgentActivation";
import {
  createWorkflowRunner,
  executeWorkflowGenerate as executeWorkflowGenerateTool,
  getWorkflowRunner,
  parseWorkflowGraph,
  registerWorkflowRunner,
} from "../workflow/workflowRunner";
import { createToolExecutor } from "./toolExecution";
import { ReadonlyCallGuard } from "./readonlyCallGuard";
import { resolveGoalContinuation } from "./goalContinuation";

type CapturedChatInputSendOptions = ChatInputSendOptions;

const captureChatInputSendOptions = (
  options: ChatInputSendOptions,
): CapturedChatInputSendOptions => {
  const source = options as CapturedChatInputSendOptions;
  const runtimeOverride = source.conversationRuntimeConfigOverride;
  return {
    ...source,
    ...(runtimeOverride
      ? {
          conversationRuntimeConfigOverride: {
            thinkingStrength: runtimeOverride.thinkingStrength ?? null,
            responsesFastMode: runtimeOverride.responsesFastMode ?? null,
          },
        }
      : {}),
  };
};

/**
 * 发送时统一落库：把本次发送携带的选择（渠道绑定、思考强度/Fast Mode 覆盖、
 * 四种模式）写入会话记录。切换这些选择本身不再写库，只在真正发起会话时
 * 持久化一次；内存态（session ref / 输入区状态）始终是运行时权威，这里的
 * 写入只用于重启后恢复，以及标题摘要等后端内部请求读取持久绑定。
 */
const persistConversationSelection = async (
  conversationId: string,
  options: CapturedChatInputSendOptions,
  sessionRef?: ConversationSessionRef,
): Promise<void> => {
  const recordFailure = (error: unknown): void => {
    void window.snow.writeLog("WARN", {
      module: "chat/useAgentLoop",
      func: "persistConversationSelection",
      message: "Failed to persist conversation selection",
      context: JSON.stringify({ conversationId }),
      error: getErrorMessage(error),
    });
  };

  try {
    if (options.apiProfile) {
      await window.snow.updateConversationApiProfile(
        conversationId,
        options.apiProfile,
      );
    }
    const runtimeOverride = options.conversationRuntimeConfigOverride;
    if (runtimeOverride) {
      await window.snow.setConversationRuntimeConfig(
        conversationId,
        runtimeOverride.thinkingStrength,
        runtimeOverride.responsesFastMode,
      );
    }
    if (sessionRef) {
      await window.snow.setConversationModes(
        conversationId,
        sessionRef.planMode,
        sessionRef.goalMode,
        sessionRef.worktreeMode,
        sessionRef.workflowMode,
        sessionRef.goalModeTokenBudget,
      );
      if (sessionRef.worktreeId) {
        await window.snow.setConversationWorktree(
          conversationId,
          sessionRef.worktreeId,
        );
      }
    }
  } catch (error) {
    recordFailure(error);
  }
};

export type UseAgentLoopParams = {
  ctx: ConversationContextValue;
  requestToolAuthorizations: (
    toolCalls: ToolCallInfo[],
    conversationId: string,
    projectId?: string,
  ) => Promise<ToolAuthorizationDecision[]>;
  rejectToolAuthorizations: (sessionKey?: string) => void;
  rejectPendingUserQuestions: (sessionKey?: string) => void;
};

/**
 * Agent 循环逻辑：处理用户消息发送、子代理激活、主 agent 循环和检查点初始化。
 * 这些函数深度嵌套，共享闭包变量，必须放在同一个文件中。
 */
export const useAgentLoop = (params: UseAgentLoopParams) => {
  const { ctx, requestToolAuthorizations } = params;

  // Plan approval is isolated per main-conversation session so parallel chats
  // cannot borrow each other's approval. The key set lives on ctx
  // (planApprovedSessionKeysRef) so it is cleared only when Plan Mode is
  // genuinely turned off (user toggle / Goal Mode mutual exclusion / new
  // chat). Switching conversations restores the target session's mode via
  // setPlanModeState directly and must NOT clear it — otherwise an approved
  // plan is lost when the user navigates away and back.
  const planApprovedSessionKeysRef = ctx.planApprovedSessionKeysRef;
  const { t } = useI18n();

  const handleSendMessage = useCallback(
    (message: string, options: ChatInputSendOptions) => {
      const trimmed = message.trim();
      if (!trimmed) {
        return;
      }

      let capturedOptions = captureChatInputSendOptions(options);
      // 程序化发送（pending 队列自动冲刷）携带目标会话 key：消息必须发到
      // 队列所属的会话，而不是用户当前停留的视图会话。
      const sessionKey =
        options.targetSessionKey ??
        ctx.activeSessionKeyRef.current ??
        PENDING_SESSION_KEY;
      const existingRef = ctx.sessionsRefData.current.get(sessionKey);
      // A sub-agent conversation becomes read-only as soon as its run ends.
      // The input box is hidden in the UI; this guard closes the remaining
      // programmatic paths (a last-moment send racing the status event, or a
      // finishing parent loop flushing its pending queue while the user is
      // viewing the terminated sub-agent conversation).
      if (existingRef?.subAgentTerminated) {
        return;
      }
      if (existingRef?.isSending) {
        const running = existingRef.activeSendOptions;
        // A steer cannot change the running provider/model/settings or turn kind.
        // Manual compaction has no active task snapshot and only accepts follow-ups.
        const canSteer =
          capturedOptions.deliveryMode === "steer" &&
          !!running &&
          !existingRef.isAbortRequested &&
          capturedOptions.kind !== "review" &&
          (!capturedOptions.apiProfile ||
            capturedOptions.apiProfile === running.apiProfile) &&
          (!capturedOptions.model || capturedOptions.model === running.model) &&
          (capturedOptions.thinkingStrength === undefined ||
            capturedOptions.thinkingStrength === running.thinkingStrength) &&
          (capturedOptions.responsesFastMode == null ||
            capturedOptions.responsesFastMode === running.responsesFastMode);
        const queue = ctx.pendingQueueRef.current.get(sessionKey) ?? [];
        queue.push({
          text: trimmed,
          options: {
            ...capturedOptions,
            deliveryMode: canSteer ? "steer" : "queue",
          },
          ...(canSteer ? { steeringRunId: existingRef.runId } : {}),
        });
        ctx.pendingQueueRef.current.set(sessionKey, queue);
        refreshPendingMessages(ctx, sessionKey);
        return;
      }

      // 程序化发送（targetSessionKey）是既有会话的后续消息，永远不是
      // 首条消息：不参与占位记录/首条 summary/回滚状态合并等首条逻辑。
      const isFirstMessage =
        ctx.activeConversationIdRef.current === undefined &&
        !options.targetSessionKey;
      const targetPendingWorktree =
        ctx.pendingWorktreeIdRef.current || existingRef?.worktreeId;
      if (
        isFirstMessage &&
        (existingRef?.worktreeMode ?? ctx.worktreeModeRef.current) &&
        !targetPendingWorktree
      ) {
        window.alert(t("git.worktreesPendingSessionHint"));
        return;
      }
      const rollbackState = isFirstMessage ? ctx.rollbackNewChatState : null;
      if (rollbackState) {
        capturedOptions = {
          ...capturedOptions,
          model: capturedOptions.model || rollbackState.model || undefined,
          apiProfile:
            capturedOptions.apiProfile || rollbackState.apiProfile || undefined,
          thinkingStrength:
            capturedOptions.thinkingStrength ??
            rollbackState.thinkingStrength ??
            undefined,
          responsesFastMode:
            capturedOptions.responsesFastMode ??
            rollbackState.responsesFastMode,
          conversationRuntimeConfigOverride:
            capturedOptions.conversationRuntimeConfigOverride ?? {
              thinkingStrength: rollbackState.thinkingStrength,
              responsesFastMode: rollbackState.responsesFastMode,
            },
        };
      }
      // Consume the one-shot target project set by handleNewChat(directoryId)
      // (e.g. a scheduled task firing for its bound project) so the new
      // PENDING session lands in the task's project instead of the currently
      // active one. Cleared immediately — it applies to this send only.
      const pendingDirId = ctx.pendingDirectoryIdRef.current;
      ctx.pendingDirectoryIdRef.current = undefined;
      const sessionDirId =
        existingRef?.directoryId ?? pendingDirId ?? ctx.directoryId;
      // One-shot scheduled-task name (set by buildFromContent) consumed here so
      // the new session can show a "triggered by scheduled task" banner in the
      // message list. Cleared immediately — it applies to this send only.
      const pendingTaskName = ctx.pendingTaskNameRef.current;
      ctx.pendingTaskNameRef.current = undefined;

      // Reset only this session's approval for the new user task. Other
      // conversations may still be executing their independently approved plan.
      planApprovedSessionKeysRef.current.delete(sessionKey);

      // Sending a new message cancels any prior "new chat" intent — the
      // user is now interacting with this session, so the UI should follow
      // it normally (including auto-switching when the pending session
      // migrates to a real conversation id). 程序化发送（targetSessionKey）
      // 不是用户在目标会话交互：不得重置 newChatRequested，否则会把用户
      // 从当前停留的新建会话视图推进一个没有 session 的空槽位（空问候）。
      if (!options.targetSessionKey) {
        ctx.setNewChatRequested(false);
      }

      ctx.ensureSession(sessionKey, sessionDirId);
      const sessionRef = ctx.sessionsRefData.current.get(sessionKey);
      if (sessionRef && targetPendingWorktree) {
        sessionRef.worktreeId = targetPendingWorktree;
      }
      // 已有会话：发送时把当前选择统一落库（渠道绑定/思考强度/Fast Mode/模式）。
      // 切换这些选择本身不再写库；pending 会话在迁移拿到真实 id 后再写。
      if (!isPendingSessionKey(sessionKey)) {
        persistConversationSelection(sessionKey, capturedOptions, sessionRef);
      }
      // Capture the current runId so runAgentLoop can detect when a newer
      // send or abort has superseded this invocation.
      const currentRunId = (sessionRef?.runId ?? 0) + 1;
      const taskHistory = startAgentTask(sessionKey);
      const finalizeTaskHistory = async (): Promise<void> => {
        try {
          await finishAgentTask(taskHistory, finalSessionKey);
        } catch {
          console.warn("Task file history could not be persisted");
        }
      };
      if (sessionRef) {
        sessionRef.isSending = true;
        sessionRef.isAbortRequested = false;
        sessionRef.runId = currentRunId;
        sessionRef.activeSendOptions = capturedOptions;
        sessionRef.activeTaskMessages = [{ role: "user", content: trimmed }];
      }

      // 宠物联动：本次 run 的唯一回合 id —— start/end 按 id 一一核销。
      // 多会话并行、中止、被新发送顶替的 run 各自核销自己的回合，
      // 不会互相污染计数（旧实现的匿名计数在这些路径上会永久漂移）。
      const petTurnId = `turn-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 10)}`;
      window.snow.notifyPetTurnStarted(
        petTurnId,
        capturedOptions.kind === "review" ? "review" : "chat",
      );

      // Reset pause state for a fresh send — the previous run may have
      // been paused and aborted without cleaning up the controller.
      ctx.updateSessionField(sessionKey, "isPaused", false);
      ctx.pauseControllerRef.current.delete(sessionKey);

      const userMessage: ChatConversationMessage = {
        id: createMessageId("user"),
        role: "user",
        content: trimmed,
        timestamp: formatMessageTime(),
        status: "sent",
      };
      const assistantMessageId = createMessageId("assistant");
      const pendingAssistantMessage: ChatConversationMessage = {
        id: assistantMessageId,
        role: "assistant",
        content: "",
        timestamp: formatMessageTime(),
        status: "sending",
        model: capturedOptions.model,
      };

      ctx.updateSessionField(sessionKey, "isStreaming", true);
      // Stamp the session with the scheduled-task trigger info (if any) so the
      // message list can render a "triggered by task" banner. Only on the
      // first message — a task firing always starts a brand-new conversation.
      if (isFirstMessage && pendingTaskName) {
        ctx.updateSessionField(sessionKey, "triggeredByTask", {
          name: pendingTaskName,
          triggeredAt: new Date().toISOString(),
        });
      }
      // Reset per-run and per-iteration probes before the first model request.
      resetRunStreamMetrics(ctx, sessionKey);

      const runStartedAt = Date.now();
      ctx.updateSessionField(sessionKey, "streamStartedAt", runStartedAt);
      ctx.addStreamingId(sessionKey);
      ctx.updateSessionMessages(sessionKey, (currentMessages) => [
        ...currentMessages,
        userMessage,
        pendingAssistantMessage,
      ]);

      // First message: immediately show a placeholder in the sidebar list
      // so the user sees the new conversation without waiting for AI response.
      if (isFirstMessage) {
        const nowIso = new Date().toISOString();
        // chip 标签（如自定义指令 @@command:...@@）折叠为可读纯文本，
        // 占位记录不把编码串显示到侧边栏。
        const titleSource = summarizeContentAsPlainText(trimmed) || trimmed;
        const preview =
          titleSource.length > 50
            ? `${titleSource.slice(0, 50)}...`
            : titleSource;
        ctx.setUpsertedConversation({
          record: {
            // 占位记录使用本会话自己的 pending 槽位 key：点击侧边栏占位
            // 项可回到该会话视图（迁移时自动切换到真实 conversationId）。
            conversationId: sessionKey,
            title: titleSource,
            summary: "",
            lastMessagePreview: preview,
            messageCount: 1,
            model: capturedOptions.model ?? "",
            apiProfileName: capturedOptions.apiProfile ?? "",
            status: "active",
            directoryId: sessionDirId ?? "",
            forkedFromConversationId: "",
            forkMessageCount: 0,
            conversationType: "main",
            parentConversationId: "",
            subAgentId: "",
            subAgentName: "",
            subAgentStatus: "",
            subAgentError: "",
            createdAt: nowIso,
            updatedAt: nowIso,
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            totalDurationMs: 0,
            runInputTokens: 0,
            runOutputTokens: 0,
            runCacheCreationInputTokens: 0,
            runCacheReadInputTokens: 0,
            lastRunDurationMs: 0,
            runTtftSumMs: 0,
            runRequestCount: 0,
            emoji: "",
          },
          timestamp: Date.now(),
        });
      } else {
        // Follow-up message: immediately bump the conversation to the top
        // of the sidebar list without waiting for AI response.
        const followUpId = sessionKey;
        void window.snow
          .getChatConversation(followUpId)
          .then((conv) => {
            if (conv) {
              ctx.setUpsertedConversation({
                record: { ...conv, updatedAt: new Date().toISOString() },
                timestamp: Date.now(),
              });
            }
          })
          .catch(() => {
            // Sidebar refresh failure should not block the conversation
          });
      }

      let finalSessionKey = sessionKey;
      let summaryTriggered = false;

      const isRunCancelled = createIsRunCancelled(ctx, currentRunId);

      const createFlushCheckpoint = async (
        flushKey: string,
        flushDirPath: string | undefined,
      ): Promise<string | undefined> => {
        if (!flushDirPath) {
          return undefined;
        }
        try {
          const flushCheckpointId =
            await window.snow.createCheckpoint(flushDirPath);
          if (isRunCancelled(flushKey)) {
            if (flushCheckpointId) {
              deleteCheckpoints([flushCheckpointId]);
            }
            return undefined;
          }
          const flushRef = ctx.sessionsRefData.current.get(flushKey);
          if (flushRef) {
            // 仅用于临时清理，不代表消息顺序。
            flushRef.checkpointIds = [
              ...flushRef.checkpointIds,
              flushCheckpointId,
            ];
          }
          if (!ctx.sessionsRef.current[flushKey]?.baselineCheckpointId) {
            ctx.updateSessionField(
              flushKey,
              "baselineCheckpointId",
              flushCheckpointId,
            );
          }
          return flushCheckpointId;
        } catch {
          // Best effort — continue without a checkpoint
          return undefined;
        }
      };

      const awaitHookDecision = createAwaitHookDecision(ctx);

      // Only steering inputs enter this run. Ordinary queue entries remain untouched
      // until the outer run settles. Snapshot first, then atomically select inputs
      // after the await so withdrawal cannot terminate normal tool continuation.
      const consumeSteering = async (
        key: string,
        conversationId: string | undefined,
      ): Promise<{
        messages: { role: "user"; content: string }[];
        checkpointId?: string;
      }> => {
        if (!hasPendingSteering(ctx, key) || isRunCancelled(key))
          return { messages: [] };
        const steeringRef = ctx.sessionsRefData.current.get(key);
        const dirPath = await resolveConversationWorkspacePath(
          conversationId ?? "",
          sessionDirId,
          directoryIdToPath(sessionDirId) ?? ctx.directoryPath,
          steeringRef?.worktreeMode ?? false,
          steeringRef?.worktreeId,
        );
        const steeringCheckpoint = await createFlushCheckpoint(key, dirPath);
        if (isRunCancelled(key)) return { messages: [] };
        const inputs = takePendingSteering(ctx, key);
        if (!inputs.length) {
          if (steeringCheckpoint) deleteCheckpoints([steeringCheckpoint]);
          return { messages: [] };
        }
        const messages = inputs.map((item) => ({
          role: "user" as const,
          content: item.text,
        }));
        if (steeringRef) {
          steeringRef.activeTaskMessages = [
            ...(steeringRef.activeTaskMessages ?? []),
            ...messages,
          ];
          // New constraints cannot inherit authorization for a broader changed plan.
          if (steeringRef.planMode)
            planApprovedSessionKeysRef.current.delete(key);
        }
        ctx.updateSessionMessages(key, (currentMessages) => [
          ...currentMessages,
          ...inputs.map((item) => ({
            id: createMessageId("user"),
            role: "user" as const,
            content: item.text,
            timestamp: formatMessageTime(),
            status: "sent" as const,
            checkpointId: steeringCheckpoint,
          })),
        ]);
        return { messages, checkpointId: steeringCheckpoint };
      };

      const workspacePath =
        directoryIdToPath(sessionDirId) ?? ctx.directoryPath;
      // ReadonlyCallGuard: 统一抽象只读工具调用保护与物理/Git 状态感知
      const readonlyGuard = new ReadonlyCallGuard({
        workspacePath,
      });
      let readonlyToolNamesPromise: Promise<Set<string>> | undefined;
      const getReadonlyToolNames = (): Promise<Set<string>> => {
        readonlyToolNamesPromise ??= window.snow
          .listReadonlyTools()
          .then((names) => new Set(names))
          .catch(() => new Set<string>());
        return readonlyToolNamesPromise;
      };

      const executeSubAgentActivation = createSubAgentActivation({
        ctx,
        requestToolAuthorizations,
        parentApiProfile: capturedOptions.apiProfile,
        parentModel: capturedOptions.model,
        parentResponsesFastMode: capturedOptions.responsesFastMode,
        planApprovedSessionKeysRef,
      });
      // 阻塞式工作流工具：工具调用挂起直到用户在 UI 上确认执行或输入修改
      // 意见（与 sub-agents-activate 同语义）。注册时创建执行器：闭包持有
      // 本轮新鲜的 ctx 与工具授权入口，供 WorkflowToolCall 执行按钮取用
      // （主 loop await 挂起的工具结果，闭包在执行期间始终存活）。
      const executeWorkflowGenerate = (
        argsJson: string,
        parentConversationId: string,
        dirId: string,
        toolCallInteractionId: string,
      ): Promise<string> => {
        registerWorkflowRunner(
          parentConversationId,
          toolCallInteractionId,
          createWorkflowRunner({
            ctx,
            requestToolAuthorizations,
            planApprovedSessionKeysRef,
            executeSubAgentActivation,
            executeSubAgentMainTool,
          }),
        );
        // 通知系统：与 askUserQuestion 同语义——工具挂起等待用户操作时
        // 触发系统通知（窗口聚焦时主进程 notificationManager 自动跳过）。
        // 仅对真正挂起的流程通知：空节点图会立即结算失败，无需打扰用户。
        const workflowGraph = parseWorkflowGraph(argsJson);
        if (workflowGraph.nodes.length > 0) {
          ctx.notifyUserInteractionRequired({
            conversationId: parentConversationId,
            directoryId: dirId,
            reason:
              workflowGraph.title || t("notification.workflow.defaultReason"),
          });
        }
        return executeWorkflowGenerateTool(
          argsJson,
          parentConversationId,
          dirId,
          toolCallInteractionId,
        );
      };
      // 失败节点续跑（workflow-resume）：主流程询问用户并获同意后调用。
      // 续跑发生在失败结果结算后的新一轮 loop，注册的 runner 闭包已过期，
      // 这里用本轮新鲜的 ctx 重新注册 runner 再执行 resumeWorkflow（失败
      // 上下文存在模块级 failedFlows，跨 runner 实例共享）。
      const executeWorkflowResume = (
        argsJson: string,
        parentConversationId: string,
        toolCallInteractionId: string,
      ): Promise<string> => {
        let flowId = "";
        let continuePrompt = "";
        try {
          const parsed = JSON.parse(argsJson || "{}") as {
            flowId?: unknown;
            continuePrompt?: unknown;
          };
          flowId = typeof parsed.flowId === "string" ? parsed.flowId : "";
          continuePrompt =
            typeof parsed.continuePrompt === "string"
              ? parsed.continuePrompt
              : "";
        } catch {
          // 参数非 JSON：flowId 保持空串，走结构化错误分支
        }
        if (!flowId) {
          return Promise.resolve(
            JSON.stringify({
              success: false,
              error:
                "workflow-resume requires flowId (the failedNode.flowId from the failed workflow result)",
            }),
          );
        }
        registerWorkflowRunner(
          parentConversationId,
          flowId,
          createWorkflowRunner({
            ctx,
            requestToolAuthorizations,
            planApprovedSessionKeysRef,
            executeSubAgentActivation,
            executeSubAgentMainTool,
          }),
        );
        const runner = getWorkflowRunner(parentConversationId, flowId);
        if (!runner) {
          return Promise.resolve(
            JSON.stringify({
              success: false,
              error:
                "Workflow resume executor is no longer available; ask the user to press Continue on the workflow card or re-run the workflow.",
            }),
          );
        }
        return runner
          .resumeWorkflow({
            parentConversationId,
            interactionId: flowId,
            originInteractionId: toolCallInteractionId,
            continuePrompt,
          })
          .then((outcome) =>
            JSON.stringify({
              success: outcome.success,
              summary: outcome.summary,
              ...(outcome.totalTokens
                ? { totalTokens: outcome.totalTokens }
                : {}),
              ...(outcome.error ? { error: outcome.error } : {}),
              // 再次失败时保持同样的续跑指引，主流程可重复询问用户。
              ...(outcome.failedNode
                ? {
                    failedNode: outcome.failedNode,
                    resumable: outcome.resumable,
                    resumeInstruction:
                      "The node failed again after resuming. Tell the user, ask whether to resume once more (call workflow-resume again, optionally with an adjusted continuePrompt) or stop, and follow the user's decision.",
                  }
                : {}),
            }),
          );
      };
      // 主会话子代理管理工具（listSubAgents / continue）执行器：会话隔离
      // 在内部强制，只允许操作当前会话自己的子代理；continue 在内存无
      // 恢复器时（应用重启后）自动从 DB 重建。
      const executeSubAgentMainTool = createSubAgentMainToolExecutor(ctx, {
        requestToolAuthorizations,
        planApprovedSessionKeysRef,
        parentResponsesFastMode: capturedOptions.responsesFastMode,
      });

      const runAgentLoop = async (
        currentAssistantMessageId: string,
        requestMessages: {
          role: "user" | "assistant" | "system" | "developer" | "tool";
          content: string;
          toolResultsJson?: string;
        }[],
        currentConversationId: string | undefined,
        checkpointId?: string,
        // Internal auto-compaction resume: Rust loads the persisted handoff and
        // skips only requestMessages[0] (the placeholder). Following protected
        // task instructions and consumed steers are injected and persisted.
        resumeAfterCompaction?: boolean,
        // A one-shot recovery continuation preserves history and tool results,
        // but asks every provider to omit its outbound tools array.
        disableTools = false,
        // Request-local system-level recovery instruction. This deliberately
        // does not become a conversation message or persisted user content.
        internalRecoveryPrompt?: string,
      ): Promise<void> => {
        taskHistory.endResponseId = "";
        const iterSessionKey = currentConversationId ?? sessionKey;
        let effectiveKey = iterSessionKey;

        if (resumeAfterCompaction) {
          readonlyGuard.clearAll();
        }

        if (isRunCancelled(effectiveKey)) {
          // 取消可能落在「消息已创建、请求尚未发出」的间隙（steering / 队列
          // 新回合刚挂上一条 sending 消息）：同样需要幂等收尾，否则该消息会
          // 一直停在发送中。
          ctx.updateSessionMessages(effectiveKey, settleInterruptedMessages);
          return;
        }

        // Pause checkpoint: before sending the next AI request, check whether
        // the user paused this session. If paused, block here until resumed
        // or cancelled. This is the natural boundary — the previous response
        // has already been fully rendered, and no new streaming has started.
        const pauseController =
          ctx.pauseControllerRef.current.get(effectiveKey);
        if (pauseController?.paused) {
          await new Promise<void>((resolve) => {
            pauseController.resolve = resolve;
          });
          if (isRunCancelled(effectiveKey)) {
            return;
          }
        }

        // 迭代级瞬态指标归零：token / tok/s / 首字每次 agent loop 重新
        // 计算（放在 pause 之后，暂停期间保留上一迭代的最终显示值）。
        // run 级指标（runTtftMs / runTokenUsage / streamStartedAt）保持
        // 整个 run 累计，不受影响。
        resetIterationStreamMetrics(ctx, effectiveKey);

        // Capture the stream promise so rollback can await it before issuing
        // delete/truncate. Without this, the Rust store_chat_exchange write
        // transaction races with the delete/truncate write transaction and
        // can exceed the busy_timeout, producing "database is locked".
        // Per-conversation mode snapshot: read the modes from THIS session's
        // ref (falling back to the global defaults for safety), never from
        // the live global refs — another conversation toggling its modes
        // must not alter the behaviour of a background-running loop.
        const iterRef = ctx.sessionsRefData.current.get(effectiveKey);
        const effectiveWorktreeMode =
          iterRef?.worktreeMode ?? ctx.worktreeModeRef.current;
        const effectiveWorktreeId =
          iterRef?.worktreeId ?? ctx.pendingWorktreeIdRef.current;
        const projectSessionDirPath =
          directoryIdToPath(sessionDirId) ?? ctx.directoryPath;
        const effectiveExecutionWorkspaceRoot =
          await resolveConversationWorkspacePath(
            isPendingSessionKey(effectiveKey) ? "" : effectiveKey,
            sessionDirId,
            projectSessionDirPath,
            effectiveWorktreeMode,
            effectiveWorktreeId,
          );
        const chunkHandler = createStreamChunkHandler(
          ctx,
          effectiveKey,
          currentAssistantMessageId,
          () => isRunCancelled(effectiveKey),
        );
        const streamPromise = window.snow.createResponseStream(
          {
            messages: requestMessages,
            model: capturedOptions.model,
            apiProfile: capturedOptions.apiProfile,
            thinkingStrength: capturedOptions.thinkingStrength,
            responsesFastMode: capturedOptions.responsesFastMode,
            conversationId: currentConversationId,
            directoryId: sessionDirId,
            checkpointId,
            resumeAfterCompaction,
            disableTools,
            internalRecoveryPrompt,
            planMode: iterRef?.planMode ?? ctx.planModeRef.current,
            goalMode: iterRef?.goalMode ?? ctx.goalModeRef.current,
            worktreeMode: effectiveWorktreeMode,
            workflowMode: iterRef?.workflowMode ?? ctx.workflowModeRef.current,
            executionWorkspaceRoot: effectiveExecutionWorkspaceRoot,
            worktreeId: effectiveWorktreeId ?? undefined,
          },
          chunkHandler,
          createStreamIdHandler(ctx, effectiveKey, () =>
            isRunCancelled(effectiveKey),
          ),
        );
        const streamRefBefore = ctx.sessionsRefData.current.get(effectiveKey);
        if (streamRefBefore) {
          streamRefBefore.streamPromise = streamPromise;
        }

        let response: Awaited<typeof streamPromise>;
        try {
          response = await streamPromise;
        } finally {
          // 末批 chunk 必须同步落地：此后消息状态会被收尾逻辑覆盖，缓冲里
          // 残留的增量若晚到就会把内容追加到完整文本之上。
          chunkHandler.flush();
        }
        taskHistory.endResponseId = response.id;
        recordTaskResponse(
          taskHistory,
          response.conversationId || effectiveKey,
          response.id,
        );
        if (response.conversationId)
          bindAgentTask(response.conversationId, taskHistory);
        const responseDisposition = resolveResponseDisposition(response);
        const responseFailed = responseDisposition.kind === "error";

        const ref = ctx.sessionsRefData.current.get(effectiveKey);
        if (ref) {
          ref.streamId = null;
          ref.streamPromise = null;
        }

        // Replace the frontend-generated temporary user message id with the
        // real database id returned by store_chat_exchange. The backend
        // persists user messages in order and returns their snowflake ids in
        // persistedUserMessageIds. This keeps the in-memory message id in sync
        // with the DB so features like the user-message rail (which queries
        // the DB for message ids) can locate the DOM element by id without
        // restarting the app.
        if (
          response.persistedUserMessageIds &&
          response.persistedUserMessageIds.length > 0
        ) {
          const idRemap = remapPersistedUserMessageIds(
            ctx,
            effectiveKey,
            response.persistedUserMessageIds,
          );
          // Update the outer-scope userMessage reference so downstream code
          // (checkpoint association, error retry) uses the real DB id.
          const remappedUser = idRemap.get(userMessage.id);
          if (remappedUser) {
            userMessage.id = remappedUser;
          }
        }

        if (response.conversationId) {
          if (isPendingSessionKey(effectiveKey)) {
            // 迁移前的 pending 槽位 key：自动切换判断必须用它（effectiveKey
            // 在 migrateSession 之后会被赋值为真实 conversationId）。
            const migratingPendingKey = effectiveKey;

            if (planApprovedSessionKeysRef.current.has(effectiveKey)) {
              planApprovedSessionKeysRef.current.delete(effectiveKey);
              planApprovedSessionKeysRef.current.add(response.conversationId);
            }
            ctx.migrateSession(effectiveKey, response.conversationId);
            ctx.setRollbackNewChatState(null);
            const currentSession = ctx.sessionsRefData.current.get(
              response.conversationId,
            );
            const effectiveWorktreeId =
              currentSession?.worktreeId || ctx.pendingWorktreeIdRef.current;
            if (effectiveWorktreeId && currentSession) {
              currentSession.worktreeId = effectiveWorktreeId;
            }
            ctx.setPendingWorktreeId(null);
            if (
              ctx.activeSessionKeyRef.current === migratingPendingKey &&
              !ctx.newChatRequestedRef.current
            ) {
              // preserveViewKey：迁移是同一逻辑会话的 ID 升级而非视图切换，
              // 保持 sessionViewKey 不变，避免第一轮结束（通常伴随首个工具组
              // 挂载）时 chat-area / ChatInput 因 key 变化整体重建。
              ctx.setActiveId(response.conversationId, {
                preserveViewKey: true,
              });
            }

            // pending 会话的渠道/运行时/模式选择在拿到真实会话 id 后统一落库，
            // 使其在重启后仍能恢复（迁移前无 conversation_id 无法写入）。
            await persistConversationSelection(
              response.conversationId,
              capturedOptions,
              ctx.sessionsRefData.current.get(response.conversationId),
            );
            effectiveKey = response.conversationId;
            finalSessionKey = response.conversationId;

            // First message: replace the pending placeholder with the real
            // conversation record. This runs only once on session migration;
            // subsequent AI iterations must NOT refresh the list to avoid
            // excessive re-sorting. Follow-up messages already refreshed the
            // list at send time (handleSendMessage).
            if (!responseFailed) {
              const refreshId = response.conversationId;
              void window.snow
                .getChatConversation(refreshId)
                .then((conv) => {
                  if (conv) {
                    ctx.setUpsertedConversation({
                      record: conv,
                      timestamp: Date.now(),
                    });
                  }
                })
                .catch(() => {
                  // Upsert failure should not block the conversation
                });
            }
          }

          // Trigger summary generation as soon as the conversation is
          // created and the first user message is persisted. No need to
          // wait for the entire agent loop (tool calls, multi-turn AI
          // responses) to finish.
          if (
            isFirstMessage &&
            !summaryTriggered &&
            responseDisposition.kind === "complete"
          ) {
            summaryTriggered = true;
            const summaryConvId = response.conversationId;
            // Track the summary promise so rollback can await it before
            // issuing delete/truncate. The Rust backend writes
            // update_conversation_summary at the end of this promise — if it
            // races with deleteConversation, the database locks.
            const summaryPromise = window.snow
              .generateConversationSummary(summaryConvId)
              .then((generatedSummary) => {
                if (generatedSummary) {
                  ctx.updateSessionField(
                    summaryConvId,
                    "summary",
                    generatedSummary,
                  );
                  return window.snow.getChatConversation(summaryConvId);
                }
                return null;
              })
              .then((updated) => {
                if (updated) {
                  ctx.setUpsertedConversation({
                    record: updated,
                    timestamp: Date.now(),
                  });
                }
              })
              .catch(() => {
                // Summary generation failure should not block the conversation
              })
              .finally(() => {
                const summaryRef =
                  ctx.sessionsRefData.current.get(summaryConvId);
                if (
                  summaryRef &&
                  summaryRef.summaryPromise === summaryPromise
                ) {
                  summaryRef.summaryPromise = null;
                }
              });
            const summaryRefForPromise =
              ctx.sessionsRefData.current.get(summaryConvId);
            if (summaryRefForPromise) {
              summaryRefForPromise.summaryPromise = summaryPromise;
            }
          }
        }

        // Bump the conversation version so dependent components (e.g. the
        // user-message rail) know the DB message list changed (the user
        // message is now persisted via store_chat_exchange) and re-fetch.
        ctx.setConversationVersion((version) => version + 1);

        if (response.tokenUsage && !responseFailed) {
          ctx.updateSessionField(
            effectiveKey,
            "tokenUsage",
            response.tokenUsage,
          );
          // response.tokenUsage covers this request only; keep a run-level
          // sum so the summary bar can show the whole loop's consumption.
          accumulateRunTokenUsage(ctx, effectiveKey, response.tokenUsage);
        }

        // A final incomplete-like response is terminal for this model
        // iteration. Rust owns transport retries, so the renderer only keeps
        // safe display data and must not parse tools, compact, or recurse.
        if (responseDisposition.kind === "incomplete") {
          runFailed = true;
          ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
            currentMessages.map((currentMessage) =>
              currentMessage.id === currentAssistantMessageId
                ? {
                    ...currentMessage,
                    content: response.content || currentMessage.content || "",
                    thinking:
                      response.thinking || currentMessage.thinking || undefined,
                    timestamp: formatMessageTime(),
                    status: "incomplete" as const,
                    incompleteVariant: responseDisposition.variant,
                    interruptionReason: responseDisposition.reason,
                    recoveryOutcome: responseDisposition.recoveryOutcome,
                    responseId: response.id || undefined,
                    model: response.model || capturedOptions.model,
                    toolCalls: undefined,
                    isRetrying: false,
                    // 空响应终态保留最近一次重试的尝试序号与上游错误文本，
                    // 供重试提示以终态形态渲染；其余终态一律清空。
                    retryAttempt:
                      responseDisposition.reason === "empty_response"
                        ? currentMessage.retryAttempt
                        : undefined,
                    retryError:
                      responseDisposition.reason === "empty_response"
                        ? currentMessage.retryError
                        : undefined,
                  }
                : currentMessage,
            ),
          );
          return;
        }

        // Only complete responses may expose executable tool calls. Error
        // responses keep their existing terminal path with an empty tool list.
        const toolCalls =
          responseDisposition.kind === "complete"
            ? parseToolCalls(response.toolCallsJson)
            : [];
        const visibleToolCalls = toolCalls;

        const loopWillContinue =
          toolCalls.length > 0 || hasPendingSteering(ctx, effectiveKey);
        if (
          loopWillContinue &&
          response.tokenUsage &&
          !responseFailed &&
          !isPendingSessionKey(effectiveKey)
        ) {
          // Use the conversation-scoped profile (capturedOptions.apiProfile) so the
          // auto-compaction decision matches the API config the conversation
          // actually runs on — never the global active profile.
          const apiConfig = await ctx.getActiveApiConfig(
            capturedOptions.apiProfile,
          );
          if (apiConfig?.enableAutoCompress) {
            // autoCompressThreshold is stored in TOKENS (resolved from the
            // configured percent against maxContextTokens when the config is
            // saved). Compare the live token total against it directly — do NOT
            // run it through calculateAutoCompressThresholdTokens, which expects
            // a percent and would clamp a token value to 100% of the context.
            const thresholdTokens = apiConfig.autoCompressThreshold;
            if (thresholdTokens != null && thresholdTokens > 0) {
              const totalTokens =
                response.tokenUsage.inputTokens +
                response.tokenUsage.outputTokens;
              if (totalTokens >= thresholdTokens) {
                ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
                  currentMessages.map((currentMessage) =>
                    currentMessage.id === currentAssistantMessageId
                      ? {
                          ...currentMessage,
                          content:
                            response.content || currentMessage.content || "",
                          thinking:
                            response.thinking ||
                            currentMessage.thinking ||
                            undefined,
                          timestamp: formatMessageTime(),
                          status: "sent",
                          responseId: response.id || undefined,
                          model: response.model || capturedOptions.model,
                          isRetrying: false,
                        }
                      : currentMessage,
                  ),
                );

                const compactionResult = await ctx.performCompactionRef.current(
                  effectiveKey,
                  capturedOptions.model,
                  true,
                  undefined,
                  capturedOptions.apiProfile,
                  undefined,
                  undefined,
                  capturedOptions.thinkingStrength,
                  capturedOptions.responsesFastMode,
                );

                if (compactionResult) {
                  if (isRunCancelled(effectiveKey)) {
                    return;
                  }

                  const sessionRefAfterCompaction =
                    ctx.sessionsRefData.current.get(effectiveKey);
                  if (sessionRefAfterCompaction) {
                    sessionRefAfterCompaction.isSending = true;
                    sessionRefAfterCompaction.isAbortRequested = false;
                  }

                  const postCompactionAssistantId =
                    createMessageId("assistant");
                  const postCompactionAssistant: ChatConversationMessage = {
                    id: postCompactionAssistantId,
                    role: "assistant",
                    content: "",
                    timestamp: formatMessageTime(),
                    status: "sending",
                    model: capturedOptions.model,
                  };
                  ctx.updateSessionMessages(effectiveKey, (currentMessages) => [
                    ...currentMessages,
                    postCompactionAssistant,
                  ]);
                  await runAgentLoop(
                    postCompactionAssistantId,
                    [
                      { role: "user", content: compactionResult.content },
                      ...(compactionResult.protectedMessages ?? []),
                    ],
                    response.conversationId,
                    compactionResult.checkpointId,
                    true,
                  );
                  return;
                }
              }
            }
          }
        }

        if (isRunCancelled(effectiveKey)) {
          // 取消：handleAbort 已同步收尾过一次，这里再跑一次幂等收尾，兜住
          // 未经 handleAbort 的取消路径（例如本 run 被新的 run 取代），避免
          // 消息残留「发送中 / 重试中」。
          ctx.updateSessionMessages(effectiveKey, settleInterruptedMessages);
          return;
        }

        // Failed responses still migrate the session, but remain visible
        // locally as an error. Complete responses are finalized as sent.
        ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
          currentMessages.map((currentMessage) => {
            if (currentMessage.id !== currentAssistantMessageId) {
              return currentMessage;
            }

            return {
              ...currentMessage,
              content: response.content || currentMessage.content || "",
              thinking:
                response.thinking || currentMessage.thinking || undefined,
              timestamp: formatMessageTime(),
              status: responseFailed ? "error" : "sent",
              responseId: response.id || undefined,
              model: response.model || capturedOptions.model,
              toolCalls:
                visibleToolCalls.length > 0 ? visibleToolCalls : undefined,
              isRetrying: false,
            };
          }),
        );

        if (responseFailed) {
          runFailed = true;
          return;
        }

        // A model-only response ends the run unless a same-run steer is waiting.
        // Follow-up queue entries must never extend this recursive loop.
        if (toolCalls.length === 0) {
          const steering = await consumeSteering(
            effectiveKey,
            response.conversationId,
          );
          if (isRunCancelled(effectiveKey)) return;
          if (steering.messages.length > 0) {
            const nextAssistantId = createMessageId("assistant");
            ctx.updateSessionMessages(effectiveKey, (currentMessages) => [
              ...currentMessages,
              {
                id: nextAssistantId,
                role: "assistant",
                content: "",
                timestamp: formatMessageTime(),
                status: "sending",
                model: capturedOptions.model,
              },
            ]);
            await runAgentLoop(
              nextAssistantId,
              steering.messages,
              response.conversationId,
              steering.checkpointId ?? checkpointId,
            );
            return;
          }

          // Goal Mode auto-continuation: the model stopped while its TODO list
          // was still unfinished. Re-activate the loop with a visible
          // continuation message instead of ending the run. A user cancel
          // (isRunCancelled above) always wins and never re-activates; the
          // configured token budget caps the loop.
          if (!disableTools) {
            const runUsage = iterRef?.runTokenUsage;
            const decision = await resolveGoalContinuation({
              goalMode: iterRef?.goalMode ?? ctx.goalModeRef.current,
              budgetTokens:
                iterRef?.goalModeTokenBudget ?? ctx.goalModeTokenBudget,
              usedTokens:
                (runUsage?.inputTokens ?? 0) + (runUsage?.outputTokens ?? 0),
              conversationId: response.conversationId,
              directoryId: sessionDirId,
              heading: t("chat.agentLoop.goalAutoContinuation", {
                defaultValue: "Goal Mode auto-continuation",
              }),
            });
            if (isRunCancelled(effectiveKey)) return;
            if (decision.kind === "continue") {
              const goalUserMessage: ChatConversationMessage = {
                id: createMessageId("user"),
                role: "user",
                content: decision.prompt,
                timestamp: formatMessageTime(),
                status: "sent",
              };
              const goalAssistantId = createMessageId("assistant");
              ctx.updateSessionMessages(effectiveKey, (currentMessages) => [
                ...currentMessages,
                goalUserMessage,
                {
                  id: goalAssistantId,
                  role: "assistant",
                  content: "",
                  timestamp: formatMessageTime(),
                  status: "sending",
                  model: capturedOptions.model,
                },
              ]);
              await runAgentLoop(
                goalAssistantId,
                [{ role: "user", content: decision.prompt }],
                response.conversationId,
                checkpointId,
              );
            }
          }
          return;
        }

        // A provider that returns calls after tools were deliberately omitted
        // has violated the request contract. Record the calls for auditability
        // but do not authorize, execute, or recurse into another loop.
        if (disableTools) {
          const ignoredResult = JSON.stringify({
            success: false,
            error: "TOOLS_DISABLED_FOR_DUPLICATE_RECOVERY",
            message:
              "Tools were disabled for this recovery request because equivalent read-only calls already completed. No tool was executed.",
          });
          ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
            currentMessages.map((currentMessage) =>
              currentMessage.id === currentAssistantMessageId
                ? {
                    ...currentMessage,
                    content:
                      currentMessage.content ||
                      response.content ||
                      t("chat.agentLoop.duplicateRecoveryFallback", {
                        defaultValue:
                          "（已基于此前读取的内容分析完毕，请参见上方工具结果与回答）",
                      }),
                    toolCalls: toolCalls.map((toolCall) => ({
                      ...toolCall,
                      status: "completed" as const,
                      result: ignoredResult,
                    })),
                  }
                : currentMessage,
            ),
          );
          if (response.conversationId) {
            await window.snow.appendToolMessage(
              response.conversationId,
              formatToolResultsContent(
                toolCalls.map((toolCall) => ({
                  name: toolCall.name,
                  callId: toolCall.callId || "",
                  result: ignoredResult,
                })),
              ),
            );
          }
          runFailed = true;
          return;
        }

        // Tool calls are normally processed into results and followed by
        // another model request. A batch made entirely of repeated successful
        // readonly calls is terminal: its duplicate results are persisted, but
        // sending them back to a provider that already ignored the prior result
        // would only create an unbounded request loop.
        const readonlyToolNames = await getReadonlyToolNames();
        const { executableToolCalls, duplicateReadonlyResults } =
          await readonlyGuard.filterToolCalls(toolCalls, readonlyToolNames);

        // Keep the duplicate visible as a completed tool card while ensuring
        // it never reaches the MCP bridge.
        if (duplicateReadonlyResults.size > 0) {
          ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
            currentMessages.map((currentMessage) =>
              currentMessage.id === currentAssistantMessageId
                ? {
                    ...currentMessage,
                    toolCalls: [...duplicateReadonlyResults.entries()].reduce(
                      (currentToolCalls, [toolCall, result]) =>
                        updateFirstMatchingToolCall(
                          currentToolCalls,
                          toolCall,
                          ["pending", "running"],
                          (currentToolCall) => ({
                            ...currentToolCall,
                            status: "completed" as const,
                            result,
                          }),
                        ),
                      currentMessage.toolCalls,
                    ),
                  }
                : currentMessage,
            ),
          );
        }

        const authorizationDecisions = await requestToolAuthorizations(
          executableToolCalls,
          effectiveKey,
          sessionDirId,
        );

        // 非 YOLO 模式授权判定：
        // - 全部工具被拒绝且没有任何续跑理由（直接拒绝普通工具/中断/
        //   hook abort）：AI 流程直接结束，不再向模型追加工具结果。
        // - 拒绝携带续跑理由（用户填写的理由，或敏感命令被拒绝）：拒绝理由
        //   作为工具结果回传 AI，Loop 继续，让 AI 根据理由调整后续行动。
        // - 部分拒绝：已拒绝的工具返回拒绝结果给 AI，已批准的工具
        //   正常执行，Loop 继续。
        const allToolsRejected =
          executableToolCalls.length > 0 &&
          authorizationDecisions.every(
            (decision) => decision.status === "rejected",
          );
        const hasContinuableRejection =
          authorizationDecisions.some(rejectionKeepsAiFlow);

        const toolExecutor = createToolExecutor({
          ctx,
          effectiveKey,
          currentAssistantMessageId,
          checkpointIds: checkpointId ? [checkpointId] : [],
          sessionDirId,
          directoryPath: ctx.directoryPath,
          responseId: response.id,
          isRunCancelled,
          awaitHookDecision,
          executeSubAgentActivation,
          executeSubAgentMainTool,
          executeWorkflowGenerate,
          executeWorkflowResume,
          planApprovedSessionKeysRef,
          planModeRef: ctx.planModeRef,
        });
        const toolExecResult = await toolExecutor(
          executableToolCalls,
          authorizationDecisions,
        );
        if (!toolExecResult) {
          return;
        }
        const {
          structuredToolResults: executedToolResults,
          hookAborted,
          hookAbortMessage,
          userQuestionCancelled,
          pendingHookWarnings,
        } = toolExecResult;

        const structuredToolResults: {
          name: string;
          callId: string;
          result: string;
        }[] = [];
        let executedResultIndex = 0;
        for (const toolCall of toolCalls) {
          const duplicateResult = duplicateReadonlyResults.get(toolCall);
          if (duplicateResult !== undefined) {
            structuredToolResults.push({
              name: toolCall.name,
              callId: toolCall.callId || "",
              result: duplicateResult,
            });
            continue;
          }

          const executedResult = executedToolResults[executedResultIndex++];
          if (executedResult) {
            structuredToolResults.push(executedResult);
          }
        }

        // Only successful read results are cacheable. Any approved non-read
        // tool is conservatively treated as a potential state change, which
        // permits the model to read the same path again after that boundary.
        await readonlyGuard.recordToolExecutions(
          executableToolCalls,
          authorizationDecisions,
          executedToolResults,
          readonlyToolNames,
        );

        // Hook abort (exit code 2+): fully interrupt the AI loop and surface
        // the hook's error message. No tool results are sent to the model.
        if (hookAborted) {
          const abortContent = `[Hook Abort] ${hookAbortMessage}`;
          ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
            currentMessages.map((currentMessage) =>
              currentMessage.id === currentAssistantMessageId
                ? {
                    ...currentMessage,
                    content: abortContent,
                    timestamp: formatMessageTime(),
                    status: "error",
                    isRetrying: false,
                  }
                : currentMessage,
            ),
          );
          // Queue survives terminal paths; it must not bypass a stopped or failed run.
          runFailed = true;
          if (response.conversationId) {
            await window.snow.appendToolMessage(
              response.conversationId,
              abortContent,
            );
          }
          return;
        }

        // Add tool results as a tool message for the next iteration
        const toolResultMessageId = createMessageId("tool");
        let toolResultContent = formatToolResultsContent(structuredToolResults);
        // Inject collected hook warnings (exit code 1) so the model sees them
        // alongside the tool results.
        if (pendingHookWarnings.length > 0) {
          toolResultContent += `\n\n[Hook Warnings]\n${pendingHookWarnings.join(
            "\n",
          )}`;
        }
        const toolResultMessage: ChatConversationMessage = {
          id: toolResultMessageId,
          role: "tool",
          content: toolResultContent,
          timestamp: formatMessageTime(),
          status: "sent",
          toolName: toolCalls.map((tc) => tc.name).join(", "),
        };

        ctx.updateSessionMessages(effectiveKey, (currentMessages) => [
          ...currentMessages,
          toolResultMessage,
        ]);
        const toolResultsJson = JSON.stringify(structuredToolResults);

        // A duplicate-only batch has no new work to execute. Preserve its
        // structured results and request one tool-free continuation so the
        // provider can summarize the already available evidence. The recovery
        // instruction is request-local and never enters chat history.
        if (
          duplicateReadonlyResults.size > 0 &&
          executableToolCalls.length === 0
        ) {
          if (readonlyGuard.getDuplicateRecoveryAttempted()) {
            runFailed = true;
            if (response.conversationId) {
              await window.snow.appendToolMessage(
                response.conversationId,
                toolResultContent,
              );
            }
            return;
          }
          readonlyGuard.setDuplicateRecoveryAttempted(true);
          const recoveryInstruction =
            "The requested read-only calls have already completed and their results are in the conversation. Do not call tools in this turn. Use the existing results to provide the best final answer.";
          const recoveryAssistantMessageId = createMessageId("assistant");
          ctx.updateSessionMessages(effectiveKey, (currentMessages) => [
            ...currentMessages,
            {
              id: recoveryAssistantMessageId,
              role: "assistant",
              content: "",
              timestamp: formatMessageTime(),
              status: "sending",
              model: capturedOptions.model,
            },
          ]);
          await runAgentLoop(
            recoveryAssistantMessageId,
            [{ role: "tool", content: toolResultContent, toolResultsJson }],
            response.conversationId,
            checkpointId,
            undefined,
            true,
            recoveryInstruction,
          );
          return;
        }

        if (userQuestionCancelled) {
          runFailed = true;
          if (response.conversationId) {
            await window.snow.appendToolMessage(
              response.conversationId,
              toolResultContent,
            );
          }
          return;
        }

        // 全部工具被拒绝且没有任何续跑理由时，AI 流程直接结束，不再发起
        // 新一轮请求。若拒绝可续跑（用户填写理由 / 敏感命令被拒绝），则拒绝
        // 结果已在上方写入 toolResults，走正常续跑分支让 AI 继续处理。
        if (allToolsRejected && !hasContinuableRejection) {
          runFailed = true;
          if (response.conversationId) {
            await window.snow.appendToolMessage(
              response.conversationId,
              toolResultContent,
            );
          }
          return;
        }

        const nextMessages: {
          role: "user" | "assistant" | "system" | "developer" | "tool";
          content: string;
          toolResultsJson?: string;
        }[] = [{ role: "tool", content: toolResultContent, toolResultsJson }];
        // All tool results are settled before steering is appended. Queue is
        // intentionally not touched at this boundary.
        const steering = await consumeSteering(
          effectiveKey,
          response.conversationId,
        );
        if (isRunCancelled(effectiveKey)) return;
        nextMessages.push(...steering.messages);
        const pendingFlushCheckpointId = steering.checkpointId;

        const newAssistantMessageId = createMessageId("assistant");
        const newPendingAssistant: ChatConversationMessage = {
          id: newAssistantMessageId,
          role: "assistant",
          content: "",
          timestamp: formatMessageTime(),
          status: "sending",
          model: capturedOptions.model,
        };
        ctx.updateSessionMessages(effectiveKey, (currentMessages) => [
          ...currentMessages,
          newPendingAssistant,
        ]);

        await runAgentLoop(
          newAssistantMessageId,
          nextMessages,
          response.conversationId,
          pendingFlushCheckpointId ?? checkpointId,
        );
      };

      // Create a file-system checkpoint before the AI loop starts so that
      // rollback can restore the working directory to this pre-AI state.
      // The checkpoint is awaited before runAgentLoop to guarantee the AI
      // cannot modify files before the snapshot is captured.
      const initCheckpointAndRun = async (): Promise<void> => {
        // Pre-send auto-compaction: if the existing context already exceeds
        // the configured threshold, compact first so the new user message is
        // sent against a fresh, summarized context. This applies both to
        // direct user sends and to pending-message flushes (which re-enter
        // handleSendMessage via handleSendMessageRef).
        if (!isPendingSessionKey(sessionKey)) {
          // Use the conversation-scoped profile (capturedOptions.apiProfile) so the
          // auto-compaction decision matches the API config the conversation
          // actually runs on — never the global active profile.
          const apiConfig = await ctx.getActiveApiConfig(
            capturedOptions.apiProfile,
          );
          if (apiConfig?.enableAutoCompress) {
            // autoCompressThreshold is stored in TOKENS — compare directly (see
            // the in-loop check for why calculateAutoCompressThresholdTokens is
            // intentionally not used here).
            const thresholdTokens = apiConfig.autoCompressThreshold;
            if (thresholdTokens != null && thresholdTokens > 0) {
              const currentTokenUsage =
                ctx.sessionsRef.current?.[sessionKey]?.tokenUsage ?? null;
              if (currentTokenUsage) {
                const totalTokens =
                  currentTokenUsage.inputTokens +
                  currentTokenUsage.outputTokens;
                if (totalTokens >= thresholdTokens) {
                  await ctx.performCompactionRef.current(
                    sessionKey,
                    capturedOptions.model,
                    true,
                    undefined,
                    capturedOptions.apiProfile,
                    undefined,
                    undefined,
                    capturedOptions.thinkingStrength,
                    capturedOptions.responsesFastMode,
                  );

                  // performCompaction resets sessionRef.isSending to false in
                  // its finally block, but we are still mid-send — restore it
                  // so the outer handleSendMessage flow keeps the session
                  // locked until it finishes.
                  const sessionRefAfterCompaction =
                    ctx.sessionsRefData.current.get(sessionKey);
                  if (sessionRefAfterCompaction) {
                    sessionRefAfterCompaction.isSending = true;
                    sessionRefAfterCompaction.isAbortRequested = false;
                  }

                  // If the user aborted during compaction, stop here
                  // regardless of whether compaction succeeded.
                  if (isRunCancelled(sessionKey)) {
                    return;
                  }
                }
              }
            }
          }
        }

        let checkpointId: string | undefined;
        // checkpoint 根目录跟随持久 WorkTree 绑定；绑定缺失/失效时 fail-closed。
        const projectSessionDirPath =
          directoryIdToPath(sessionDirId) ?? ctx.directoryPath;
        const effectiveWorktreeId =
          sessionRef?.worktreeId || ctx.pendingWorktreeIdRef.current;
        const sessionDirPath = await resolveConversationWorkspacePath(
          isPendingSessionKey(sessionKey) ? "" : sessionKey,
          sessionDirId,
          projectSessionDirPath,
          sessionRef?.worktreeMode ?? false,
          effectiveWorktreeId,
        );
        // createCheckpoint 是异步的：await 期间本 run 可能已被取消或被
        // 更新的 run 取代（停止按钮、PendingMessages 强制发送会先
        // handleAbort 再立即启动新 run）。两个 run 的 checkpoint 若按
        // 完成顺序 push 进 checkpointIds，顺序会与消息顺序错位，导致
        // 回滚时按 checkpointId 定位的删除/恢复范围错误。因此创建完成
        // 后必须校验 runId：已被取代的 checkpoint 直接删除、不绑定。
        // 被取代的 run 从未开始执行工具（checkpoint 是工具执行的前置
        // 步骤），其文件状态已由后一个 run 的 checkpoint 覆盖捕获，
        // 删除是安全的。
        checkpointId = await createFlushCheckpoint(sessionKey, sessionDirPath);
        if (isRunCancelled(sessionKey)) {
          return;
        }
        if (checkpointId) {
          ctx.updateSessionMessages(sessionKey, (currentMessages) =>
            currentMessages.map((m) =>
              m.id === userMessage.id ? { ...m, checkpointId } : m,
            ),
          );
        }

        // Execute onUserMessage hooks before sending the message to the AI.
        // Unified exit-code semantics:
        //   0 = pass (stdout injected as [Hook Context])
        //   1 = warn (warning text injected as [Hook Warning])
        //   2+ = abort (AI loop interrupted, error shown to user)
        // Hooks may fail open as before, but a model/steering failure must never
        // be mistaken for a hook error and replay the original task a second time.
        let agentLoopStarted = false;
        const startInitialLoop = async (content: string): Promise<void> => {
          agentLoopStarted = true;
          await runAgentLoop(
            assistantMessageId,
            [{ role: "user", content }],
            isPendingSessionKey(sessionKey) ? undefined : sessionKey,
            checkpointId,
          );
        };
        try {
          const hookContext = JSON.stringify({
            message: trimmed,
            cwd: sessionDirPath ?? "",
            sessionId: isPendingSessionKey(sessionKey) ? undefined : sessionKey,
          });
          const hookResult = await window.snow.executeHooks({
            hookType: "onUserMessage",
            projectId: sessionDirId ?? undefined,
            contextJson: hookContext,
          });
          const outcome = resolveHookOutcome(hookResult);

          // Store non-decision outcomes immediately.
          // appended by awaitHookDecision together with their runtime resolver.
          const hookExecRecord = buildHookExecRecord(
            "onUserMessage",
            hookResult,
            outcome,
          );
          if (outcome.kind !== "needsDecision") {
            ctx.updateSessionMessages(finalSessionKey, (currentMessages) =>
              appendHookExecutionToMessage(
                currentMessages,
                hookExecRecord,
                userMessage.id,
              ),
            );
          }

          if (outcome.kind === "abort") {
            runFailed = true;
            ctx.updateSessionMessages(finalSessionKey, (currentMessages) =>
              currentMessages.map((currentMessage) =>
                currentMessage.id === assistantMessageId
                  ? {
                      ...currentMessage,
                      content: outcome.message,
                      timestamp: formatMessageTime(),
                      status: "error",
                      isRetrying: false,
                    }
                  : currentMessage,
              ),
            );
            return;
          }

          if (outcome.kind === "needsDecision") {
            const userDecision = await awaitHookDecision(
              finalSessionKey,
              userMessage.id,
              hookExecRecord,
            );
            if (isRunCancelled(finalSessionKey)) {
              return;
            }

            if (!userDecision) {
              runFailed = true;
              ctx.updateSessionMessages(finalSessionKey, (currentMessages) =>
                currentMessages.map((currentMessage) =>
                  currentMessage.id === assistantMessageId
                    ? {
                        ...currentMessage,
                        content: outcome.message,
                        timestamp: formatMessageTime(),
                        status: "error",
                        isRetrying: false,
                      }
                    : currentMessage,
                ),
              );
              return;
            }

            await startInitialLoop(trimmed);
            return;
          }

          let effectiveMessage = trimmed;
          if (outcome.kind === "warn") {
            effectiveMessage = `${trimmed}\n\n[Hook Warning]\n${outcome.message}`;
          } else if (outcome.kind === "pass" && outcome.context) {
            effectiveMessage = `${trimmed}\n\n[Hook Context]\n${outcome.context}`;
          }

          await startInitialLoop(effectiveMessage);
        } catch (hookError) {
          if (agentLoopStarted) throw hookError;
          // Only hook execution failures may fall back to the original input.
          await startInitialLoop(trimmed);
        }
      };

      let runFailed = false;
      const reportRunError = (error: unknown): void => {
        runFailed = true;
        if (isRunCancelled(finalSessionKey)) return;
        const ref = ctx.sessionsRefData.current.get(finalSessionKey);
        if (ref) ref.streamId = null;
        ctx.updateSessionMessages(finalSessionKey, (currentMessages) =>
          currentMessages.map((currentMessage) =>
            currentMessage.status === "sending"
              ? {
                  ...currentMessage,
                  content: getErrorMessage(error),
                  timestamp: formatMessageTime(),
                  status: "error",
                  isRetrying: false,
                }
              : currentMessage,
          ),
        );
      };
      void initCheckpointAndRun()
        .catch(reportRunError)
        .finally(async () => {
          const ref = ctx.sessionsRefData.current.get(finalSessionKey);
          // Catch a steer arriving after the final response's boundary check.
          // Closing admission synchronously after this loop makes inputs arriving
          // during onStop ordinary follow-ups, not abandoned same-run steers.
          try {
            while (
              !runFailed &&
              !isRunCancelled(finalSessionKey) &&
              hasPendingSteering(ctx, finalSessionKey)
            ) {
              const steering = await consumeSteering(
                finalSessionKey,
                isPendingSessionKey(finalSessionKey)
                  ? undefined
                  : finalSessionKey,
              );
              if (!steering.messages.length || isRunCancelled(finalSessionKey))
                break;
              const nextAssistantId = createMessageId("assistant");
              ctx.updateSessionMessages(finalSessionKey, (currentMessages) => [
                ...currentMessages,
                {
                  id: nextAssistantId,
                  role: "assistant",
                  content: "",
                  timestamp: formatMessageTime(),
                  status: "sending",
                  model: capturedOptions.model,
                },
              ]);
              await runAgentLoop(
                nextAssistantId,
                steering.messages,
                isPendingSessionKey(finalSessionKey)
                  ? undefined
                  : finalSessionKey,
                steering.checkpointId,
              );
            }
          } catch (error) {
            reportRunError(error);
          }
          if (!ref || ref.runId !== currentRunId) {
            await finalizeTaskHistory();
            // Abort increments the generation. Keep its lifecycle hook, but never
            // mutate the replacement run's counters, locks, or pending queue.
            await runHook(
              "onStop",
              sessionDirId ?? undefined,
              JSON.stringify({
                conversationId: isPendingSessionKey(finalSessionKey)
                  ? undefined
                  : finalSessionKey,
                cwd: directoryIdToPath(sessionDirId) ?? ctx.directoryPath ?? "",
                reason: "aborted",
              }),
            )
              .then((hookResult) => {
                if (
                  hookResult &&
                  ctx.sessionsRefData.current.has(finalSessionKey)
                ) {
                  ctx.updateSessionMessages(finalSessionKey, (messages) =>
                    appendHookExecutionToMessage(
                      messages,
                      toNonBlockingRecord(hookResult.record),
                      assistantMessageId,
                    ),
                  );
                }
              })
              .catch(() => {
                // Hook failure must not resurrect a stopped run.
              });
            window.snow.notifyPetTurnEnded(petTurnId, true);
            return;
          }
          ref.activeSendOptions = undefined;

          // AI 流程完全结束：把本次 run 的耗时与累计 token 累加进会话
          // 统计（内存 + DB 双向，展示的是整个会话的累计值）。耗时用
          // 本地 runStartedAt 计算，不受 catch 分支提前清零的影响。
          const runDurationMs = Math.max(0, Date.now() - runStartedAt);
          const finalRef = ctx.sessionsRefData.current.get(finalSessionKey);
          const runUsage = finalRef?.runTokenUsage;
          const runTtftSumMs = finalRef?.runTtftSumMs ?? 0;
          const runRequestCount = finalRef?.runRequestCount ?? 0;
          accumulateConversationRunStats(
            ctx,
            finalSessionKey,
            runUsage,
            runDurationMs,
            runTtftSumMs,
            runRequestCount,
          );

          if (!isPendingSessionKey(finalSessionKey)) {
            void window.snow
              .setConversationRunStats(
                finalSessionKey,
                runUsage?.inputTokens ?? 0,
                runUsage?.outputTokens ?? 0,
                runUsage?.cacheCreationInputTokens ?? 0,
                runUsage?.cacheReadInputTokens ?? 0,
                runDurationMs,
                runTtftSumMs,
                runRequestCount,
              )
              .catch(() => {
                // 持久化失败不阻塞收尾
              });
          }

          // Keep the run locked through stop-hook cleanup before starting a follow-up.
          const stopDirId = ref?.directoryId ?? sessionDirId ?? ctx.directoryId;
          const onStopMessageId = ctx.sessionsRef.current[
            finalSessionKey
          ]?.messages.findLast((message) => message.role !== "tool")?.id;
          const onStopContext = JSON.stringify({
            conversationId: isPendingSessionKey(finalSessionKey)
              ? undefined
              : finalSessionKey,
            cwd: directoryIdToPath(stopDirId) ?? ctx.directoryPath ?? "",
            reason: isRunCancelled(finalSessionKey) ? "aborted" : "completed",
          });
          await runHook("onStop", stopDirId ?? undefined, onStopContext)
            .then((hookResult) => {
              if (hookResult) {
                ctx.updateSessionMessages(finalSessionKey, (currentMessages) =>
                  appendHookExecutionToMessage(
                    currentMessages,
                    toNonBlockingRecord(hookResult.record),
                    onStopMessageId,
                  ),
                );
              }
            })
            .catch(() => {
              // onStop hook failures must not block cleanup
            });

          window.snow.notifyPetTurnEnded(
            petTurnId,
            runFailed || isRunCancelled(finalSessionKey),
          );

          await finalizeTaskHistory();

          const ownsSession = !!ref && ref.runId === currentRunId;
          if (!ownsSession) return;
          if (ownsSession) {
            ref.isSending = false;
            ref.activeTaskMessages = undefined;
            demotePendingSteering(ctx, finalSessionKey);
            ctx.updateSessionField(finalSessionKey, "isStreaming", false);
            ctx.updateSessionField(finalSessionKey, "streamStartedAt", 0);
            ctx.updateSessionField(finalSessionKey, "isAborting", false);
            ctx.updateSessionField(finalSessionKey, "isPaused", false);
            // Clear the pause controller so a stale resolve callback from a
            // previous run cannot accidentally unblock a future iteration.
            ctx.pauseControllerRef.current.delete(finalSessionKey);
            ctx.removeStreamingId(finalSessionKey);
          }

          if (!isPendingSessionKey(finalSessionKey)) {
            void window.snow
              .getChatConversation(finalSessionKey)
              .then((conv) => {
                if (conv) {
                  ctx.setUpsertedConversation({
                    record: conv,
                    timestamp: Date.now(),
                  });
                }
              })
              .catch(() => {
                // Upsert failure should not block cleanup
              });
          }

          // Only the owning, successfully completed run can start one FIFO task.
          // Stops/errors keep the remaining queue visible and withdrawable.
          if (ownsSession && !runFailed && !isRunCancelled(finalSessionKey)) {
            const next = takeNextQueuedMessage(ctx, finalSessionKey);
            if (next) {
              ctx.handleSendMessageRef.current(next.text, {
                ...next.options,
                deliveryMode: "queue",
                targetSessionKey: finalSessionKey,
              });
              return;
            }
          }

          // If this is a background conversation (not the active one),
          // mark it as completed so the sidebar shows a dot indicator.
          // 用户主动停止（abort）不算「后台会话跑完」：与下方 notifyAiComplete
          // 保持同一口径，避免手动打断后侧栏仍亮「有新内容 / 已完成」圆点。
          if (
            !isPendingSessionKey(finalSessionKey) &&
            finalSessionKey !== ctx.activeConversationIdRef.current &&
            !isRunCancelled(finalSessionKey)
          ) {
            ctx.updateSessionField(finalSessionKey, "hasNewContent", true);
            ctx.setCompletedConversationIds((prev: Set<string>) => {
              if (prev.has(finalSessionKey)) return prev;
              const next = new Set(prev);
              next.add(finalSessionKey);
              return next;
            });
          }

          // 通知系统：AI 流程正常结束时触发系统通知。
          // 窗口是否聚焦的判断由主进程 notificationManager 负责 —
          // 如果用户正在看应用，主进程会自动跳过通知，不会打扰。
          if (
            !isPendingSessionKey(finalSessionKey) &&
            !isRunCancelled(finalSessionKey)
          ) {
            const sessionState = ctx.sessionsRef.current?.[finalSessionKey];
            ctx.notifyAiComplete({
              conversationId: finalSessionKey,
              directoryId: sessionState?.directoryId ?? ctx.directoryId,
              title: sessionState?.summary || undefined,
            });
          }
        });
    },
    [
      ctx.directoryId,
      ctx.directoryPath,
      ctx.ensureSession,
      ctx.updateSessionMessages,
      ctx.updateSessionField,
      ctx.migrateSession,
      ctx.addStreamingId,
      ctx.removeStreamingId,
      ctx.setActiveId,
      ctx.setNewChatRequested,
      ctx.rollbackNewChatState,
      ctx.setRollbackNewChatState,
      ctx.notifyAiComplete,
      requestToolAuthorizations,
      t,
    ],
  );

  // Keep the ref current so the pending-flush closure always calls the latest version.
  ctx.handleSendMessageRef.current = handleSendMessage;

  return { handleSendMessage };
};
