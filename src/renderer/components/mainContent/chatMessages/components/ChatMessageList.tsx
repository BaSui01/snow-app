import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { GitFork, Zap } from "lucide-react";
import { useI18n } from "../../../../i18n";
import { ChatRunSummary } from "./ChatRunSummary";
import { ChatStreamIndicator } from "./ChatStreamIndicator";
import { VirtualizedMessage } from "./VirtualizedMessage";
import type { ChatConversationMessage } from "../utils/conversationTypes";
import { useViewportVirtualization } from "../hooks/useViewportVirtualization";
import { useChatConversationContext } from "./ChatConversationContext";
import {
  directoryIdToPath,
  resolveConversationWorkspacePath,
} from "../utils/conversationHelpers";
import {
  createChatFileArtifactCollector,
  type ChatFileArtifact,
} from "./chatFileArtifacts";

type ChatMessageListProps = {
  messages: ChatConversationMessage[];
  isStreaming: boolean;
  isAborting: boolean;
  isRunActive: boolean;
  canRollback: boolean;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  /** 平滑增长视口的回调 ref（由滚动跟随控制器持有平滑器）。 */
  streamViewportRef: (node: HTMLDivElement | null) => void;
};

// 初始可见窗口大小:挂载时(切换会话)只渲染「顶部几条 + 底部窗口」的
// 真实内容,避免首帧同步全量渲染大会话阻塞主线程。窗口按可见消息计数
// (跳过 tool 消息),数值取小足够覆盖首屏 + 初始定位到底部后的视口。
const INITIAL_VIRTUAL_HEAD_COUNT = 3;
const INITIAL_VIRTUAL_WINDOW_SIZE = 24;

