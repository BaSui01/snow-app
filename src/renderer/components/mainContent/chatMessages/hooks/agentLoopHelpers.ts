import type {
  ResponsesApiStreamChunk,
  TokenUsage,
} from "../../../../../preload/types/api";
import type {
  ConversationContextValue,
  ChatConversationMessage,
  HookExecutionRecord,
  VisionAnalysisState,
} from "../utils/conversationTypes";
import { formatMessageTime } from "../utils/conversationHelpers";
import { appendHookExecutionToMessage } from "./hookOutcome";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PLAN_APPROVAL_TOOL_NAME = "app-control-requestApproval";
export const PARENT_PLAN_APPROVAL_REQUIRED = "PARENT_PLAN_APPROVAL_REQUIRED";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export const isStructuredPlanApproval = (
  toolName: string,
  result: string,
): boolean => {
  if (toolName !== PLAN_APPROVAL_TOOL_NAME) {
    return false;
  }

  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    return parsed.approved === true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// Factory: isRunCancelled
// ---------------------------------------------------------------------------

/**
 * Returns a predicate that detects whether the current run has been
 * superseded -- either by an explicit abort (isAbortRequested), by a newer
 * send/abort that incremented runId, or because the session ref was deleted.
 */
export const createIsRunCancelled = (
  ctx: ConversationContextValue,
  currentRunId: number,
) => {
  return (key: string): boolean => {
    const r = ctx.sessionsRefData.current.get(key);
    return !r || r.isAbortRequested || r.runId !== currentRunId;
  };
};

// ---------------------------------------------------------------------------
// Helper: remapPersistedUserMessageIds
// ---------------------------------------------------------------------------

/**
 * Replace the frontend-generated temporary user message ids with the real
 * database snowflake ids returned by the backend (persistedUserMessageIds).
 * The backend persists user messages in order and returns their ids in the
 * same order, so the pending (non-numeric) user message ids are mapped 1:1.
 * This keeps the in-memory message ids in sync with the DB so features like
 * the user-message rail (which queries the DB for message ids) can locate
 * the DOM element by id. Returns the id remap (old frontend id -> DB id) so
 * callers can update outer-scope references if needed.
 */
export const remapPersistedUserMessageIds = (
  ctx: ConversationContextValue,
  sessionKey: string,
  persistedUserMessageIds: string[],
): ReadonlyMap<string, string> => {
  if (!persistedUserMessageIds || persistedUserMessageIds.length === 0) {
    return new Map();
  }

  // Collect all pending (non-persisted) user message ids in order so we can
  // map them 1:1 to the returned DB ids.
  const pendingUserIds: string[] = [];
  const currentMessages = ctx.sessionsRef.current[sessionKey]?.messages ?? [];
  for (const m of currentMessages) {
    if (m.role === "user" && !m.isContextCompaction) {
      // A user message is "pending" (needs id replacement) if its id
      // does not look like a DB snowflake id. Frontend ids use the
      // pattern "user-{timestamp}-{random}"; DB ids are numeric
      // snowflake strings.
      const isFrontendId = isNaN(Number(m.id));
      if (isFrontendId) {
        pendingUserIds.push(m.id);
      }
    }
  }

  // Build a mapping from old frontend id -> new DB id. The backend
  // returns ids in the same order as the user messages in the request.
  const idRemap = new Map<string, string>();
  const remapCount = Math.min(
    pendingUserIds.length,
    persistedUserMessageIds.length,
  );
  for (let i = 0; i < remapCount; i++) {
    idRemap.set(pendingUserIds[i], persistedUserMessageIds[i]);
  }

  if (idRemap.size > 0) {
    ctx.updateSessionMessages(sessionKey, (msgs) =>
      msgs.map((m) => {
        const newId = idRemap.get(m.id);
        // idRemappedFrom：渲染层标记（不持久化），让迁移后的新消息在
        // ChatMessageList / VirtualizedMessage 中不被当作"首次出现"——
        // 避免整条消息重新挂载时重播入场动画与占位符高度跳变。
        return newId ? { ...m, id: newId, idRemappedFrom: m.id } : m;
      }),
    );
  }

  return idRemap;
};

// ---------------------------------------------------------------------------
// Factory: awaitHookDecision
// ---------------------------------------------------------------------------

/**
 * Creates a function that pauses the agent loop until the user resolves a
 * hook decision gate (approve / reject). The decision record is written into
 * the target assistant message and the runtime resolver is registered in
 * ctx.pendingHookDecisionRef so handleAbort can settle it externally.
 */
export const createAwaitHookDecision = (ctx: ConversationContextValue) => {
  return async (
    key: string,
    messageId: string,
    record: HookExecutionRecord,
  ): Promise<boolean> => {
    const decisionId = `${messageId}-${
      record.hookType
    }-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const approved = await new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (decision: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        ctx.pendingHookDecisionRef.current.delete(decisionId);
        resolve(decision);
      };

      ctx.pendingHookDecisionRef.current.set(decisionId, {
        sessionKey: key,
        resolve: settle,
      });
      ctx.updateSessionMessages(key, (currentMessages) =>
        appendHookExecutionToMessage(
          currentMessages,
          {
            ...record,
            _decisionId: decisionId,
            _resolveDecision: settle,
          },
          messageId,
        ),
      );
    });

    ctx.updateSessionMessages(key, (currentMessages) =>
      currentMessages.map((currentMessage) =>
        currentMessage.id === messageId
          ? {
              ...currentMessage,
              hookExecutions: (currentMessage.hookExecutions ?? []).map(
                (execution) =>
                  execution._decisionId === decisionId
                    ? {
                        ...execution,
                        pendingDecision: false,
                        status: approved ? "pass" : "abort",
                        _resolveDecision: undefined,
                      }
                    : execution,
              ),
            }
          : currentMessage,
      ),
    );
    return approved;
  };
};

// ---------------------------------------------------------------------------
// Streaming run metrics
// ---------------------------------------------------------------------------

/** Reset all cumulative metrics when a new user-triggered run starts.
 *  `conversationTokenUsage` / `lastRunDurationMs` are intentionally NOT
 *  reset: they accumulate across every run of the conversation. */
export const resetRunStreamMetrics = (
  ctx: ConversationContextValue,
  sessionKey: string,
): void => {
  ctx.updateSessionField(sessionKey, "streamTokenCount", 0);
  ctx.updateSessionField(sessionKey, "streamElapsedMs", 0);
  ctx.updateSessionField(sessionKey, "streamTtftMs", 0);
  ctx.updateSessionField(sessionKey, "runTtftMs", 0);
  ctx.updateSessionField(sessionKey, "runTtftSumMs", 0);
  ctx.updateSessionField(sessionKey, "runRequestCount", 0);
  ctx.updateSessionField(sessionKey, "runTokenUsage", null);
  const refSession = ctx.sessionsRefData.current.get(sessionKey);
  if (refSession) {
    refSession.iterationTokenCount = 0;
    refSession.iterationElapsedMs = 0;
    refSession.runTokenUsage = null;
    refSession.runTtftSumMs = 0;
    refSession.runRequestCount = 0;
  }
};

/** Reset per-iteration transient probes before each agent-loop iteration
 *  (every `createResponseStream` call). Unlike `resetRunStreamMetrics` this
 *  must NOT touch run-level metrics (`runTtftMs` / `runTokenUsage`), which
 *  accumulate across the whole run and feed the run summary. Called at the
 *  top of the main loop and the sub-agent loop so StreamMetrics' token
 *  count, tok/s and TTFT restart from zero on every iteration. */
export const resetIterationStreamMetrics = (
  ctx: ConversationContextValue,
  sessionKey: string,
): void => {
  ctx.updateSessionField(sessionKey, "streamTokenCount", 0);
  ctx.updateSessionField(sessionKey, "streamElapsedMs", 0);
  ctx.updateSessionField(sessionKey, "streamTtftMs", 0);
  const refSession = ctx.sessionsRefData.current.get(sessionKey);
  if (refSession) {
    refSession.iterationTokenCount = 0;
    refSession.iterationElapsedMs = 0;
  }
};

/** Accumulate a single-request usage into the run-level totals. Each
 *  response.tokenUsage covers one request only, so the run summary needs
 *  the sum across every iteration of the agent loop. */
export const accumulateRunTokenUsage = (
  ctx: ConversationContextValue,
  sessionKey: string,
  usage: TokenUsage | null | undefined,
): void => {
  if (!usage) {
    return;
  }
  const current = ctx.sessionsRef.current?.[sessionKey]?.runTokenUsage;
  const next: TokenUsage = {
    inputTokens: (current?.inputTokens ?? 0) + (usage.inputTokens ?? 0),
    outputTokens: (current?.outputTokens ?? 0) + (usage.outputTokens ?? 0),
    cacheCreationInputTokens:
      (current?.cacheCreationInputTokens ?? 0) +
      (usage.cacheCreationInputTokens ?? 0),
    cacheReadInputTokens:
      (current?.cacheReadInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0),
  };
  ctx.updateSessionField(sessionKey, "runTokenUsage", next);
  // 同步写 ref 镜像：state 的 setState 异步，收尾（finally）同步读取时
  // 可能滞后一个渲染周期，ref 版本保证持久化拿到完整累计值。
  const refSession = ctx.sessionsRefData.current.get(sessionKey);
  if (refSession) {
    refSession.runTokenUsage = next;
  }
};

/** Fold a finished run's usage + wall-clock duration into the conversation's
 *  cumulative totals (in-memory mirror of the persisted run_* columns).
 *  Called once when the agent loop ends; `runUsage` must be the run-level
 *  ref mirror so it is complete even when the state update lags. */
export const accumulateConversationRunStats = (
  ctx: ConversationContextValue,
  sessionKey: string,
  runUsage: TokenUsage | null | undefined,
  runDurationMs: number,
  runTtftSumMs: number,
  runRequestCount: number,
): void => {
  const current = ctx.sessionsRef.current?.[sessionKey]?.conversationTokenUsage;
  ctx.updateSessionField(sessionKey, "conversationTokenUsage", {
    inputTokens: (current?.inputTokens ?? 0) + (runUsage?.inputTokens ?? 0),
    outputTokens: (current?.outputTokens ?? 0) + (runUsage?.outputTokens ?? 0),
    cacheCreationInputTokens:
      (current?.cacheCreationInputTokens ?? 0) +
      (runUsage?.cacheCreationInputTokens ?? 0),
    cacheReadInputTokens:
      (current?.cacheReadInputTokens ?? 0) +
      (runUsage?.cacheReadInputTokens ?? 0),
  });
  const currentDuration =
    ctx.sessionsRef.current?.[sessionKey]?.lastRunDurationMs ?? 0;
  ctx.updateSessionField(
    sessionKey,
    "lastRunDurationMs",
    currentDuration + Math.max(0, runDurationMs),
  );
  const currentTtftSum =
    ctx.sessionsRef.current?.[sessionKey]?.conversationTtftSumMs ?? 0;
  ctx.updateSessionField(
    sessionKey,
    "conversationTtftSumMs",
    currentTtftSum + Math.max(0, runTtftSumMs),
  );
  const currentRequestCount =
    ctx.sessionsRef.current?.[sessionKey]?.conversationRequestCount ?? 0;
  ctx.updateSessionField(
    sessionKey,
    "conversationRequestCount",
    currentRequestCount + Math.max(0, runRequestCount),
  );
};

// ---------------------------------------------------------------------------
// Streaming message transition
// ---------------------------------------------------------------------------

/**
 * Applies one backend stream chunk to the current assistant message. A retry
 * chunk is an attempt boundary: discard the failed partial and normalize the
 * message back to ordinary streaming without retaining transport diagnostics.
 */
export const applyStreamChunkToMessage = (
  currentMessage: ChatConversationMessage,
  chunk: ResponsesApiStreamChunk,
  timestamp: string = formatMessageTime(),
  thinkingActiveOverride?: boolean | null,
): ChatConversationMessage => {
  const {
    isRetrying: _isRetrying,
    retryAttempt: _retryAttempt,
    retryError: _retryError,
    ...ordinaryStreamingMessage
  } = currentMessage;

  if (chunk.retrying) {
    return {
      ...ordinaryStreamingMessage,
      content: "",
      thinking: undefined,
      isThinkingActive: false,
      status: "sending",
    };
  }

  const existingContent = ordinaryStreamingMessage.content;
  const nextContent =
    chunk.content || `${existingContent}${chunk.contentDelta}`;
  const nextThinking =
    chunk.thinking ||
    `${ordinaryStreamingMessage.thinking ?? ""}${chunk.thinkingDelta}`;

  // Thinking-phase live stats: the Rust backend counts thinking-only tokens
  // and brackets the thinking phase with the first/last thinking delta of the
  // iteration. Each frontend assistant message maps 1:1 to one backend
  // stream call (one agent-loop iteration), so the chunk values are already
  // cumulative for this message — overwrite when present, never regress.
  const nextThinkingTokenCount =
    chunk.thinkingTokenCount > 0
      ? chunk.thinkingTokenCount
      : (ordinaryStreamingMessage.thinkingTokenCount ?? 0);
  const nextThinkingDurationMs =
    chunk.thinkingDurationMs > 0
      ? chunk.thinkingDurationMs
      : (ordinaryStreamingMessage.thinkingDurationMs ?? 0);
  // The thinking phase is active while thinking deltas keep arriving; the
  // first content delta (or the end of the stream) marks it as finished.
  const nextIsThinkingActive =
    thinkingActiveOverride != null
      ? thinkingActiveOverride
      : chunk.thinkingDelta
        ? true
        : chunk.contentDelta || chunk.content
          ? false
          : (ordinaryStreamingMessage.isThinkingActive ?? false);

  return {
    ...ordinaryStreamingMessage,
    content: nextContent,
    thinking: nextThinking || undefined,
    thinkingDurationMs: nextThinkingDurationMs || undefined,
    thinkingTokenCount: nextThinkingTokenCount || undefined,
    isThinkingActive: nextIsThinkingActive,
    timestamp,
    status: "sending",
  };
};

// ---------------------------------------------------------------------------
// Factory: stream chunk handler
// ---------------------------------------------------------------------------

/** onChunk 回调 + 立即落地缓冲内容的 flush（流结束时调用，保证末批内容不丢）。 */
export type StreamChunkHandler = ((chunk: ResponsesApiStreamChunk) => void) & {
  flush: () => void;
};

type MergedStreamBatch = {
  contentOverride: string;
  contentDelta: string;
  thinkingOverride: string;
  thinkingDelta: string;
  thinkingTokenCount: number;
  thinkingDurationMs: number;
  ttftMs: number;
  thinkingActive: boolean | null;
  last: ResponsesApiStreamChunk;
};

const mergeStreamChunks = (
  batch: ResponsesApiStreamChunk[],
): MergedStreamBatch => {
  let contentOverride = "";
  let contentDelta = "";
  let thinkingOverride = "";
  let thinkingDelta = "";
  let thinkingTokenCount = 0;
  let thinkingDurationMs = 0;
  let ttftMs = 0;
  let thinkingActive: boolean | null = null;
  for (const chunk of batch) {
    if (chunk.content) {
      contentOverride = chunk.content;
      contentDelta = "";
    } else if (chunk.contentDelta) {
      contentDelta += chunk.contentDelta;
    }
    if (chunk.thinking) {
      thinkingOverride = chunk.thinking;
      thinkingDelta = "";
    } else if (chunk.thinkingDelta) {
      thinkingDelta += chunk.thinkingDelta;
    }
    if (chunk.thinkingDelta) {
      thinkingActive = true;
    } else if (chunk.contentDelta || chunk.content) {
      thinkingActive = false;
    }
    if (chunk.thinkingTokenCount > 0) {
      thinkingTokenCount = chunk.thinkingTokenCount;
    }
    if (chunk.thinkingDurationMs > 0) {
      thinkingDurationMs = chunk.thinkingDurationMs;
    }
    if (ttftMs === 0 && chunk.ttftMs > 0) {
      ttftMs = chunk.ttftMs;
    }
  }
  return {
    contentOverride,
    contentDelta,
    thinkingOverride,
    thinkingDelta,
    thinkingTokenCount,
    thinkingDurationMs,
    ttftMs,
    thinkingActive,
    last: batch[batch.length - 1],
  };
};

/** rAF 在窗口被遮挡/最小化时会停摆，用定时器兜底保证缓冲内容仍会落地。 */
const CHUNK_FLUSH_FALLBACK_MS = 100;

/**
 * Creates the onChunk callback for createResponseStream. Handles real-time
 * token probe updates, retry resets, and incremental content/thinking deltas.
 * Shared between the main agent loop and the sub-agent loop.
 *
 * Incoming chunks are buffered and applied once per animation frame: IPC
 * delivers one callback per token, and applying each one immediately forced a
 * full-provider re-render at token rate — with several sessions streaming in
 * parallel that saturates the renderer. Frame-batched application also lets
 * React coalesce updates from every concurrently streaming session into a
 * single render pass.
 */
export const createStreamChunkHandler = (
  ctx: ConversationContextValue,
  sessionKey: string,
  assistantMessageId: string,
  isCancelled: () => boolean,
): StreamChunkHandler => {
  const refSession = ctx.sessionsRefData.current.get(sessionKey);
  const iterationTokenBase = refSession?.iterationTokenCount ?? 0;
  const iterationElapsedBase = refSession?.iterationElapsedMs ?? 0;

  // 流式指标（token 数/耗时）降频更新：它们只驱动 StreamMetrics 显示，
  // 每 chunk 更新会连带触发 context 消费方重渲染；250ms 合并一次对显示
  // 精度无感，但把每 chunk 的 setState 次数从 3 次降到 1 次（消息更新）。
  let lastMetricsAt = 0;
  const METRICS_UPDATE_INTERVAL_MS = 250;
  // 本次迭代的 TTFT 是否已计入 run 级总和（每次迭代只记一次）。
  let iterationTtftRecorded = false;

  const pendingChunks: ResponsesApiStreamChunk[] = [];
  let scheduledFrame = 0;
  let fallbackTimer = 0;

  const cancelScheduledFlush = (): void => {
    if (scheduledFrame !== 0) {
      cancelAnimationFrame(scheduledFrame);
      scheduledFrame = 0;
    }
    if (fallbackTimer !== 0) {
      window.clearTimeout(fallbackTimer);
      fallbackTimer = 0;
    }
  };

  const applyChunkToSession = (
    chunk: ResponsesApiStreamChunk,
    thinkingActive: boolean | null,
  ): void => {
    const runTokenCount = iterationTokenBase + chunk.streamTokenCount;
    const runElapsedMs = iterationElapsedBase + chunk.elapsedMs;
    // ref 同步累加（后续迭代依赖），context 字段走降频。
    if (refSession) {
      refSession.iterationTokenCount = runTokenCount;
      refSession.iterationElapsedMs = runElapsedMs;
    }
    const now = Date.now();
    if (now - lastMetricsAt >= METRICS_UPDATE_INTERVAL_MS) {
      lastMetricsAt = now;
      ctx.updateSessionField(sessionKey, "streamTokenCount", runTokenCount);
      ctx.updateSessionField(sessionKey, "streamElapsedMs", runElapsedMs);
    }
    const ttftMs = chunk.ttftMs;
    if (
      ttftMs > 0 &&
      (ctx.sessionsRef.current[sessionKey]?.streamTtftMs ?? 0) === 0
    ) {
      ctx.updateSessionField(sessionKey, "streamTtftMs", ttftMs);
    }
    if (
      ttftMs > 0 &&
      (ctx.sessionsRef.current[sessionKey]?.runTtftMs ?? 0) === 0
    ) {
      ctx.updateSessionField(sessionKey, "runTtftMs", ttftMs);
    }
    // 每次迭代（一个 createResponseStream 调用）只累加一次 TTFT：本次迭代的
    // 首个 TTFT 到达时记入 run 级总和与请求数，收尾时折算进会话累计平均。
    if (ttftMs > 0 && !iterationTtftRecorded) {
      iterationTtftRecorded = true;
      if (refSession) {
        refSession.runTtftSumMs += ttftMs;
        refSession.runRequestCount += 1;
      }
      ctx.updateSessionField(
        sessionKey,
        "runTtftSumMs",
        (ctx.sessionsRef.current[sessionKey]?.runTtftSumMs ?? 0) + ttftMs,
      );
      ctx.updateSessionField(
        sessionKey,
        "runRequestCount",
        (ctx.sessionsRef.current[sessionKey]?.runRequestCount ?? 0) + 1,
      );
    }

    ctx.updateSessionMessages(sessionKey, (currentMessages) =>
      currentMessages.map((currentMessage) =>
        currentMessage.id === assistantMessageId
          ? applyStreamChunkToMessage(
              currentMessage,
              chunk,
              undefined,
              thinkingActive,
            )
          : currentMessage,
      ),
    );
  };

  const applyMergedBatch = (batch: ResponsesApiStreamChunk[]): void => {
    const merged = mergeStreamChunks(batch);
    applyChunkToSession(
      {
        ...merged.last,
        content: merged.contentOverride
          ? `${merged.contentOverride}${merged.contentDelta}`
          : "",
        contentDelta: merged.contentOverride ? "" : merged.contentDelta,
        thinking: merged.thinkingOverride
          ? `${merged.thinkingOverride}${merged.thinkingDelta}`
          : "",
        thinkingDelta: merged.thinkingOverride ? "" : merged.thinkingDelta,
        thinkingTokenCount: merged.thinkingTokenCount,
        thinkingDurationMs: merged.thinkingDurationMs,
        ttftMs: merged.ttftMs,
        retrying: false,
      },
      merged.thinkingActive,
    );
  };

  const flush = (): void => {
    cancelScheduledFlush();
    if (pendingChunks.length === 0) {
      return;
    }
    const batch = pendingChunks.splice(0, pendingChunks.length);
    applyMergedBatch(batch);
  };

  const scheduleFlush = (): void => {
    if (scheduledFrame === 0) {
      scheduledFrame = requestAnimationFrame(() => {
        scheduledFrame = 0;
        flush();
      });
    }
    if (fallbackTimer === 0) {
      fallbackTimer = window.setTimeout(() => {
        fallbackTimer = 0;
        flush();
      }, CHUNK_FLUSH_FALLBACK_MS);
    }
  };

  const handler = ((chunk: ResponsesApiStreamChunk): void => {
    // External-vision textify progress event: update the session-level
    // visionAnalysis field only, never touch message content. The backend
    // pushes these chunks while it describes user images with the external
    // vision model (before the first content delta arrives).
    //
    // This is processed BEFORE the isCancelled() early return: when the user
    // aborts mid-textify, the backend pushes a final cancel/done/error event
    // to recycle the "vision model analyzing image" status card — skipping it
    // would leave the card stuck forever. Cancelled runs only apply clearing
    // events (cancel/done/error): a stale describing/cached event from the
    // old run must not resurrect the card nor clobber a newer run's state.
    if (chunk.visionStatus) {
      try {
        const parsed = JSON.parse(chunk.visionStatus) as VisionAnalysisState;
        // describing/cached → show the intermediate status card; done with
        // remaining images → keep the card (the next describing event will
        // advance the index); done on the last image / error / cancel → clear.
        const keep =
          parsed.phase === "describing" ||
          parsed.phase === "cached" ||
          (parsed.phase === "done" && parsed.index < parsed.total);
        if (!isCancelled() || !keep) {
          ctx.updateSessionField(
            sessionKey,
            "visionAnalysis",
            keep ? parsed : undefined,
          );
        }
      } catch {
        // Ignore unparseable vision status payloads.
      }
      return;
    }

    if (isCancelled()) {
      return;
    }

    // Retry chunks reset the message to an empty partial: they must land in
    // order, never merged with the deltas buffered before/after them.
    if (chunk.retrying) {
      flush();
      applyChunkToSession(chunk, null);
      return;
    }

    pendingChunks.push(chunk);
    scheduleFlush();
  }) as StreamChunkHandler;

  handler.flush = flush;
  return handler;
};

// ---------------------------------------------------------------------------
// Factory: stream id handler
// ---------------------------------------------------------------------------

/**
 * Creates the onStreamId callback for createResponseStream. Stores the stream
 * id on the session ref and immediately aborts if the run was already
 * cancelled before the stream started.
 */
export const createStreamIdHandler = (
  ctx: ConversationContextValue,
  sessionKey: string,
  isCancelled: () => boolean,
) => {
  return (streamId: string): void => {
    const ref = ctx.sessionsRefData.current.get(sessionKey);
    if (ref) {
      ref.streamId = streamId;
      if (isCancelled()) {
        // A stream that is aborted the moment it starts produces NO content,
        // NO error and NO log — the user just sees the run stop mid-flight
        // ("it suddenly stopped outputting"). Record which clause of
        // createIsRunCancelled fired so the next occurrence is diagnosable.
        const liveRef = ctx.sessionsRefData.current.get(sessionKey);
        const reason = !liveRef
          ? "session-ref-missing"
          : liveRef.isAbortRequested
            ? "abort-requested"
            : `runId-changed(live=${liveRef.runId})`;
        void window.snow.writeLog("WARN", {
          module: "chat/stream",
          func: "createStreamIdHandler",
          message: "Stream aborted on start: run already superseded",
          context: JSON.stringify({ sessionKey, streamId, reason }),
        });
        void window.snow.abortResponseStream(streamId);
      }
    }
  };
};
