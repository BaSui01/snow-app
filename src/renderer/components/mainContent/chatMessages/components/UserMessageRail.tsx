import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { MessageSquare } from "lucide-react";
import { useI18n } from "../../../../i18n";
import type { UserMessageSummary } from "../../../../../preload";
import { ContentChips } from "../../chatInput/ContentChips";
import {
  parseContentSegments,
  summarizeContentAsPlainText,
} from "../../chatInput/fileTagUtils";
import { ChatHistorySkeleton } from "./ChatHistorySkeleton";

type RefValue<T> = { current: T };

type UserMessageRailProps = {
  conversationId: string | undefined;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  /** 滚动容器身份 key（.chat-area 的 React key）：容器整体重建后必须重绑监听。 */
  containerKey: string;
  /** Triggers paginated loading of older messages. Called repeatedly until the
   *  target message enters the DOM. The loader preserves the viewport anchor
   *  (content must not shift while pages are prepended) and resolves only after
   *  that restore has converged, so the next round never races the correction. */
  loadOlderMessages: () => Promise<void>;
  /** Whether older messages are currently being fetched. */
  isLoadingOlderMessages: boolean;
  /** Whether more historical messages remain unloaded. */
  hasMoreMessages: boolean;
  /** Monotonically increasing version counter that bumps on every message
   *  operation (send, receive, rollback, compaction, page-load). Used as the
   *  sole dependency for re-fetching the user-message list so the rail always
   *  reflects the true DB state. */
  conversationVersion: number;
  /** Ref to the chat-area's shouldStickToBottom flag. The rail sets this to
   *  false before loading older messages so the ResizeObserver / scroll-pin
   *  logic does not yank the viewport back to the bottom while we are trying
   *  to navigate to an earlier message. */
  shouldStickToBottomRef: RefValue<boolean>;
  /** Ref mirroring ChatContent's isInitialBottomPositioningRef. The rail
   *  resets this to false so deriveFollowStateFromScroll stops forcing
   *  shouldStickToBottom=true during the initial-bottom-positioning phase. */
  isInitialBottomPositioningRef: RefValue<boolean>;
  /** Ref mirroring ChatContent's isUserScrollIntentRef. The rail sets this to
   *  true to mark a user-initiated navigation, so the scroll-follow logic
   *  respects our programmatic scroll instead of pinning to the bottom. */
  isUserScrollIntentRef: RefValue<boolean>;
};

/** Find the DOM element for a given message id. The VirtualizedMessage
 *  wrapper carries data-message-id on a permanently-mounted node, so this
 *  works even when the message is virtualized out to a placeholder. */
const findMessageElement = (
  container: HTMLElement,
  messageId: string,
): HTMLElement | null => {
  return container.querySelector<HTMLElement>(
    `[data-message-id="${CSS.escape(messageId)}"]`,
  );
};

/** Wait for the next animation frame. */
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));

