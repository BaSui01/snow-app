import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { GitFork, Zap } from "lucide-react";
import { useI18n } from "../../../../i18n";
import { ChatRunSummary } from "./ChatRunSummary";
import { VirtualizedMessage } from "./VirtualizedMessage";
import type { ChatConversationMessage } from "../utils/conversationTypes";
import { useViewportVirtualization } from "../hooks/useViewportVirtualization";
import { useChatConversationContext } from "./ChatConversationContext";

type ChatMessageListProps = {
  messages: ChatConversationMessage[];
  isStreaming: boolean;
  isAborting: boolean;
  canRollback: boolean;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
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
  canRollback,
  scrollContainerRef,
}: ChatMessageListProps): React.JSX.Element => {
  const { t } = useI18n();
  const {
    activeConversationId,
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
    visionAnalysis,
    triggeredByTask,
    conversationTokenUsage,
    lastRunDurationMs,
    conversationTtftSumMs,
    conversationRequestCount,
  } = useChatConversationContext();

  const lastAssistantMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        return messages[i].id;
      }
    }
    return undefined;
  }, [messages]);

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
      timeLabel = new Date(ms).toLocaleTimeString();
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
        isStreaming={isStreaming}
        isAborting={isAborting}
        lastAssistantMessageId={lastAssistantMessageId}
        activeConversationId={activeConversationId}
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

  // If no fork divider needed, render messages directly
  if (!showForkDivider) {
    return (
      <div className="chat-message-list">
        {renderTriggeredByTaskBanner()}
        {messages.map((message, index) => renderItem(message, index))}
        {forkDividerIndex === messages.length && forkedFromConversationId
          ? renderForkDivider()
          : null}
        {renderVisionStatusCard()}
        <ChatRunSummary
          messages={messages}
          isStreaming={isStreaming}
          isAborting={isAborting}
          tokenUsage={conversationTokenUsage}
          durationMs={lastRunDurationMs}
          ttftSumMs={conversationTtftSumMs}
          requestCount={conversationRequestCount}
        />
      </div>
    );
  }

  // Split messages at the fork divider index
  const beforeFork = messages.slice(0, forkDividerIndex);
  const afterFork = messages.slice(forkDividerIndex);

  return (
    <div className="chat-message-list">
      {renderTriggeredByTaskBanner()}
      {beforeFork.map((message, index) => renderItem(message, index))}
      {renderForkDivider()}
      {afterFork.map((message, index) =>
        renderItem(message, forkDividerIndex + index),
      )}
      {renderVisionStatusCard()}
      <ChatRunSummary
        messages={messages}
        isStreaming={isStreaming}
        isAborting={isAborting}
        tokenUsage={conversationTokenUsage}
        durationMs={lastRunDurationMs}
        ttftSumMs={conversationTtftSumMs}
        requestCount={conversationRequestCount}
      />
    </div>
  );
};