export const ChatMessageList = ({
  messages,
  isStreaming,
  isAborting,
  isRunActive,
  canRollback,
  scrollContainerRef,
  streamViewportRef,
}: ChatMessageListProps): React.JSX.Element => {
  const { locale, t } = useI18n();
  const {
    activeConversationId,
    conversationDirectoryId,
    conversationWorktreeMode,
    conversationWorktreeId,
    isLoadingInitialHistory,
    sessionViewKey,
    handleForkConversation,
    handleSelectConversation,
    handleRollback,
    rollbackPreparingMessageId,
    forkedFromConversationId,
    forkMessageCount,
    pendingToolAuthorizations,
    approveToolAuthorization,
    approveToolAuthorizationAlways,
    rejectToolAuthorization,
    updateSessionMessages,
    visionAnalysis,
    triggeredByTask,
    conversationTokenUsage,
    lastRunDurationMs,
    conversationTtftSumMs,
    conversationRequestCount,
  } = useChatConversationContext();

  const artifactBinding = useMemo(
    () => ({
      conversationId: activeConversationId,
      directoryId: conversationDirectoryId,
      worktreeMode: conversationWorktreeMode,
      worktreeId: conversationWorktreeId,
      ready:
        Boolean(activeConversationId && conversationDirectoryId) &&
        conversationWorktreeMode !== undefined &&
        !isLoadingInitialHistory,
    }),
    [
      activeConversationId,
      conversationDirectoryId,
      conversationWorktreeMode,
      conversationWorktreeId,
      isLoadingInitialHistory,
      sessionViewKey,
    ],
  );
  const [resolvedArtifactWorkspace, setResolvedArtifactWorkspace] = useState<{
    binding: typeof artifactBinding;
    path: string | undefined;
  }>();
  useEffect(() => {
    if (!artifactBinding.ready || !artifactBinding.conversationId) return;
    let cancelled = false;
    void resolveConversationWorkspacePath(
      artifactBinding.conversationId,
      artifactBinding.directoryId,
      directoryIdToPath(artifactBinding.directoryId),
      artifactBinding.worktreeMode,
      artifactBinding.worktreeId,
    ).then(
      (path) => {
        if (!cancelled)
          setResolvedArtifactWorkspace({ binding: artifactBinding, path });
      },
      () => {
        // Invalid/missing WorkTree bindings must never fall back to the project root.
        if (!cancelled)
          setResolvedArtifactWorkspace({
            binding: artifactBinding,
            path: undefined,
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [artifactBinding]);
  // Invalidate synchronously on a switch, before passive effects can read an old file.
  const artifactWorkspace =
    resolvedArtifactWorkspace?.binding === artifactBinding
      ? resolvedArtifactWorkspace.path
      : undefined;
  const collectArtifacts = useMemo(
    () => createChatFileArtifactCollector(),
    [artifactBinding],
  );
  const previousArtifacts = useRef(
    new Map<string, readonly ChatFileArtifact[]>(),
  );
  // Even absolute paths are withheld until the session's execution binding is known.
  const collectedArtifacts = useMemo(
    () =>
      artifactWorkspace ? collectArtifacts(messages, artifactWorkspace) : [],
    [messages, artifactWorkspace, collectArtifacts],
  );
  // 文件卡片默认隐藏，仅渲染用户手动展开的
  const [revealedArtifacts, setRevealedArtifacts] = useState<
    ReadonlySet<string>
  >(() => new Set());
  useEffect(() => {
    setRevealedArtifacts(new Set());
  }, [artifactBinding]);
  const collectedArtifactsRef = useRef(collectedArtifacts);
  collectedArtifactsRef.current = collectedArtifacts;
  const toggleFileArtifact = useCallback(
    (key: string, open?: boolean): boolean => {
      if (!collectedArtifactsRef.current.some((item) => item.key === key)) {
        return false;
      }
      setRevealedArtifacts((prev) => {
        const has = prev.has(key);
        const next = open ?? !has;
        if (next === has) return prev;
        const updated = new Set(prev);
        if (next) updated.add(key);
        else updated.delete(key);
        return updated;
      });
      return true;
    },
    [],
  );
  const artifactsByOwner = useMemo(() => {
    const grouped = new Map<string, ChatFileArtifact[]>();
    for (const artifact of collectedArtifacts) {
      if (!revealedArtifacts.has(artifact.key)) continue;
      const list = grouped.get(artifact.ownerId) ?? [];
      list.push(artifact);
      grouped.set(artifact.ownerId, list);
    }
    const stable = new Map<string, readonly ChatFileArtifact[]>();
    for (const [owner, list] of grouped) {
      const previous = previousArtifacts.current.get(owner);
      stable.set(
        owner,
        previous &&
          previous.length === list.length &&
          previous.every((artifact, index) => {
            const next = list[index];
            return (
              artifact.key === next.key &&
              artifact.path === next.path &&
              artifact.ownerId === next.ownerId &&
              artifact.revision === next.revision &&
              artifact.automatic === next.automatic &&
              artifact.blocked === next.blocked &&
              artifact.isSsh === next.isSsh
            );
          })
          ? previous
          : list,
      );
    }
    previousArtifacts.current = stable;
    return stable;
  }, [collectedArtifacts, revealedArtifacts]);

  const lastAssistantMessage = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        return messages[i];
      }
    }
    return undefined;
  }, [messages]);
  const lastAssistantMessageId = lastAssistantMessage?.id;
  const isLastAssistantRetrying = Boolean(lastAssistantMessage?.isRetrying);

  // The fork divider should appear after the fork point (the messages
  // copied from the source conversation), not after all messages.
  // forkMessageCount records how many messages were copied at fork time.
  // Rendered messages exclude tool-role messages, so we need to count
  // visible messages up to that point.
  const forkDividerIndex = useMemo(() => {
    if (
      !forkedFromConversationId ||
      forkMessageCount === undefined ||
      forkMessageCount <= 0
    ) {
      return -1;
    }
    // Count visible (non-tool) messages. forkMessageCount counts all
    // DB messages including tool messages, but tool messages are filtered
    // out during rendering. We iterate the messages array and find the
    // index after the Nth visible message.
    let visibleCount = 0;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "tool") continue;
      visibleCount++;
      if (visibleCount === forkMessageCount) {
        return i + 1; // divider goes after this message
      }
    }
    // If there are fewer visible messages than forkMessageCount (e.g.
    // tool messages reduced the count), place divider at the end.
    return messages.length;
  }, [forkedFromConversationId, forkMessageCount, messages]);

  const showForkDivider =
    forkDividerIndex >= 0 && forkDividerIndex < messages.length;

  // Stable callback: MessageContent is memoized, so every prop must keep a
  // stable reference or the memo bail-out never triggers.
  const handleFork = useCallback(
    (conversationId: string, upToResponseId: string): void => {
      void handleForkConversation(conversationId, upToResponseId);
    },
    [handleForkConversation],
  );

  const handleForkLinkClick = (): void => {
    if (forkedFromConversationId) {
      void handleSelectConversation(forkedFromConversationId);
    }
  };

  const renderForkDivider = (): React.JSX.Element => (
    <div className="chat-fork-divider">
      <span className="chat-fork-divider-line" />
      <button
        type="button"
        className="chat-fork-divider-link"
        onClick={handleForkLinkClick}
      >
        <GitFork size={13} strokeWidth={1.8} />
        <span>
          {t("chat.forkedFromConversation", {
            defaultValue: "Forked from conversation",
          })}
        </span>
      </button>
      <span className="chat-fork-divider-line" />
    </div>
  );

  // Pinned message ids: the streaming (last assistant) message must always be
  // rendered so the live output is never unmounted, and any message carrying a
  // pending tool authorization must stay mounted so the approval dialog is not
  // unmounted while waiting for the user.
  const pinnedIds = useMemo(() => {
    const pinned = new Set<string>();
    if (lastAssistantMessageId) {
      pinned.add(lastAssistantMessageId);
    }
    for (const msg of messages) {
      const hasPendingAuth =
        msg.role === "assistant" &&
        msg.toolCalls?.some(
          (tc) => tc.authorizationConversationId === activeConversationId,
        );
      if (hasPendingAuth) {
        pinned.add(msg.id);
      }
    }
    return pinned;
  }, [activeConversationId, lastAssistantMessageId, messages]);

  // 挂载时的初始可见窗口(仅当列表大到窗口无法覆盖全部时才起作用):
  // 切换会话后 chat-area 整体重建,新 ChatMessageList 挂载时若以
  // visibleIds === null 起步,首次提交会同步全量渲染整个消息列表
  // (运行中的大会话可达数百毫秒),阻塞渲染进程主线程,期间 loading
  // 旋转与骨架屏脉冲等 CSS 动画全部冻结。这里直接以「顶部几条 + 底部
  // 窗口 + 固定消息」作为起始可见集,其余消息首帧即为占位符;
  // IntersectionObserver 的首次报告会把估算集合替换为真实相交集合。
  //
  // 该集合只被 useViewportVirtualization 的 useState 初始化读取一次，
  // 因此按首帧快照计算，避免每个流式帧做一次 O(消息数) 的无用重建。
  const initialVisibleIdsRef = useRef<ReadonlySet<string> | null | undefined>(
    undefined,
  );
  if (initialVisibleIdsRef.current === undefined) {
    initialVisibleIdsRef.current = (() => {
      if (messages.length === 0) {
        return null;
      }
      const ids = new Set<string>();
      let headCount = 0;
      for (
        let i = 0;
        i < messages.length && headCount < INITIAL_VIRTUAL_HEAD_COUNT;
        i++
      ) {
        if (messages[i].role === "tool") continue;
        headCount++;
        ids.add(messages[i].id);
      }
      let tailCount = 0;
      for (
        let i = messages.length - 1;
        i >= 0 && tailCount < INITIAL_VIRTUAL_WINDOW_SIZE;
        i--
      ) {
        if (messages[i].role === "tool") continue;
        tailCount++;
        ids.add(messages[i].id);
      }
      for (const id of pinnedIds) {
        ids.add(id);
      }
      return ids;
    })();
  }
  const initialVisibleIds = initialVisibleIdsRef.current;

  // eager 可见集：传给虚拟化 hook，让这些消息在 IntersectionObserver 首批
  // 报告前就以真实内容挂载（见 useViewportVirtualization 的 forceVisible
  // 机制）。两类来源：
  // 1) 翻页（loadOlder）往顶部插入的新消息前缀——若新页先以 80px 占位符
  //    存在，ChatContent 的翻页滚动恢复按占位符几何校正必然偏小，新内容
  //    涌入后再把视口内容往下挤，观感就是「被挤下去」；
  // 2) id 迁移的消息（首轮响应落库后用户消息的临时 id 被替换为数据库 id，
  //    见 remapPersistedUserMessageIds）：旧元素卸载、新元素挂载，若不在
  //    eager 集合中会先以占位符渲染一帧再切换，表现为内容跳变。
  // 判定基准是「与上一轮消息 id 集合的差集」：顶部连续新增段 + 带
  // idRemappedFrom 标记的新 id。id 被替换（而非真正新增）的消息不会把全部
  // 历史消息误判成"顶部新增"（旧实现以首条 id 变化为信号，remap 命中首条
  // 时会一路遍历到表尾、收集整表 id，导致全量强制可见）。
  const [eagerVisibleIds, setEagerVisibleIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const prevMessageIdsRef = useRef<ReadonlySet<string> | null>(null);
  useLayoutEffect(() => {
    if (messages.length === 0) {
      return;
    }
    const prevMessageIds = prevMessageIdsRef.current;
    prevMessageIdsRef.current = new Set(messages.map((message) => message.id));
    // 首次挂载不产出 eager 集合：初始窗口由 initialVisibleIds 控制，
    // 全量 eager 会废掉大会话首帧的虚拟化优化。
    if (prevMessageIds === null) {
      return;
    }
    const eager = new Set<string>();
    for (const message of messages) {
      if (message.idRemappedFrom && !prevMessageIds.has(message.id)) {
        eager.add(message.id);
      }
    }
    for (const message of messages) {
      if (prevMessageIds.has(message.id)) {
        break;
      }
      eager.add(message.id);
    }
    if (eager.size > 0) {
      setEagerVisibleIds(eager);
    }
  }, [messages]);

  const virtualization = useViewportVirtualization(
    scrollContainerRef,
    pinnedIds,
    initialVisibleIds,
    eagerVisibleIds,
  );

  // Intermediate status card shown while the backend describes user images
  // with the external vision model (textify pass). Lives at the end of the
  // message list, above the input area; disappears on the final done/error
  // event. Fixed min-height keeps the virtualization scrollbar stable.
  const renderVisionStatusCard = (): React.JSX.Element | null => {
    if (
      !visionAnalysis ||
      (visionAnalysis.phase !== "describing" &&
        visionAnalysis.phase !== "cached")
    ) {
      return null;
    }
    return (
      <div className="chat-vision-status" role="status">
        <span className="chat-vision-status-spinner" aria-hidden="true" />
        <span className="chat-vision-status-text">
          {t("chat.visionAnalyzing", {
            defaultValue: "Analyzing images with vision model…",
          })}
        </span>
        <span className="chat-vision-status-progress">
          {visionAnalysis.index}/{visionAnalysis.total}
        </span>
        {visionAnalysis.model ? (
          <span
            className="chat-vision-status-model"
            title={visionAnalysis.model}
          >
            {visionAnalysis.model}
          </span>
        ) : null}
      </div>
    );
  };

  // Informational banner shown when the active conversation was created by a
  // scheduled task firing: which task triggered it and when. Rendered above
  // the first message so the origin of the conversation is always visible.
  const renderTriggeredByTaskBanner = (): React.JSX.Element | null => {
    if (!triggeredByTask) {
      return null;
    }
    let timeLabel = "";
    const ms = Date.parse(triggeredByTask.triggeredAt);
    if (!Number.isNaN(ms)) {
      timeLabel = new Date(ms).toLocaleTimeString(locale);
    }
    return (
      <div className="chat-task-triggered-banner" role="note">
        <Zap size={12} strokeWidth={1.9} aria-hidden="true" />
        <span className="chat-task-triggered-text">
          {t("chat.triggeredByTask", {
            defaultValue: "Triggered by scheduled task: {{name}}",
            values: { name: triggeredByTask.name },
          })}
        </span>
        {timeLabel && (
          <span className="chat-task-triggered-time">{timeLabel}</span>
        )}
      </div>
    );
  };

  // Keep the fork divider outside virtualization so it is always present when
  // visible (it is a single small node and never needs height preservation).
  const renderItem = (
    message: ChatConversationMessage,
    index: number,
  ): React.JSX.Element => {
    // Tool messages return null; render an empty keyed placeholder so React
    // keeps stable keys across renders.
    if (message.role === "tool") {
      return <div className="chat-message-hidden" key={message.id} />;
    }

    const className = `chat-message-group ${
      message.status ? `is-${message.status}` : ""
    }`.trim();

    return (
      <VirtualizedMessage
        id={message.id}
        key={message.id}
        itemIndex={index}
        itemClassName={className}
        virtualization={virtualization}
        previouslyRendered={Boolean(message.idRemappedFrom)}
        message={message}
        fileArtifacts={artifactsByOwner.get(message.id)}
        artifactWorkspace={artifactWorkspace}
        onToggleFileArtifact={toggleFileArtifact}
        isStreaming={isStreaming}
        lastAssistantMessageId={lastAssistantMessageId}
        activeConversationId={activeConversationId}
        updateSessionMessages={updateSessionMessages}
        canRollback={canRollback}
        rollbackPreparingMessageId={rollbackPreparingMessageId}
        pendingToolAuthorizations={pendingToolAuthorizations}
        onRollback={handleRollback}
        onFork={handleFork}
        onApproveToolAuthorization={approveToolAuthorization}
        onApproveToolAuthorizationAlways={approveToolAuthorizationAlways}
        onRejectToolAuthorization={rejectToolAuthorization}
      />
    );
  };

  // 消息区分两层：平滑视口（轨道内是全部消息流内容，高度由
  // streamGrowthSmoother 平滑过渡）+ 视口之外的会话级流式指示槽。
  // 指示槽不随内容增长移动，始终停在可视底部。
  return (
    <div className="chat-message-list">
      <div className="chat-message-viewport" ref={streamViewportRef}>
        <div className="chat-message-track">
          {renderTriggeredByTaskBanner()}
          {showForkDivider ? (
            <>
              {messages
                .slice(0, forkDividerIndex)
                .map((message, index) => renderItem(message, index))}
              {renderForkDivider()}
              {messages
                .slice(forkDividerIndex)
                .map((message, index) =>
                  renderItem(message, forkDividerIndex + index),
                )}
            </>
          ) : (
            <>
              {messages.map((message, index) => renderItem(message, index))}
              {forkDividerIndex === messages.length && forkedFromConversationId
                ? renderForkDivider()
                : null}
            </>
          )}
          {renderVisionStatusCard()}
          <ChatRunSummary
            messages={messages}
            isStreaming={isStreaming}
            isAborting={isAborting}
            isRunActive={isRunActive}
            tokenUsage={conversationTokenUsage}
            durationMs={lastRunDurationMs}
            ttftSumMs={conversationTtftSumMs}
            requestCount={conversationRequestCount}
          />
        </div>
      </div>
      <ChatStreamIndicator
        active={isStreaming}
        isAborting={isAborting}
        isRetrying={isLastAssistantRetrying}
      />
    </div>
  );
};