export const UserMessageRail = memo(
  ({
    conversationId,
    scrollContainerRef,
    containerKey,
    loadOlderMessages,
    isLoadingOlderMessages,
    hasMoreMessages,
    conversationVersion,
    shouldStickToBottomRef,
    isInitialBottomPositioningRef,
    isUserScrollIntentRef,
  }: UserMessageRailProps): React.JSX.Element | null => {
    const { t } = useI18n();
    const [userMessages, setUserMessages] = useState<UserMessageSummary[]>([]);
    const [hovered, setHovered] = useState(false);
    const [loading, setLoading] = useState(false);
    const [popoverPos, setPopoverPos] = useState<{
      top: number;
      left: number;
    } | null>(null);
    const [popoverHeight, setPopoverHeight] = useState<number>(0);
    const [visibleUserIndices, setVisibleUserIndices] = useState<Set<number>>(
      new Set(),
    );
    // 定位遮罩：目标消息还在未加载的分页里时置位。翻页过程中消息区被隐藏、
    // 由骨架屏接管视觉，避免「翻页期间轻微抖动 + 最后一帧瞬间跳走」的观感。
    const [locating, setLocating] = useState(false);
    const [locateRect, setLocateRect] = useState<{
      top: number;
      left: number;
      width: number;
      height: number;
    } | null>(null);
    // 定位在途标志：期间忽略新的点击，防止两轮定位互相踩踏、遮罩被先结束
    // 的一轮提前撤下（回调闭包里读 state 会拿到快照，必须走 ref）。
    const locatingRef = useRef(false);
    // 遮罩类挂在滚动容器的真实 DOM 上（与 is-wheelscrolling 等同类做法），
    // 卸载清理时 ref 可能已被 React 置空，因此单独存一份元素引用。
    const locateContainerRef = useRef<HTMLElement | null>(null);
    const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const railRef = useRef<HTMLDivElement | null>(null);
    const popoverRef = useRef<HTMLDivElement | null>(null);
    const userMessagesRef = useRef<UserMessageSummary[]>([]);
    // 定位循环要连续翻多页：props 在回调闭包里是快照，翻页期间
    // hasMoreMessages 变为 false 后必须立刻停止续页，否则会白等兜底超时。
    const hasMoreMessagesRef = useRef(hasMoreMessages);
    const isLoadingOlderMessagesRef = useRef(isLoadingOlderMessages);
    hasMoreMessagesRef.current = hasMoreMessages;
    isLoadingOlderMessagesRef.current = isLoadingOlderMessages;

    // Fetch all user messages from the Rust backend on every version bump
    // and conversation switch. No caching — the backend query is lightweight
    // (id + content + created_at only, filtered by role='user') and every
    // bump means the DB state changed (send, rollback, compaction, etc.).
    useEffect(() => {
      if (!conversationId) {
        setUserMessages([]);
        userMessagesRef.current = [];
        return;
      }

      let cancelled = false;
      setLoading(true);
      window.snow
        .listUserMessages(conversationId)
        .then((fetchedMessages) => {
          if (cancelled) return;
          setUserMessages(fetchedMessages);
          userMessagesRef.current = fetchedMessages;
        })
        .catch(() => {
          if (cancelled) return;
          setUserMessages([]);
          userMessagesRef.current = [];
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });

      return () => {
        cancelled = true;
      };
    }, [conversationId, conversationVersion]);

    // Track which user messages are currently visible in the scroll viewport.
    // On every scroll/resize, iterate the DB user messages, find their DOM
    // elements by id, and check whether they intersect the viewport. The
    // resulting Set of indices (into userMessages) is used to
    // highlight the corresponding rail popover items so the user knows where
    // they are in the conversation.
    useEffect(() => {
      const container = scrollContainerRef.current;
      if (!container) return;

      const computeVisible = (): void => {
        const dbUserMsgs = userMessagesRef.current;
        if (dbUserMsgs.length === 0) {
          setVisibleUserIndices(new Set());
          return;
        }

        const containerRect = container.getBoundingClientRect();
        const visible = new Set<number>();

        for (let i = 0; i < dbUserMsgs.length; i++) {
          const dbMsg = dbUserMsgs[i];
          // The frontend replaces temporary ids with DB ids after persistence,
          // so data-message-id always matches the DB snowflake id.
          const el = findMessageElement(container, dbMsg.id);
          if (!el) continue;

          const rect = el.getBoundingClientRect();
          // Consider the message visible if it overlaps the viewport band
          // of the scroll container (with a small threshold so partially
          // visible messages count).
          const THRESHOLD = 40;
          const isVisible =
            rect.bottom > containerRect.top + THRESHOLD &&
            rect.top < containerRect.bottom - THRESHOLD;

          if (isVisible) {
            visible.add(i);
          }
        }

        setVisibleUserIndices((prev) => {
          if (prev.size === visible.size) {
            let same = true;
            for (const idx of visible) {
              if (!prev.has(idx)) {
                same = false;
                break;
              }
            }
            if (same) return prev;
          }
          return visible;
        });
      };

      // Initial compute after a frame so layout is ready.
      const raf = requestAnimationFrame(computeVisible);
      // 流式滚动时 scroll 事件高频触发（每秒几十次），且每次都要遍历
      // 全部用户消息做 DOM 查询 + rect 读取；用 rAF 合并到每帧最多一次，
      // 避免高频重复计算。
      let pendingRaf = 0;
      const scheduleCompute = (): void => {
        if (pendingRaf !== 0) return;
        pendingRaf = requestAnimationFrame(() => {
          pendingRaf = 0;
          computeVisible();
        });
      };
      container.addEventListener("scroll", scheduleCompute, { passive: true });
      window.addEventListener("resize", scheduleCompute);

      return () => {
        cancelAnimationFrame(raf);
        if (pendingRaf !== 0) {
          cancelAnimationFrame(pendingRaf);
        }
        container.removeEventListener("scroll", scheduleCompute);
        window.removeEventListener("resize", scheduleCompute);
      };
    }, [scrollContainerRef, containerKey, conversationId, conversationVersion]);

    // Compute popover position relative to the rail element so it opens to
    // the left, hugging the rail's left edge. The popover top is clamped to
    // keep the entire popover within the viewport so it never overflows or
    // grows infinitely off-screen when there are many messages.
    const computePopoverPosition = useCallback((): {
      top: number;
      left: number;
    } | null => {
      const rail = railRef.current;
      if (!rail) return null;
      const railRect = rail.getBoundingClientRect();
      const POPOVER_WIDTH = 260;
      const POPOVER_GAP = 8;
      const VIEWPORT_MARGIN = 8;

      // Prefer to center the popover vertically on the rail, but clamp it
      // so the popover never extends beyond the viewport. We need the
      // popover's actual height for this; if not yet measured, fall back
      // to a reasonable estimate.
      const measuredH = popoverRef.current?.offsetHeight ?? 0;
      const approxH = measuredH > 0 ? measuredH : popoverHeight;
      const effectiveH = approxH > 0 ? approxH : 400;

      const desiredTop = railRect.top + railRect.height / 2 - effectiveH / 2;
      const minTop = VIEWPORT_MARGIN;
      const maxTop = window.innerHeight - effectiveH - VIEWPORT_MARGIN;
      const top = Math.max(minTop, Math.min(desiredTop, maxTop));

      const left = railRect.left - POPOVER_WIDTH - POPOVER_GAP;
      return { top, left };
    }, [popoverHeight]);

    const handleMouseEnter = useCallback((): void => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      setPopoverPos(computePopoverPosition());
      setHovered(true);
    }, [computePopoverPosition]);

    const handleMouseLeave = useCallback((): void => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
      }
      hideTimerRef.current = setTimeout(() => {
        setHovered(false);
        setPopoverPos(null);
        setPopoverHeight(0);
      }, 200);
    }, []);

    useEffect(() => {
      return () => {
        if (hideTimerRef.current) {
          clearTimeout(hideTimerRef.current);
        }
      };
    }, []);

    // 撤下定位遮罩：恢复消息列表绘制并卸掉骨架屏。翻页失败（目标迟迟没
    // 出现，循环退出）时同样走这里，不会把消息区永久留在隐藏状态。
    const finishLocating = useCallback((): void => {
      locatingRef.current = false;
      locateContainerRef.current?.classList.remove("is-locating-message");
      locateContainerRef.current = null;
      setLocating(false);
      setLocateRect(null);
    }, []);

    // 骨架屏遮罩跟随滚动容器的位置与尺寸（窗口缩放、面板开合都会改变它）。
    // layout effect：与点击同一次提交内量好坐标，遮罩首帧就带着骨架屏，
    // 不会先闪一帧只剩隐藏消息区的空屏。
    useLayoutEffect(() => {
      if (!locating) {
        return;
      }
      const syncRect = (): void => {
        const container = scrollContainerRef.current;
        if (!container) {
          return;
        }
        const rect = container.getBoundingClientRect();
        setLocateRect({
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
        });
      };
      syncRect();
      window.addEventListener("resize", syncRect);
      return () => {
        window.removeEventListener("resize", syncRect);
      };
    }, [locating, scrollContainerRef]);

    // 定位途中卸载（会话切换、消息清空）：遮罩类必须摘干净，否则重建后的
    // 消息区会一直停在隐藏状态。此处刻意不走 setState，卸载后不再需要。
    useEffect(() => {
      return () => {
        locatingRef.current = false;
        locateContainerRef.current?.classList.remove("is-locating-message");
        locateContainerRef.current = null;
      };
    }, []);

    // After the popover mounts (hovered becomes true), measure its real
    // height on the next frame and compute the final clamped position. This
    // runs once per open — it reads offsetHeight synchronously after layout
    // so the initial estimate is corrected to exact centering + viewport
    // clamping.
    useEffect(() => {
      if (!hovered) return;
      const rail = railRef.current;
      if (!rail) return;
      let cancelled = false;

      const measureAndPosition = (): void => {
        if (cancelled) return;
        const el = popoverRef.current;
        const railRect = rail.getBoundingClientRect();
        const POPOVER_WIDTH = 260;
        const POPOVER_GAP = 8;
        const VIEWPORT_MARGIN = 8;

        const effectiveH =
          el?.offsetHeight && el.offsetHeight > 0 ? el.offsetHeight : 400;

        const desiredTop = railRect.top + railRect.height / 2 - effectiveH / 2;
        const minTop = VIEWPORT_MARGIN;
        const maxTop = window.innerHeight - effectiveH - VIEWPORT_MARGIN;
        const top = Math.max(minTop, Math.min(desiredTop, maxTop));
        const left = railRect.left - POPOVER_WIDTH - POPOVER_GAP;

        setPopoverPos({ top, left });
        if (el && el.offsetHeight > 0) {
          setPopoverHeight(el.offsetHeight);
        }
      };

      // Defer one frame so the portaled popover has been laid out.
      const raf = requestAnimationFrame(measureAndPosition);
      return () => {
        cancelled = true;
        cancelAnimationFrame(raf);
      };
    }, [hovered, userMessages]);

    // Recompute on viewport resize so the clamp stays correct.
    useEffect(() => {
      if (!hovered) return;
      const onResize = (): void => {
        const rail = railRef.current;
        if (!rail) return;
        const railRect = rail.getBoundingClientRect();
        const POPOVER_WIDTH = 260;
        const POPOVER_GAP = 8;
        const VIEWPORT_MARGIN = 8;
        const effectiveH =
          popoverRef.current?.offsetHeight &&
          popoverRef.current.offsetHeight > 0
            ? popoverRef.current.offsetHeight
            : popoverHeight > 0
              ? popoverHeight
              : 400;
        const desiredTop = railRect.top + railRect.height / 2 - effectiveH / 2;
        const minTop = VIEWPORT_MARGIN;
        const maxTop = window.innerHeight - effectiveH - VIEWPORT_MARGIN;
        const top = Math.max(minTop, Math.min(desiredTop, maxTop));
        const left = railRect.left - POPOVER_WIDTH - POPOVER_GAP;
        setPopoverPos({ top, left });
      };
      window.addEventListener("resize", onResize);
      return () => window.removeEventListener("resize", onResize);
    }, [hovered, popoverHeight]);

    // Scroll to a target user message. The frontend replaces temporary ids
    // with real DB ids after persistence, so the DOM's data-message-id always
    // matches the DB snowflake id from listUserMessages. If the message is not
    // yet in the DOM (paginated loading hasn't reached it), repeatedly call
    // loadOlderMessages until it appears or there are no more pages. The loader
    // is the chat area's anchor-preserving paging entry: every prepended page is
    // corrected back to the current viewport anchor before it resolves, so the
    // visible content never jumps while we page up to the target. Then use
    // scrollIntoView and iterate: virtualized placeholders above the target
    // expand to real content (height changes), pushing the target down. We
    // keep re-scrolling until the position stabilizes.
    //
    // 目标还压在未加载的分页里时（needsPaging），消息列表在定位全程只隐藏
    // 绘制、保留布局：翻页锚点校正与 scrollIntoView 读的都是真实 rect，照常
    // 工作，视觉则交给盖在滚动容器位置上的骨架屏——翻页期间的轻微抖动与最后
    // 那一下瞬间跳走都不会被看到，落地后再揭开遮罩。
    const handleItemClick = useCallback(
      async (messageId: string): Promise<void> => {
        const container = scrollContainerRef.current;
        if (!container) {
          return;
        }
        // 上一轮定位还没结束：忽略这次点击。两轮定位的翻页会互相等待
        // （loader 有 in-flight 守卫），而遮罩会被先结束的一轮提前撤下。
        if (locatingRef.current) {
          return;
        }

        // Mark this as a user-initiated scroll, exactly like
        // markUserScrollIntent does. This resets isInitialBottomPositioning
        // (so deriveFollowStateFromScroll stops forcing shouldStickToBottom=true)
        // and sets isUserScrollIntent (so the follow state is derived from
        // the live geometry instead of pinning to the bottom). Without this,
        // the ResizeObserver's keepAtBottomSync yanks the viewport back to
        // the bottom the instant loadOlderMessages finishes prepending pages.
        isUserScrollIntentRef.current = true;
        isInitialBottomPositioningRef.current = false;
        shouldStickToBottomRef.current = false;

        let el = findMessageElement(container, messageId);

        const needsPaging = !el;
        if (needsPaging) {
          locatingRef.current = true;
          locateContainerRef.current = container;
          container.classList.add("is-locating-message");
          // 选中即离场：定位期间浮层让位给遮罩（骨架屏才是进度反馈）。
          setHovered(false);
          setPopoverPos(null);
          setLocating(true);
        }

        try {
          // If not found, load older messages in a loop until it appears. Guard on
          // the refs, not the captured props: after the last page lands
          // hasMoreMessages flips to false and the loop must stop instead of
          // burning rounds (each of which would wait out the loader's fallback).
          const MAX_LOAD_ROUNDS = 200;
          let round = 0;
          // container.isConnected：定位途中切换会话会整体重建 .chat-area，旧
          // 容器脱离文档后目标永远不会出现，继续翻页只会把新会话的历史白拉
          // 进内存（遮罩类挂在旧容器上，不影响新容器）。
          while (
            !el &&
            hasMoreMessagesRef.current &&
            container.isConnected &&
            round < MAX_LOAD_ROUNDS
          ) {
            round++;
            if (isLoadingOlderMessagesRef.current) {
              await new Promise((resolve) => setTimeout(resolve, 50));
              continue;
            }
            await loadOlderMessages();
            await nextFrame();
            await nextFrame();
            el = findMessageElement(container, messageId);
          }

          if (!el) {
            return;
          }

          // Iterate scrollIntoView until the target's offsetTop stabilizes.
          // Each scrollIntoView brings the target to the top of the viewport,
          // which causes virtualized placeholders *above* it (within the 600px
          // IntersectionObserver buffer) to render real content. Their height
          // grows, pushing the target down. We re-scroll and repeat until the
          // target's offsetTop no longer changes between frames.
          let prevOffsetTop = -1;
          for (let i = 0; i < 30; i++) {
            el = findMessageElement(container, messageId);
            if (!el) break;
            el.scrollIntoView({ block: "start", behavior: "auto" });
            await nextFrame();
            await nextFrame();
            const elNow = findMessageElement(container, messageId);
            if (!elNow) break;
            const currentOffsetTop = elNow.offsetTop;
            if (currentOffsetTop === prevOffsetTop) {
              break;
            }
            prevOffsetTop = currentOffsetTop;
          }
        } finally {
          if (needsPaging) {
            finishLocating();
          }
          setHovered(false);
          setPopoverPos(null);
        }
      },
      [
        scrollContainerRef,
        loadOlderMessages,
        shouldStickToBottomRef,
        isInitialBottomPositioningRef,
        isUserScrollIntentRef,
        finishLocating,
      ],
    );

    if (userMessages.length === 0 && !loading) {
      return null;
    }

    const popover =
      hovered && userMessages.length > 0 && popoverPos
        ? createPortal(
            <div
              ref={popoverRef}
              className="user-message-rail-popover"
              style={{
                top: `${popoverPos.top}px`,
                left: `${popoverPos.left}px`,
              }}
              onMouseEnter={handleMouseEnter}
              onMouseLeave={handleMouseLeave}
            >
              <div className="user-message-rail-popover-header">
                <span>
                  {t("chat.userMessageRail.title", {
                    defaultValue: "User messages",
                  })}
                </span>
                <span className="user-message-rail-popover-count">
                  {userMessages.length}
                </span>
              </div>
              <div className="user-message-rail-popover-list">
                {userMessages.map((msg, index) => {
                  const summary = summarizeContentAsPlainText(msg.content);
                  const hasChips =
                    !msg.isContextCompaction &&
                    (msg.content.includes("@@file:") ||
                      msg.content.includes("@@dir:") ||
                      msg.content.includes("@@image:") ||
                      msg.content.includes("@@commit:") ||
                      msg.content.includes("@@change:") ||
                      msg.content.includes("@@text-snippet:") ||
                      msg.content.includes("@@review:") ||
                      msg.content.includes("@@element:") ||
                      msg.content.includes("@@web:") ||
                      msg.content.includes("@@conversation:") ||
                      msg.content.includes("@@skill:"));
                  const isVisible = visibleUserIndices.has(index);
                  const itemLabel = msg.isContextCompaction
                    ? t("chat.compactionSummary", {
                        defaultValue: "Context summary",
                      })
                    : summary.length > 0
                      ? summary.length > 64
                        ? `${summary.slice(0, 64)}...`
                        : summary
                      : `#${index + 1}`;
                  return (
                    <button
                      type="button"
                      key={msg.id}
                      className={`user-message-rail-popover-item${isVisible ? " is-visible" : ""}`}
                      onClick={() => void handleItemClick(msg.id)}
                      title={msg.isContextCompaction ? itemLabel : summary}
                    >
                      <span className="user-message-rail-popover-item-index">
                        {index + 1}
                      </span>
                      <span className="user-message-rail-popover-item-text">
                        {hasChips ? (
                          <ContentChips
                            segments={parseContentSegments(msg.content)}
                          />
                        ) : (
                          itemLabel
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>,
            document.body,
          )
        : null;

    // 定位遮罩：坐标取自滚动容器的视口矩形（与浮层同一套 portal + 定坐标
    // 做法），骨架屏在其中垂直居中。消息列表此时被 .is-locating-message
    // 隐藏绘制，这一层就是定位期间唯一的视觉反馈。
    const locateOverlay =
      locating && locateRect
        ? createPortal(
            <div
              className="user-message-locate-overlay"
              style={{
                top: `${locateRect.top}px`,
                left: `${locateRect.left}px`,
                width: `${locateRect.width}px`,
                height: `${locateRect.height}px`,
              }}
            >
              <ChatHistorySkeleton />
            </div>,
            document.body,
          )
        : null;

    return (
      <>
        <div
          ref={railRef}
          className="user-message-rail"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          aria-label={t("chat.userMessageRail.title", {
            defaultValue: "User messages",
          })}
          title={t("chat.userMessageRail.title", {
            defaultValue: "User messages",
          })}
        >
          <MessageSquare size={15} strokeWidth={2} aria-hidden="true" />
          {userMessages.length > 0 ? (
            <span className="user-message-rail-count">
              {userMessages.length}
            </span>
          ) : null}
        </div>
        {locateOverlay}
        {popover}
      </>
    );
  },
);

UserMessageRail.displayName = "UserMessageRail";
