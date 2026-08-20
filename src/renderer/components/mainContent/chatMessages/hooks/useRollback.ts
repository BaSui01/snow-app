import { useCallback, useRef, useState } from "react";
import type {
  ConversationContextValue,
  CheckpointFileChange,
  RollbackMode,
  RollbackConversationState,
  RollbackTodoItem,
} from "../utils/conversationTypes";
import { PENDING_SESSION_KEY } from "../utils/conversationTypes";
import {
  deleteCheckpoints,
  directoryIdToPath,
  getErrorMessage,
  killRunningToolExecutions,
} from "../utils/conversationHelpers";

/**
 * 回滚逻辑：中止流、预览文件变更、确认/取消回滚。
 * context_compaction 回滚必须调用 truncateConversation，以其自身 responseId
 * 为起点删除边界及后续消息；不得调用 deleteConversation。
 */
export const useRollback = (ctx: ConversationContextValue) => {
  const clearDraftToRestore = useCallback((): void => {
    ctx.setDraftToRestore(null);
  }, [ctx.setDraftToRestore]);

  /** 正在计算变更（弹窗弹出前）的消息 id：SSH 下 listCheckpointChanges
   *  经 SFTP 遍历可能较慢，入口按钮在此期间显示 loading。 */
  const [preparingMessageId, setPreparingMessageId] = useState<string | null>(
    null
  );
  /** 每次打开/取消回滚都会推进序号，异步变更/TODO 查询只能提交自己的结果。 */
  const rollbackRequestIdRef = useRef(0);

  const handleRollback = useCallback(
    (messageId: string): void => {
      const key = ctx.activeConversationIdRef.current ?? PENDING_SESSION_KEY;
      const requestId = ++rollbackRequestIdRef.current;

      // Abort any in-flight stream before rolling back.
      const ref = ctx.sessionsRefData.current.get(key);
      if (ref?.streamId) {
        void window.snow.abortResponseStream(ref.streamId);
        ref.streamId = null;
      }
      if (ref) {
        ref.isSending = false;
        ref.runId += 1;
      }
      // 回滚作用于会话自己的目录(而非运行时全局目录),确保 checkpoint
      // manifest.work_dir 与恢复目录一致,切换项目后仍可回滚旧会话。
      const sessionWorkDir =
        directoryIdToPath(ref?.directoryId) ?? ctx.directoryPath;
      ctx.updateSessionField(key, "isStreaming", false);
      ctx.updateSessionField(key, "streamStartedAt", 0);
      ctx.updateSessionField(key, "isAborting", false);
      // Clear the vision textify status card: the abort above may interrupt
      // the backend while it describes user images, and a stuck intermediate
      // card must not survive the rollback.
      ctx.updateSessionField(key, "visionAnalysis", undefined);
      ctx.removeStreamingId(key);

      // Cancel any in-flight summary generation so the
      // update_conversation_summary write transaction is skipped before the
      // rollback's delete/truncate runs. Without this, the summary promise may
      // still hold a database write lock and cause "database is locked".
      if (key !== PENDING_SESSION_KEY) {
        void window.snow.cancelConversationSummary(key);
      }

      const session = ctx.sessionsRef.current[key];
      if (!session) {
        return;
      }

      // Kill every in-flight bash subprocess before truncating the
      // conversation, so no orphaned OS process keeps running afterwards.
      killRunningToolExecutions(session.messages);

      const messages = session.messages;
      const targetIndex = messages.findIndex((m) => m.id === messageId);
      if (targetIndex === -1) {
        return;
      }
      // 变更计算（SSH 下经 SFTP）期间入口按钮显示 loading，弹窗弹出或
      // 失败后清除。
      setPreparingMessageId(messageId);

      const targetMessage = messages[targetIndex];
      const messageContent = targetMessage.content;
      const checkpointId = targetMessage.checkpointId;
      const initialCheckpointIds = messages
        .slice(targetIndex)
        .filter((message) => message.role === "user" && message.checkpointId)
        .map((message) => message.checkpointId as string);
      const convId = key !== PENDING_SESSION_KEY ? key : undefined;
      const capturedInputState = ctx.runtimeInputStateRef.current[key]
        ? { ...ctx.runtimeInputStateRef.current[key] }
        : undefined;
      const capturedSessionRef = ctx.sessionsRefData.current.get(key);
      const defaults = ctx.globalModeDefaultsRef.current;
      let capturedWorktreeMode =
        capturedSessionRef?.worktreeMode ?? defaults.worktreeMode;
      let capturedPlanMode =
        capturedSessionRef?.planMode ?? defaults.planMode;
      let capturedGoalMode =
        capturedSessionRef?.goalMode ?? defaults.goalMode;
      const capturedGoalModeTokenBudget =
        capturedSessionRef?.goalModeTokenBudget ?? defaults.goalModeTokenBudget;
      if (capturedWorktreeMode) {
        capturedPlanMode = false;
        capturedGoalMode = false;
      } else if (capturedPlanMode) {
        capturedGoalMode = false;
      }

      // Delete the entire conversation only when this is the true first user
      // message in the complete history. A compaction boundary and the first item
      // in a paginated window must always use range truncation instead.
      const hasUserMessageBefore = messages
        .slice(0, targetIndex)
        .some((m) => m.role === "user");
      const isFirstMessage =
        !targetMessage.isContextCompaction &&
        !session.hasMoreMessages &&
        !hasUserMessageBefore;

      // Normal user messages roll back from their following assistant response.
      // A compaction boundary is persisted as a user message with its own response id,
      // so rolling back that boundary must target the boundary row itself.
      //
      // 失败/中断轮次的 assistant 消息没有 provider responseId（持久化时
      // response_id 为空），无法用 responseId 定位截断边界。因此优先使用
      // 用户消息自身的持久化 DB ID（snowflake 数字 id，消息持久化后前端
      // id 会被替换为数据库 id）作为边界：truncateConversationFromMessage
      // 从该行开始删除该轮及之后的所有消息。找不到持久化 id（消息尚未
      // 落库）时才回退到向后寻找非空 responseId 的旧逻辑。
      let responseId = targetMessage.isContextCompaction
        ? targetMessage.responseId
        : undefined;
      let persistedMessageId: string | undefined;
      if (!targetMessage.isContextCompaction && targetMessage.id) {
        // snowflake id 是 64 位大整数（可能超过 Number.MAX_SAFE_INTEGER），
        // 这里只区分"数字 id"与前端临时 id（"user-{ts}-{rand}"），不参与
        // 数值运算，用 isInteger 即可。
        if (Number.isInteger(Number(targetMessage.id))) {
          persistedMessageId = targetMessage.id;
        }
      }
      if (!responseId && !persistedMessageId) {
        for (let i = targetIndex + 1; i < messages.length; i++) {
          if (messages[i].role === "assistant" && messages[i].responseId) {
            responseId = messages[i].responseId;
            break;
          }
        }
      }

      // Compute file changes for the confirmation dialog. This is async but
      // we set the preview state once the diff is ready.
      const computeAndPreview = async (): Promise<void> => {
        try {
          let conversationRecord: Awaited<
            ReturnType<typeof window.snow.getChatConversation>
          > = null;
          let runtimeConfig: Awaited<
            ReturnType<typeof window.snow.getConversationRuntimeConfig>
          > | null = null;
          if (convId) {
            const [recordResult, runtimeResult] = await Promise.allSettled([
              window.snow.getChatConversation(convId),
              window.snow.getConversationRuntimeConfig(convId),
            ]);
            if (recordResult.status === "fulfilled") {
              conversationRecord = recordResult.value;
            }
            if (runtimeResult.status === "fulfilled") {
              runtimeConfig = runtimeResult.value;
            }
          }
          const rollbackConversationState: RollbackConversationState = {
            model:
              capturedInputState?.model || conversationRecord?.model?.trim() || "",
            apiProfile:
              capturedInputState?.apiProfile ||
              conversationRecord?.apiProfileName?.trim() ||
              "",
            thinkingStrength: capturedInputState
              ? capturedInputState.thinkingStrength
              : runtimeConfig?.thinkingStrength ?? null,
            responsesFastMode: capturedInputState
              ? capturedInputState.responsesFastMode
              : runtimeConfig?.responsesFastMode ?? null,
            planMode: capturedPlanMode,
            goalMode: capturedGoalMode,
            worktreeMode: capturedWorktreeMode,
            goalModeTokenBudget: capturedGoalModeTokenBudget,
          };
          let checkpointIds = initialCheckpointIds;
          if (convId) {
            try {
              const fullHistory = await window.snow.listChatMessages(convId);
              const fullTargetIndex = fullHistory.findIndex(
                (record) => record.id === messageId
              );
              if (fullTargetIndex >= 0) {
                checkpointIds = fullHistory
                  .slice(fullTargetIndex)
                  .filter(
                    (record) => record.role === "user" && record.checkpointId
                  )
                  .map((record) => record.checkpointId as string);
              }
            } catch {
              // 使用当前已加载消息作为回退，仍保持消息数组顺序。
            }
          }
          checkpointIds = [...new Set(checkpointIds)];

          let changes: CheckpointFileChange[] = [];
          if (checkpointIds.length > 0 && sessionWorkDir) {
            try {
              changes = await window.snow.listCheckpointChangesBatch(
                checkpointIds,
                sessionWorkDir
              );
            } catch {
              // Best effort — show dialog without changes on error
            }
          }

          // TODO 检测需要边界后的第一条 assistant responseId：todo_items 按
          // response_id 关联创建它的响应。截断边界优先使用持久化消息 id
          // （失败轮次没有 responseId），此时 responseId 为空，这里为 TODO
          // 检测单独向前寻找 —— 与截断删除的 id 范围语义一致。
          let todoBoundaryResponseId = responseId;
          if (!todoBoundaryResponseId) {
            for (let i = targetIndex + 1; i < messages.length; i++) {
              if (messages[i].role === "assistant" && messages[i].responseId) {
                todoBoundaryResponseId = messages[i].responseId;
                break;
              }
            }
          }

          // Fetch TODO items that will be deleted alongside the rollback.
          let todoItems: RollbackTodoItem[] = [];
          if (convId && todoBoundaryResponseId) {
            try {
              const todoJson = await window.snow.listTodosForRollback(
                convId,
                todoBoundaryResponseId
              );
              const parsed = JSON.parse(todoJson) as unknown;
              if (Array.isArray(parsed)) {
                todoItems = parsed
                  .filter(
                    (item): item is Record<string, unknown> =>
                      typeof item === "object" && item !== null
                  )
                  .map((item) => ({
                    id: typeof item.id === "string" ? item.id : "",
                    content:
                      typeof item.content === "string" ? item.content : "",
                    status:
                      typeof item.status === "string" ? item.status : "pending",
                  }))
                  .filter((item) => item.id);
              }
            } catch {
              // Best effort — show empty on error
            }
          }

          // 异步查询完成时用户可能已切换到同项目的另一个会话，或又发起了
          // 一次回滚。只允许仍属于当前活动会话的最新请求打开弹窗。
          if (
            rollbackRequestIdRef.current !== requestId ||
            (ctx.activeConversationIdRef.current ?? PENDING_SESSION_KEY) !== key
          ) {
            return;
          }

          ctx.setRollbackPreview({
            requestId,
            sessionKey: key,
            messageId,
            messageContent,
            changes,
            checkpointIds,
            checkpointId: checkpointIds[0],
            workDir: sessionWorkDir,
            directoryId: capturedSessionRef?.directoryId,
            convId,
            responseId,
            persistedMessageId,
            rollbackConversationState,
            isFirstMessage,
            isContextCompaction: targetMessage.isContextCompaction === true,
            todoItems,
            streamPromise:
              ctx.sessionsRefData.current.get(key)?.streamPromise ?? null,
            summaryPromise:
              ctx.sessionsRefData.current.get(key)?.summaryPromise ?? null,
          });
        } finally {
          if (rollbackRequestIdRef.current === requestId) {
            setPreparingMessageId(null);
          }
        }
      };

      void computeAndPreview();
    },
    [
      ctx.directoryPath,
      ctx.updateSessionField,
      ctx.removeStreamingId,
      ctx.activeConversationIdRef,
      ctx.sessionsRefData,
      ctx.sessionsRef,
      ctx.runtimeInputStateRef,
      ctx.globalModeDefaultsRef,
      ctx.setRollbackPreview,
    ]
  );

  const confirmRollback = useCallback(
    async (mode: RollbackMode): Promise<void> => {
      const preview = ctx.rollbackPreview;
      if (
        !preview ||
        rollbackRequestIdRef.current !== preview.requestId
      ) {
        return;
      }

      // 确认必须使用打开弹窗时冻结的会话键，不能重新读取当前活动会话；
      // 同项目会话共享 workDir，仅靠目录无法发现串线。
      const key = preview.sessionKey;
      const {
        messageId,
        messageContent,
        checkpointIds,
        convId,
        responseId,
        persistedMessageId,
         rollbackConversationState,
         directoryId,
         isFirstMessage,
        isContextCompaction,
      } = preview;

      // Wait for any in-flight stream AND summary generation to fully settle
      // (including the Rust store_chat_exchange / update_conversation_summary
      // write transactions) before issuing delete/truncate. Without this, the
      // write transactions race and can exceed the busy_timeout, producing a
      // "database is locked" error. The promises are captured at
      // handleRollback time (before the agent loop clears them from the ref).
      const pending: Promise<unknown>[] = [];
      if (preview.streamPromise) {
        pending.push(preview.streamPromise);
      }
      if (preview.summaryPromise) {
        pending.push(preview.summaryPromise);
      }
      if (pending.length > 0) {
        await Promise.allSettled(pending);
      }
      if (rollbackRequestIdRef.current !== preview.requestId) {
        return;
      }

      // 回退是事务性的：必须先成功删除/截断持久化会话，再更新界面。
      // 持久化失败时界面消息保持原样，预览重新打开并显示错误，用户可
      // 以重试或取消，不会出现"界面已撤销但重启后消息复活"的不一致。
      try {
        if (isFirstMessage && !isContextCompaction && convId) {
          await window.snow.deleteConversation(convId);
        } else if (convId && persistedMessageId) {
          // 失败/中断轮次没有 responseId，用持久化用户消息 ID 作为边界，
          // 从该行开始删除该轮及之后的所有消息。
          ctx.updateSessionField(key, "tokenUsage", null);
          ctx.updateSessionField(key, "runTokenUsage", null);
          ctx.updateSessionField(key, "conversationTokenUsage", null);
          ctx.updateSessionField(key, "lastRunDurationMs", 0);
          await window.snow.truncateConversationFromMessage(
            convId,
            persistedMessageId
          );
          // 回滚后累计统计已无对应消息：清零 DB（覆盖而非累加），
          // 避免重启后摘要条回显与截断后的消息列表不一致。
          void window.snow
            .resetConversationRunStats(convId)
            .catch(() => {
              // 清零失败不阻塞回滚
            });
        } else if (convId && responseId) {
          ctx.updateSessionField(key, "tokenUsage", null);
          ctx.updateSessionField(key, "runTokenUsage", null);
          ctx.updateSessionField(key, "conversationTokenUsage", null);
          ctx.updateSessionField(key, "lastRunDurationMs", 0);
          await window.snow.truncateConversation(convId, responseId);
          // 回滚后累计统计已无对应消息：清零 DB（覆盖而非累加）。
          void window.snow
            .resetConversationRunStats(convId)
            .catch(() => {
              // 清零失败不阻塞回滚
            });
        }
      } catch (error) {
        ctx.setRollbackPreview({
          ...preview,
          error: getErrorMessage(error),
        });
        return;
      }

      // Persistence succeeded — now update the UI. The message list update is
      // intentionally deferred until AFTER the file restore: SSH rollback
      // restores files over SFTP and can take a while, and the confirm dialog
      // stays open with a loading button during that time. Updating the list
      // here would show the rolled-back conversation while the dialog is still
      // waiting, which feels broken. DB persistence already happened above, so
      // the UI state below cannot diverge from disk.
      // 文件检查点只作为临时清理集合使用，回滚顺序以预览阶段按消息
      // 持久化顺序收集的 checkpointIds 为准。
      if (checkpointIds.length > 0) {
        const sessionRef = ctx.sessionsRefData.current.get(key);
        if (sessionRef) {
          const discarded = new Set(checkpointIds);
          sessionRef.checkpointIds = sessionRef.checkpointIds.filter(
            (id) => !discarded.has(id)
          );
        }

        const shouldRestoreFiles =
          mode === "conversation-and-files" && Boolean(preview.workDir);
        if (shouldRestoreFiles && preview.workDir) {
          // 等待文件恢复完成再关闭对话框：SSH 回滚经 SFTP 逐文件写回，
          // 可能较慢，对话框确认按钮在此期间显示 loading。恢复失败不
          // 阻塞消息清理（best effort，与旧行为一致）。
          try {
            await window.snow.restoreCheckpoints(
              checkpointIds,
              preview.workDir
            );
          } catch {
            // Best effort — file restore failure must not block rollback cleanup.
          } finally {
            ctx.setConversationVersion((version) => version + 1);
            deleteCheckpoints(checkpointIds);
          }
        } else {
          deleteCheckpoints(checkpointIds);
        }
      }

      // 文件恢复完成后再更新消息列表：弹窗此时仍打开（确认按钮 loading），
      // 列表变化与弹窗关闭同步发生，避免"消息已回滚但弹窗还停着"的割裂。
      ctx.updateSessionMessages(key, (currentMessages) => {
        const targetIndex = currentMessages.findIndex(
          (message) => message.id === messageId
        );
        return targetIndex === -1
          ? currentMessages
          : currentMessages.slice(0, targetIndex);
      });

      const targetWasActive =
        (ctx.activeConversationIdRef.current ?? PENDING_SESSION_KEY) === key;
      if (isFirstMessage && !isContextCompaction && convId) {
        // 会话已被删除：刷新侧边栏列表，移除该会话。只有目标仍是活动会话
        // 时才清空 activeId，不能影响用户已切换到的另一个并行会话。
        ctx.setConversationListVersion((version) => version + 1);
        ctx.sessionsRefData.current.delete(key);
        ctx.setSessions((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
        if (targetWasActive) {
          const rollbackState = rollbackConversationState;
          ctx.ensureSession(
            PENDING_SESSION_KEY,
            directoryId ?? ctx.directoryId
          );
          const pendingRef = ctx.sessionsRefData.current.get(
            PENDING_SESSION_KEY
          );
          if (pendingRef) {
            pendingRef.planMode = rollbackState.planMode;
            pendingRef.goalMode = rollbackState.goalMode;
            pendingRef.worktreeMode = rollbackState.worktreeMode;
            pendingRef.goalModeTokenBudget = rollbackState.goalModeTokenBudget;
          }
          ctx.runtimeInputStateRef.current[PENDING_SESSION_KEY] = {
            model: rollbackState.model,
            apiProfile: rollbackState.apiProfile,
            thinkingStrength: rollbackState.thinkingStrength,
            responsesFastMode: rollbackState.responsesFastMode,
          };
          ctx.planModeRef.current = rollbackState.planMode;
          ctx.goalModeRef.current = rollbackState.goalMode;
          ctx.worktreeModeRef.current = rollbackState.worktreeMode;
          ctx.setPlanModeState(rollbackState.planMode);
          ctx.setGoalModeState(rollbackState.goalMode);
          ctx.setWorktreeModeState(rollbackState.worktreeMode);
          ctx.setGoalModeTokenBudgetState(rollbackState.goalModeTokenBudget);
          ctx.setRollbackNewChatState(rollbackState);
          ctx.setActiveId(undefined);
        }
      } else {
        // Bump version so dependent components (user-message rail) re-fetch
        // the updated message list after truncation.
        ctx.setConversationVersion((version) => version + 1);
        // 截断会改变会话记录（消息数/预览/更新时间）：同步侧边栏列表
        ctx.setConversationListVersion((version) => version + 1);
      }

      if (!isContextCompaction && targetWasActive) {
        ctx.setDraftToRestore(messageContent);
      }
      ctx.setRollbackPreview((current) =>
        current?.requestId === preview.requestId ? null : current
      );
    },
    [
      ctx.rollbackPreview,
      ctx.directoryPath,
      ctx.updateSessionField,
      ctx.updateSessionMessages,
      ctx.setConversationVersion,
      ctx.setConversationListVersion,
      ctx.setActiveId,
      ctx.setDraftToRestore,
      ctx.setRollbackPreview,
      ctx.setRollbackNewChatState,
      ctx.ensureSession,
      ctx.setPlanModeState,
      ctx.setGoalModeState,
      ctx.setWorktreeModeState,
      ctx.setGoalModeTokenBudgetState,
      ctx.runtimeInputStateRef,
      ctx.planModeRef,
      ctx.goalModeRef,
      ctx.worktreeModeRef,
      ctx.sessionsRefData,
      ctx.setSessions,
      ctx.activeConversationIdRef,
    ]
  );

  const cancelRollback = useCallback((): void => {
    rollbackRequestIdRef.current += 1;
    setPreparingMessageId(null);
    ctx.setRollbackPreview(null);
  }, [ctx.setRollbackPreview]);

  return {
    clearDraftToRestore,
    handleRollback,
    confirmRollback,
    cancelRollback,
    preparingMessageId,
  };
};
