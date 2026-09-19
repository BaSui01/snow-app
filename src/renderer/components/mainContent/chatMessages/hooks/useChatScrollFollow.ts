import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ChatInputSendOptions } from "../../chatInput/types";
import { useChatConversationContext } from "../components/ChatConversationContext";

type PendingScrollRestore = {
  conversationId: string;
  requestId: number;

  anchorElement: Element | null;

  anchorContentOffset: number;

  firstMessageId: string | undefined;
  /** 恢复收敛轮次计数（防御性上限）。 */
  rounds: number;
  /** anchor 缺失/失效时的兜底几何快照：翻页前的 scrollHeight/scrollTop。 */
  scrollHeight: number;
  scrollTop: number;
};

const LOAD_OLDER_SCROLL_THRESHOLD = 96;
const SHOW_SCROLL_TO_BOTTOM_THRESHOLD = 160;
const STICK_TO_BOTTOM_THRESHOLD = 16;

const USER_SCROLL_INTENT_WINDOW_MS = 750;
// Run 结束（isStreaming true→false）后消息集中定稿重渲染：动作按钮出现、
// run summary 摘要条插入、Thinking 折叠、markdown 定稿，高度逐帧变化。
// 在此窗口内保持钉底资格，把最终总结带到可视底部。
const RUN_FINISH_FOLLOW_GRACE_MS = 1200;
// 流式跟随的平滑趋近速率（1/s）：rAF 每帧向底部做指数趋近，约 150ms 收敛
// 95%。替代瞬时跳写，让流式增长以连续滑行进入视口而非逐块硬跳；取值权衡
// 快速流式下的稳态滞后（增量速率/该值 px）与滑行可见度。
const FOLLOW_EASE_RATE_PER_S = 20;
// 跟随位移不超过该值时直接瞬时贴合：行高级变化肉眼无感知，无需动画；
// 超过则以平滑动画滑向底部，避免流式输出时视口逐块硬跳。
const FOLLOW_INSTANT_JUMP_PX = 4;

const willNestedScrollerConsumeWheel = (
  container: HTMLElement,
  target: EventTarget | null,
  deltaY: number,
): boolean => {
  let node = target instanceof HTMLElement ? target : null;
  while (node && node !== container) {
    if (node.scrollHeight > node.clientHeight + 1) {
      const overflowY = window.getComputedStyle(node).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") {
        const maxScrollTop = node.scrollHeight - node.clientHeight;
        if (
          (deltaY < 0 && node.scrollTop > 0) ||
          (deltaY > 0 && node.scrollTop < maxScrollTop - 1)
        ) {
          return true;
        }
      }
    }
    node = node.parentElement;
  }
  return false;
};

export type ChatScrollFollowOptions = {
  /** 视图重建 key（.chat-area 的 React key 派生值）：容器整体重建时滚动状态复位。 */
  chatRenderKey: string;
  /** chat-area 是否实际挂载：灵动岛态下不渲染，展开时 DOM 节点整体重建。 */
  isChatAreaRendered: boolean;
  /** 当前会话是否正在压缩（压缩是显式操作，预览与边界强制保持可见）。 */
  isCompactingActive: boolean;
  /** 自动滚动偏好：关闭时不钉底，但首屏初始定位不受影响。 */
  autoScrollEnabled: boolean;
};

export type ChatScrollFollowResult = {
  scrollRef: React.RefObject<HTMLDivElement | null>;
  showScrollToBottom: boolean;
  markUserScrollIntent: (direction: number) => void;
  handleChatWheel: (event: React.WheelEvent<HTMLDivElement>) => void;
  handleChatPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  handleChatPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  handleChatPointerLeave: (event: React.PointerEvent<HTMLDivElement>) => void;
  handleChatKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  handleChatScroll: () => void;
  handleScrollToBottom: () => void;
  handleLoadOlderWithScroll: () => Promise<void>;
  handleSendWithScroll: (
    message: string,
    options: ChatInputSendOptions,
  ) => void;
  shouldStickToBottomRef: React.RefObject<boolean>;
  isInitialBottomPositioningRef: React.RefObject<boolean>;
  isUserScrollIntentRef: React.RefObject<boolean>;
};

/**
 * 聊天区滚动跟随控制器：滚动状态机（钉底资格推导、几何位移辨识）、平滑跟随
 * 动画、翻页滚动恢复（多轮收敛）、ResizeObserver 钉底、事件 handlers 与滚动
 * 到底部按钮补间。从 ChatContent 抽出，依赖的会话状态直接取自
 * ChatConversationContext；外部仅传入视图层状态（渲染 key、挂载态、压缩态、
 * 自动滚动偏好）。
 */
export const useChatScrollFollow = ({
  chatRenderKey,
  isChatAreaRendered,
  isCompactingActive,
  autoScrollEnabled,
}: ChatScrollFollowOptions): ChatScrollFollowResult => {
  const {
    messages,
    activeConversationId,
    isStreaming,
    hasMoreMessages,
    isLoadingOlderMessages,
    isInitialHistoryLoaded,
    isLoadingInitialHistory,
    loadOlderMessages,
    pendingToolAuthorizations,
    handleSendMessage,
  } = useChatConversationContext();

  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const hasMessages = messages.length > 0;

  const scrollRef = useRef<HTMLDivElement>(null);
  const activeConversationIdRef = useRef(activeConversationId);
  const previousActiveConversationIdRef = useRef(activeConversationId);
  const previousChatRenderKeyRef = useRef(chatRenderKey);
  const positionedConversationIdsRef = useRef(new Set<string>());
  const pendingScrollRestoreRef = useRef<PendingScrollRestore | null>(null);
  const scrollRestoreRequestIdRef = useRef(0);
  const isLoadingOlderWithScrollRef = useRef(false);
  // 一轮翻页滚动恢复的在途信号：等不到新页/被新一轮接管时也必须唤醒等待方。
  const scrollRestoreInflightRef = useRef<Promise<void> | null>(null);
  const scrollRestoreSettleRef = useRef<(() => void) | null>(null);
  const scrolledAuthorizationSignatureRef = useRef("");
  const shouldStickToBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  // 上次 scroll 事件时的几何快照：用于区分「用户滚动」与「滚动锚定/clamp 位移」。
  const lastScrollHeightRef = useRef(0);
  const lastClientHeightRef = useRef(0);
  const isInitialBottomPositioningRef = useRef(false);
  const isUserScrollIntentRef = useRef(false);
  // 最近一次真实滚动输入（wheel/滚动条/按键/触摸）的时间戳：stick=false
  // 只允许在该输入的延续窗口内生效，见 USER_SCROLL_INTENT_WINDOW_MS。
  const lastUserScrollInputAtRef = useRef(-Infinity);
  // 最近一次真实输入的方向：-1 上行 / 1 下行 / 0 未知（触摸、滚动条拖拽）。
  const lastUserScrollInputDirectionRef = useRef(0);

  const isSmoothScrollingToBottomRef = useRef(false);

  // 流式跟随的平滑趋近动画（区别于滚到底部按钮的 350ms 补间）：rAF 每帧把
  // scrollTop 向底部做指数趋近。目标每帧重读 scrollHeight，内容增长时动画
  // 跟着新目标滑行，不会脱底；停止动画后由瞬时钉底兜底，钉底资格不变。
  const followAnimRafIdRef = useRef(0);

  const scrollToBottomAnimRef = useRef(0);
  const previousIsCompactingRef = useRef(isCompactingActive);
  const scrollRafIdRef = useRef(0);
  const wheelScrollbarTimerRef = useRef(0);
  // 自动续页：上一轮基线高度 + 连续未长高轮次。
  const autoFillStartHeightRef = useRef(0);
  const autoFillStallRef = useRef(0);
  const hasMessagesRef = useRef(hasMessages);
  const hasMoreMessagesRef = useRef(hasMoreMessages);
  const messagesRef = useRef(messages);
  const autoScrollEnabledRef = useRef(autoScrollEnabled);
  const isStreamingRef = useRef(isStreaming);
  // Run 收尾宽限窗口：时间戳，期间 RO 钉底视同流式输出。
  const followGraceUntilRef = useRef(0);
  // 窗口失焦/遮挡（渲染帧停摆）时处于跟随中的标记：恢复后据此追赶钉底。
  const refocusFollowArmedRef = useRef(false);
  const previousIsStreamingRef = useRef(isStreaming);
  activeConversationIdRef.current = activeConversationId;
  hasMessagesRef.current = hasMessages;
  hasMoreMessagesRef.current = hasMoreMessages;
  messagesRef.current = messages;
  autoScrollEnabledRef.current = autoScrollEnabled;
  isStreamingRef.current = isStreaming;

  const stopFollowAnimation = useCallback((): void => {
    if (followAnimRafIdRef.current !== 0) {
      cancelAnimationFrame(followAnimRafIdRef.current);
      followAnimRafIdRef.current = 0;
    }
  }, []);

  // 流式跟随的平滑趋近：rAF 循环里每帧向底部指数趋近（一阶惯性），目标为
  // 当帧的 scrollHeight - clientHeight。内容持续增长时动画滑行追新目标，
  // 不会脱底；一旦到达（≤1px）即停止，转由调用方路径的瞬时钉底兜底。用户
  // 滚动输入（markUserScrollIntent）与本函数互斥，上行会先取消本动画。
  const startFollowAnimation = useCallback((): void => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }
    // 滚到底部补间在途时让位：补间是显式动作，两个逐帧写入会互相踩踏。
    if (isSmoothScrollingToBottomRef.current) {
      return;
    }
    // 注意：初始定位（isInitialBottomPositioningRef）不在此豁免——该标志表示
    // 「用户尚未表达滚动意图」，其零扰动保证由初始定位 effect 直接写
    // scrollTop 实现（不经本函数）；若在此豁免，标志会一直存续到用户首次
    // 滚动，流式跟随的平滑动画将被无限期禁用（表现为手动滚一下才有过渡）。
    const maxScrollTop = container.scrollHeight - container.clientHeight;
    const distance = maxScrollTop - container.scrollTop;
    // 距离不足一感（≤4px）直接贴合：省一个 rAF 循环，视觉零差异。
    if (distance <= FOLLOW_INSTANT_JUMP_PX) {
      container.scrollTop = maxScrollTop;
      return;
    }
    if (followAnimRafIdRef.current !== 0) {
      cancelAnimationFrame(followAnimRafIdRef.current);
    }
    let lastTimeMs = performance.now();

    const tick = (nowMs: number): void => {
      followAnimRafIdRef.current = 0;
      const nextContainer = scrollRef.current;
      if (nextContainer !== container) {
        return;
      }
      // stick 已被外部置 false（用户输入/消息定位跳转）：立即停手。
      if (!shouldStickToBottomRef.current) {
        return;
      }
      const maxScrollTop =
        nextContainer.scrollHeight - nextContainer.clientHeight;
      const distance = maxScrollTop - nextContainer.scrollTop;
      if (distance <= 1) {
        nextContainer.scrollTop = maxScrollTop;
        return;
      }
      // 一阶趋近：每帧消耗固定比例的距离，时间步长校正保证 60/120Hz 表现一致
      const ratio =
        1 - Math.exp(-FOLLOW_EASE_RATE_PER_S * ((nowMs - lastTimeMs) / 1000));
      lastTimeMs = nowMs;
      nextContainer.scrollTop += distance * ratio;
      followAnimRafIdRef.current = requestAnimationFrame(tick);
    };

    followAnimRafIdRef.current = requestAnimationFrame(tick);
  }, []);

  // 跟随路径统一入口：动画在途时交给动画（tick 每帧重读目标，自会滑向
  // 新底部）；否则交由 startFollowAnimation 分流——噪声级增量瞬时钉底，
  // 较大增长平滑趋近。
  const glideOrPinToBottom = useCallback((): void => {
    if (followAnimRafIdRef.current !== 0) {
      return;
    }
    startFollowAnimation();
  }, [startFollowAnimation]);

  // 结束一轮翻页滚动恢复：释放在途标记并唤醒等待该轮收敛的调用方（用户消息
  // 定位需要按页推进），避免等待一个永不抵达的信号。
  const finishScrollRestore = useCallback((): void => {
    isLoadingOlderWithScrollRef.current = false;
    const settle = scrollRestoreSettleRef.current;
    scrollRestoreSettleRef.current = null;
    scrollRestoreInflightRef.current = null;
    if (settle) {
      settle();
    }
  }, []);

  const syncScrollButtonVisibility = useCallback(
    (container: HTMLDivElement): void => {
      if (
        isSmoothScrollingToBottomRef.current ||
        followAnimRafIdRef.current !== 0
      ) {
        setShowScrollToBottom(false);
        return;
      }
      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      setShowScrollToBottom(
        hasMessagesRef.current &&
          distanceFromBottom > SHOW_SCROLL_TO_BOTTOM_THRESHOLD,
      );
    },
    [],
  );

  const deriveFollowStateFromScroll = useCallback(
    (container: HTMLDivElement): void => {
      if (
        isSmoothScrollingToBottomRef.current ||
        followAnimRafIdRef.current !== 0
      ) {
        // 程序化滚动（底部补间/跟随动画）产生的 scroll 事件不是用户位移：
        // 只刷新几何快照，不改 stick——tick 与补间自己检查它，外部改写
        // （如消息定位跳转置 false）能立即生效，不会被打回 true。
        lastScrollTopRef.current = container.scrollTop;
        lastScrollHeightRef.current = container.scrollHeight;
        lastClientHeightRef.current = container.clientHeight;
        setShowScrollToBottom(false);
        return;
      }

      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;

      if (
        isInitialBottomPositioningRef.current &&
        !isUserScrollIntentRef.current
      ) {
        shouldStickToBottomRef.current = true;
        lastScrollTopRef.current = container.scrollTop;
        lastScrollHeightRef.current = container.scrollHeight;
        lastClientHeightRef.current = container.clientHeight;
        setShowScrollToBottom(false);
        return;
      }

      const deltaScrollTop = container.scrollTop - lastScrollTopRef.current;
      const deltaScrollHeight =
        container.scrollHeight - lastScrollHeightRef.current;
      const deltaClientHeight =
        container.clientHeight - lastClientHeightRef.current;
      lastScrollTopRef.current = container.scrollTop;
      lastScrollHeightRef.current = container.scrollHeight;
      lastClientHeightRef.current = container.clientHeight;

      // 视口上方的占位/折叠/图片加载会触发浏览器滚动锚定：scrollTop 随
      // scrollHeight 同向等量回移；窗口缩放引发 clamp 时 clientHeight 变化。
      // 这些位移没有用户输入，若按「向上滚」处理会静默停掉流式自动吸底。
      const isGeometryShift =
        deltaClientHeight !== 0 ||
        (deltaScrollTop !== 0 &&
          Math.sign(deltaScrollTop) === Math.sign(deltaScrollHeight) &&
          Math.abs(deltaScrollTop - deltaScrollHeight) <= 1);

      if (!isGeometryShift) {
        if (deltaScrollTop > 0) {
          // 正位移只允许找回跟随、禁止关闭：流式期间的正 delta 几乎全部
          // 来自钉底写入，钉底与滚动事件之间的增量增长令 distance 短暂超
          // 阈值，据此重导出 false 会静默杀死跟随（总结尾部停滚的偶发
          // 根因）。用户下滚未触底时 stick 本就为 false，不受影响。
          if (distanceFromBottom < STICK_TO_BOTTOM_THRESHOLD) {
            shouldStickToBottomRef.current = true;
          }
        } else if (deltaScrollTop < 0) {
          // 负位移脱离跟随需双重背书：真实输入的延续窗口内，且最近输入
          // 为上行或方向未知（触摸/滚动条拖拽）。下行输入后的负净位移只能
          // 来自上方塌缩与下方增长的同帧交错（躲过 isGeometryShift 判定），
          // 不得误判为用户上滚而关掉跟随。
          if (
            performance.now() - lastUserScrollInputAtRef.current <=
              USER_SCROLL_INTENT_WINDOW_MS &&
            lastUserScrollInputDirectionRef.current <= 0
          ) {
            shouldStickToBottomRef.current = false;
          }
        }
      }
      setShowScrollToBottom(
        hasMessagesRef.current &&
          distanceFromBottom > SHOW_SCROLL_TO_BOTTOM_THRESHOLD,
      );
    },
    [],
  );

  useLayoutEffect(() => {
    // 会话切换与容器重建（切换项目）都算视图更换：后者 activeConversationId
    // 不变，但 chat-area 的 DOM 被整体替换，滚动状态必须一并复位。
    const isConversationChange =
      previousActiveConversationIdRef.current !== activeConversationId;
    const isContainerRebuild =
      previousChatRenderKeyRef.current !== chatRenderKey;
    if (!isConversationChange && !isContainerRebuild) {
      return;
    }

    previousActiveConversationIdRef.current = activeConversationId;
    previousChatRenderKeyRef.current = chatRenderKey;
    scrollRestoreRequestIdRef.current += 1;
    pendingScrollRestoreRef.current = null;
    finishScrollRestore();
    scrolledAuthorizationSignatureRef.current = "";
    shouldStickToBottomRef.current = true;
    isInitialBottomPositioningRef.current = false;
    isUserScrollIntentRef.current = false;
    lastUserScrollInputAtRef.current = -Infinity;
    lastUserScrollInputDirectionRef.current = 0;
    refocusFollowArmedRef.current = false;
    stopFollowAnimation();
    if (scrollToBottomAnimRef.current !== 0) {
      cancelAnimationFrame(scrollToBottomAnimRef.current);
      scrollToBottomAnimRef.current = 0;
    }
    isSmoothScrollingToBottomRef.current = false;
    setShowScrollToBottom(false);
    if (activeConversationId) {
      positionedConversationIdsRef.current.delete(activeConversationId);
    }

    autoFillStartHeightRef.current = 0;
    autoFillStallRef.current = 0;

    const container = scrollRef.current;
    if (container) {
      // 清零几何快照：切换会话的 scrollTop 归零不得算作跨会话的滚动位移。
      lastScrollTopRef.current = 0;
      lastScrollHeightRef.current = 0;
      lastClientHeightRef.current = 0;
      container.scrollTop = 0;
    }
  }, [
    activeConversationId,
    chatRenderKey,
    finishScrollRestore,
    stopFollowAnimation,
  ]);

  // chat-area 重挂载（灵动岛重开/紧凑展开）时容器 DOM 被整体替换：
  // 清除已定位标记，让初始定位 effect 在同轮 commit 重新滚到底部。
  useLayoutEffect(() => {
    if (!isChatAreaRendered) {
      return;
    }
    const conversationId = activeConversationIdRef.current;
    if (conversationId) {
      positionedConversationIdsRef.current.delete(conversationId);
    }
  }, [isChatAreaRendered]);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (
      !container ||
      !activeConversationId ||
      !isInitialHistoryLoaded ||
      isLoadingInitialHistory ||
      messages.length === 0 ||
      positionedConversationIdsRef.current.has(activeConversationId)
    ) {
      return;
    }

    let rafId1 = 0;
    let rafId2 = 0;
    let rafId3 = 0;

    const scrollToBottom = (): void => {
      container.scrollTop = container.scrollHeight;
    };

    isInitialBottomPositioningRef.current = true;
    isUserScrollIntentRef.current = false;
    shouldStickToBottomRef.current = true;
    setShowScrollToBottom(false);
    scrollToBottom();
    rafId1 = requestAnimationFrame(() => {
      scrollToBottom();
      rafId2 = requestAnimationFrame(() => {
        scrollToBottom();
        rafId3 = requestAnimationFrame(scrollToBottom);
      });
    });

    positionedConversationIdsRef.current.add(activeConversationId);

    return (): void => {
      cancelAnimationFrame(rafId1);
      cancelAnimationFrame(rafId2);
      cancelAnimationFrame(rafId3);
    };
  }, [
    activeConversationId,
    chatRenderKey,
    isChatAreaRendered,
    isInitialHistoryLoaded,
    isLoadingInitialHistory,
    messages.length,
  ]);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container || !activeConversationId) {
      return;
    }

    let resizeRafId = 0;
    let lastScrollHeight = container.scrollHeight;
    let lastClientHeight = container.clientHeight;
    const observedChildren = new Set<Element>();

    const keepAtBottomSync = (): void => {
      if (
        scrollRef.current !== container ||
        activeConversationIdRef.current !== activeConversationId
      ) {
        return;
      }

      const nextScrollHeight = container.scrollHeight;
      const nextClientHeight = container.clientHeight;
      const didGeometryChange =
        nextScrollHeight !== lastScrollHeight ||
        nextClientHeight !== lastClientHeight;
      lastScrollHeight = nextScrollHeight;
      lastClientHeight = nextClientHeight;

      if (!didGeometryChange) {
        return;
      }

      if (
        isLoadingOlderWithScrollRef.current ||
        pendingScrollRestoreRef.current !== null ||
        isSmoothScrollingToBottomRef.current
      ) {
        return;
      }

      const distanceFromBottom =
        nextScrollHeight - container.scrollTop - nextClientHeight;
      const isFollowActive =
        isStreamingRef.current ||
        performance.now() < followGraceUntilRef.current;
      // 流式或收尾宽限内贴底（≤ 阈值）时自动找回跟随：兜住任何漏判掉出
      // stick 的路径，避免「距底部一点却永不跟随、须手动触底」的死锁。
      if (
        !shouldStickToBottomRef.current &&
        distanceFromBottom <= STICK_TO_BOTTOM_THRESHOLD &&
        isFollowActive
      ) {
        shouldStickToBottomRef.current = true;
      }

      syncScrollButtonVisibility(container);

      // 钉底仅在初始定位、流式输出及 run 收尾宽限期生效；几何变化一律不改跟随状态
      if (
        shouldStickToBottomRef.current &&
        (isInitialBottomPositioningRef.current ||
          (autoScrollEnabledRef.current && isFollowActive))
      ) {
        // 首屏定稿窗口（用户未表达滚动意图且无流式/宽限）：markdown 定稿、
        // 图片加载、反虚拟化等集中撑高属于初始定位的延续，瞬时贴底——此时
        // 滑行会表现为进入会话后视口向上追赶，不协调。流式/宽限期间的钉底
        // 不走此分支，保持平滑趋近。
        if (isInitialBottomPositioningRef.current && !isFollowActive) {
          stopFollowAnimation();
          container.scrollTop = nextScrollHeight;
          return;
        }
        // 钉底即续期收尾宽限：定稿渲染逐帧晚到也持续被带到底部，
        // 几何静默或用户上滚（stick=false）后窗口自然失效。
        if (autoScrollEnabledRef.current && isFollowActive) {
          followGraceUntilRef.current =
            performance.now() + RUN_FINISH_FOLLOW_GRACE_MS;
        }
        // 跟随动画在途时 tick 每帧重读目标，自会滑向新底部；噪声级增量
        // 瞬时钉底；较大增长交给平滑趋近，避免整屏逐块硬跳。
        glideOrPinToBottom();
      }
    };

    const scheduleResizeCheck = (): void => {
      if (resizeRafId === 0) {
        resizeRafId = requestAnimationFrame(() => {
          resizeRafId = 0;
          keepAtBottomSync();
        });
      }
    };

    const resizeObserver = new ResizeObserver(keepAtBottomSync);

    resizeObserver.observe(container);
    const observeCurrentChildren = (): void => {
      for (const child of observedChildren) {
        if (!container.contains(child)) {
          resizeObserver.unobserve(child);
          observedChildren.delete(child);
        }
      }

      for (const child of Array.from(container.children)) {
        if (!observedChildren.has(child)) {
          observedChildren.add(child);
          resizeObserver.observe(child);
        }
      }
    };

    observeCurrentChildren();

    const mutationObserver = new MutationObserver(() => {
      observeCurrentChildren();
      scheduleResizeCheck();
    });
    mutationObserver.observe(container, { childList: true });
    container.addEventListener("load", scheduleResizeCheck, true);

    return (): void => {
      if (resizeRafId !== 0) {
        cancelAnimationFrame(resizeRafId);
      }
      container.removeEventListener("load", scheduleResizeCheck, true);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [
    activeConversationId,
    chatRenderKey,
    isChatAreaRendered,
    glideOrPinToBottom,
    stopFollowAnimation,
    syncScrollButtonVisibility,
  ]);

  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (!container || !activeConversationId) {
      return;
    }

    const visibleAuthorizations = pendingToolAuthorizations.filter(
      (toolCall) =>
        toolCall.authorizationConversationId === activeConversationId,
    );
    if (visibleAuthorizations.length === 0) {
      scrolledAuthorizationSignatureRef.current = "";
      return;
    }

    const signature = visibleAuthorizations
      .map(
        (toolCall) =>
          toolCall.authorizationId ??
          `${toolCall.name}-${toolCall.callId ?? toolCall.arguments}`,
      )
      .join("|");
    if (signature === scrolledAuthorizationSignatureRef.current) {
      return;
    }

    scrolledAuthorizationSignatureRef.current = signature;
    requestAnimationFrame(() => {
      glideOrPinToBottom();
    });
  }, [activeConversationId, pendingToolAuthorizations, glideOrPinToBottom]);

  // Keep the chat pinned to the latest AI output while streaming, unless the
  // user scrolls away or has disabled the preference entirely.
  useLayoutEffect(() => {
    if (
      !autoScrollEnabled ||
      !isStreaming ||
      !shouldStickToBottomRef.current ||
      !scrollRef.current
    ) {
      return;
    }

    glideOrPinToBottom();
  }, [
    autoScrollEnabled,
    isStreaming,
    messages,
    chatRenderKey,
    glideOrPinToBottom,
  ]);

  // Run 结束瞬间（isStreaming true→false）消息集中定稿：showActions 按钮、
  // run summary 摘要条、Thinking 折叠、markdown 定稿，高度逐帧变化，而流式
  // 钉底条件此刻已失效。仍在跟随时立即钉底并开启收尾宽限窗口，由 RO 把晚到
  // 的定稿渲染继续带到底部；用户已上滚（stick=false）则不强制拉底。
  useLayoutEffect(() => {
    const wasStreaming = previousIsStreamingRef.current;
    previousIsStreamingRef.current = isStreaming;
    if (isStreaming || !wasStreaming) {
      return;
    }
    if (!shouldStickToBottomRef.current) {
      return;
    }
    followGraceUntilRef.current =
      performance.now() + RUN_FINISH_FOLLOW_GRACE_MS;
    glideOrPinToBottom();
  }, [isStreaming, glideOrPinToBottom]);

  // 失焦/被遮挡时渲染帧停摆：rAF 与 ResizeObserver 挂起，markdown 渲染
  // （rAF 门控）被推迟；run 在后台结束后，恢复可见时 deferred 渲染集中
  // 落地而收尾宽限早已过期——总结尾部就此停在视口外。恢复可见/聚焦时
  // 重新打开宽限并钉底，后续落地增长由 RO 钉底+续期持续带到可视底部。
  useEffect(() => {
    let rafId1 = 0;
    let rafId2 = 0;
    const pinToBottom = (): void => {
      glideOrPinToBottom();
    };
    const armFollowCatchUp = (): void => {
      refocusFollowArmedRef.current =
        shouldStickToBottomRef.current &&
        (isStreamingRef.current ||
          performance.now() < followGraceUntilRef.current);
    };
    const runFollowCatchUp = (): void => {
      if (!shouldStickToBottomRef.current || !autoScrollEnabledRef.current) {
        return;
      }
      if (
        !refocusFollowArmedRef.current &&
        !isStreamingRef.current &&
        performance.now() >= followGraceUntilRef.current
      ) {
        return;
      }
      refocusFollowArmedRef.current = false;
      if (rafId1 !== 0) {
        cancelAnimationFrame(rafId1);
        rafId1 = 0;
      }
      if (rafId2 !== 0) {
        cancelAnimationFrame(rafId2);
        rafId2 = 0;
      }
      followGraceUntilRef.current =
        performance.now() + RUN_FINISH_FOLLOW_GRACE_MS;
      pinToBottom();
      rafId1 = requestAnimationFrame(() => {
        pinToBottom();
        rafId2 = requestAnimationFrame(pinToBottom);
      });
    };
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") {
        armFollowCatchUp();
      } else {
        runFollowCatchUp();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("blur", armFollowCatchUp);
    // capture：点击输入框等元素激活窗口时 focus 不冒泡到 window。
    window.addEventListener("focus", runFollowCatchUp, true);
    return (): void => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("blur", armFollowCatchUp);
      window.removeEventListener("focus", runFollowCatchUp, true);
      if (rafId1 !== 0) {
        cancelAnimationFrame(rafId1);
      }
      if (rafId2 !== 0) {
        cancelAnimationFrame(rafId2);
      }
    };
  }, [glideOrPinToBottom]);

  // Compaction is an explicit operation, so its preview and persisted boundary
  // must remain visible regardless of the user's normal auto-scroll preference.
  useLayoutEffect(() => {
    const wasCompacting = previousIsCompactingRef.current;
    previousIsCompactingRef.current = isCompactingActive;
    if (wasCompacting === isCompactingActive) {
      return;
    }

    shouldStickToBottomRef.current = true;
    stopFollowAnimation();
    const scrollToBottom = (): void => {
      const container = scrollRef.current;
      if (container) {
        container.scrollTop = container.scrollHeight;
      }
    };

    scrollToBottom();
    requestAnimationFrame(scrollToBottom);
  }, [isCompactingActive, stopFollowAnimation]);

  const handleLoadOlderWithScroll = useCallback(async (): Promise<void> => {
    const container = scrollRef.current;
    const conversationId = activeConversationIdRef.current;
    if (!container || !conversationId) {
      return;
    }

    // 已有翻页在途：等待它收敛后返回。定位用户消息需要按页推进，直接返回
    // 会让调用方误以为这一页已经到位。
    const inflightRestore = scrollRestoreInflightRef.current;
    if (inflightRestore) {
      await inflightRestore;
      return;
    }

    // 没有更早的记录时 loadOlderMessages 直接返回，建立恢复等待只会让调用
    // 方白等一轮兜底超时。
    if (!hasMoreMessagesRef.current) {
      return;
    }

    const requestId = ++scrollRestoreRequestIdRef.current;
    isLoadingOlderWithScrollRef.current = true;

    // 以视口内首个消息节点为翻页恢复锚点：新页插在它上方，恢复时按它
    // 在内容坐标系中的位移做增量校正。内容坐标 = anchorRect.top -
    // containerTop + scrollTop：用户滚动时 anchorRect 与 scrollTop 同步
    // 反向移动，内容坐标恒定；只有 DOM 推挤才会改变它——校正量天然剥离
    // 等待期间用户继续慢滚的位移，只补偿推挤，不回拨用户。
    let anchorElement: Element | null = null;
    let anchorContentOffset = 0;
    const containerTop = container.getBoundingClientRect().top;
    for (const el of container.querySelectorAll<HTMLElement>(
      "[data-message-id]",
    )) {
      if (el.getBoundingClientRect().bottom > containerTop) {
        anchorElement = el;
        anchorContentOffset =
          el.getBoundingClientRect().top - containerTop + container.scrollTop;
        break;
      }
    }

    let resolveRestore: () => void = () => {};
    const restoreFinished = new Promise<void>((resolve) => {
      resolveRestore = resolve;
    });
    scrollRestoreSettleRef.current = resolveRestore;
    scrollRestoreInflightRef.current = restoreFinished;

    pendingScrollRestoreRef.current = {
      conversationId,
      requestId,
      anchorElement,
      anchorContentOffset,
      firstMessageId: messagesRef.current[0]?.id,
      rounds: 0,
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
    };

    try {
      await loadOlderMessages();
    } finally {
      // 正常路径由下方的恢复 layout effect 在「新页 commit」的渲染周期内
      // 消费 pending（paint 前校正，视觉零扰动）。此超时仅作兜底：新页为
      // 空/加载异常导致 firstMessageId 始终未变时，清理状态防止
      // isLoadingOlderWithScrollRef 卡死翻页。requestId 不匹配说明期间
      // 发起了新一轮翻页，交由新轮回收，本轮只唤醒等待方。
      window.setTimeout(() => {
        if (scrollRestoreRequestIdRef.current === requestId) {
          pendingScrollRestoreRef.current = null;
          finishScrollRestore();
          return;
        }
        resolveRestore();
      }, 2000);
    }

    // 收敛后才返回：等待方（用户消息定位）据此保证「视口内容零跳动地翻完
    // 这一页」再决定下一步。
    await restoreFinished;
  }, [finishScrollRestore, loadOlderMessages]);

  // 翻页滚动恢复（多轮收敛）：新页 commit 后、paint 前按 anchor 的内容
  // 坐标差分校正推挤。新页消息由虚拟化 hook 的 forceVisible 机制挂载即
  // 真实渲染，但 flush 发生在新页 commit 之后的同步渲染轮次里——占位符
  // 阶段的几何令校正偏小，必须逐轮重测。每轮校正后更新基准（anchor 的
  // 内容坐标），下一轮只补「新发生的推挤」，累计精确；新页全部以真实
  // 内容渲染后几何定型，本轮校正即最终值。所有轮次都由 layout 阶段的
  // setState 同步 flush，发生在 paint 前——视口不出现任何中间帧。
  const [restoreTick, setRestoreTick] = useState(0);
  useLayoutEffect(() => {
    const pendingRestore = pendingScrollRestoreRef.current;
    const container = scrollRef.current;
    if (
      !pendingRestore ||
      !container ||
      !activeConversationId ||
      pendingRestore.conversationId !== activeConversationId ||
      messages[0]?.id === pendingRestore.firstMessageId
    ) {
      return;
    }

    const anchorEl = pendingRestore.anchorElement;
    if (anchorEl && container.contains(anchorEl)) {
      const anchorContentNow =
        anchorEl.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop;
      const pushSinceLastRound =
        anchorContentNow - pendingRestore.anchorContentOffset;
      if (pushSinceLastRound !== 0) {
        container.scrollTop += pushSinceLastRound;
        pendingRestore.anchorContentOffset = anchorContentNow;
      }
    } else {
      // 兜底：锚点缺失/失效时按几何增量恢复。
      const addedHeight = container.scrollHeight - pendingRestore.scrollHeight;
      container.scrollTop = pendingRestore.scrollTop + Math.max(0, addedHeight);
    }

    // 收敛检查：新页里只要还有占位符形态的消息，说明 forceVisible 的
    // 反虚拟化渲染尚未落地，几何还会变化——bump restoreTick 排队下一轮
    // 校正；全部真实渲染后清理收尾。轮次上限防御异常时的无限循环。
    let newPageFullyRendered = true;
    for (const message of messages) {
      if (message.id === pendingRestore.firstMessageId) break;
      if (message.role === "tool") continue;
      const node = container.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(message.id)}"]`,
      );
      if (node && node.classList.contains("is-placeholder")) {
        newPageFullyRendered = false;
        break;
      }
    }
    if (!newPageFullyRendered && pendingRestore.rounds < 8) {
      pendingRestore.rounds += 1;
      setRestoreTick((tick) => tick + 1);
      return;
    }

    pendingScrollRestoreRef.current = null;
    finishScrollRestore();
  }, [messages, activeConversationId, restoreTick, finishScrollRestore]);

  // 内容不足一屏时容器不可滚动，scroll 事件永不触发，唯一的分页入口
  // （handleChatScroll 的顶部阈值）就此死锁：首屏只取 CHAT_MESSAGE_PAGE_SIZE
  // 条 DB 记录，其中 role=tool 记录会被折叠进上一条 assistant，渲染高度可能
  // 远不满一屏。这里在每页落地后复检，仍不足一屏且还有更早记录就继续续页，
  // 直到出现滚动条或没有更多；连续两轮没让内容长高则停止，避免把整段历史
  // 全部拉进内存。
  useLayoutEffect(() => {
    const container = scrollRef.current;
    if (
      !container ||
      !activeConversationId ||
      !isChatAreaRendered ||
      !isInitialHistoryLoaded ||
      isLoadingInitialHistory ||
      isLoadingOlderMessages ||
      isStreaming ||
      !hasMoreMessages ||
      messages.length === 0 ||
      pendingScrollRestoreRef.current !== null ||
      isLoadingOlderWithScrollRef.current
    ) {
      return;
    }
    if (container.scrollHeight > container.clientHeight + 1) {
      return;
    }

    const baselineHeight = autoFillStartHeightRef.current;
    autoFillStartHeightRef.current = container.scrollHeight;
    if (baselineHeight > 0 && container.scrollHeight <= baselineHeight + 1) {
      autoFillStallRef.current += 1;
      if (autoFillStallRef.current > 1) {
        return;
      }
    } else {
      autoFillStallRef.current = 0;
    }

    void handleLoadOlderWithScroll();
  }, [
    activeConversationId,
    chatRenderKey,
    hasMoreMessages,
    isChatAreaRendered,
    isInitialHistoryLoaded,
    isLoadingInitialHistory,
    isLoadingOlderMessages,
    isStreaming,
    messages.length,
    restoreTick,
    handleLoadOlderWithScroll,
  ]);

  const markUserScrollIntent = useCallback(
    (direction: number): void => {
      isUserScrollIntentRef.current = true;
      isInitialBottomPositioningRef.current = false;
      lastUserScrollInputAtRef.current = performance.now();
      lastUserScrollInputDirectionRef.current = direction;

      // 用户真实输入立即接管视口：跟随动画与底部补间一并停止，
      // 避免下一帧动画把视口从用户正在查看的位置拽走。
      stopFollowAnimation();
      if (scrollToBottomAnimRef.current !== 0) {
        cancelAnimationFrame(scrollToBottomAnimRef.current);
        scrollToBottomAnimRef.current = 0;
      }
      isSmoothScrollingToBottomRef.current = false;
    },
    [stopFollowAnimation],
  );

  const handleChatPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      const container = event.currentTarget;
      if (container.scrollHeight <= container.clientHeight) {
        container.classList.remove("is-hovering-scrollbar");
        return;
      }
      const scrollbarStartX =
        container.getBoundingClientRect().left + container.clientWidth;
      container.classList.toggle(
        "is-hovering-scrollbar",
        event.clientX >= scrollbarStartX,
      );
    },
    [],
  );

  const handleChatPointerLeave = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      event.currentTarget.classList.remove("is-hovering-scrollbar");
    },
    [],
  );

  const flashChatScrollbar = useCallback((): void => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }
    container.classList.add("is-wheelscrolling");
    if (wheelScrollbarTimerRef.current !== 0) {
      window.clearTimeout(wheelScrollbarTimerRef.current);
    }
    wheelScrollbarTimerRef.current = window.setTimeout(() => {
      wheelScrollbarTimerRef.current = 0;
      container.classList.remove("is-wheelscrolling");
    }, 1000);
  }, []);

  const handleChatWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>): void => {
      const container = event.currentTarget;
      const deltaY = event.deltaY;
      if (deltaY === 0) {
        return;
      }
      // 嵌套滚动容器（Thinking 块等）消费的手势不改变对话跟随状态。
      if (willNestedScrollerConsumeWheel(container, event.target, deltaY)) {
        return;
      }

      markUserScrollIntent(deltaY < 0 ? -1 : 1);
      flashChatScrollbar();

      if (deltaY < 0) {
        // 向上滚 = 阅读历史：立即脱离跟随。容器已在顶部时手势不产生滚动，
        // 不应停掉自动滚动。
        if (container.scrollTop > 0) {
          shouldStickToBottomRef.current = false;
          syncScrollButtonVisibility(container);
        } else if (
          hasMoreMessages &&
          !isLoadingOlderMessages &&
          container.scrollHeight <= container.clientHeight + 1
        ) {
          // 内容不足一屏：容器没有可滚动区间，滚轮不产生 scroll 事件，
          // 常规的「滚到顶部加载更早记录」通道失效，这里按手势显式续页。
          void handleLoadOlderWithScroll();
        }
        return;
      }

      const distanceFromBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight;
      if (distanceFromBottom <= 0) {
        shouldStickToBottomRef.current = true;
        setShowScrollToBottom(false);
      }
    },
    [
      flashChatScrollbar,
      handleLoadOlderWithScroll,
      hasMoreMessages,
      isLoadingOlderMessages,
      markUserScrollIntent,
      syncScrollButtonVisibility,
    ],
  );

  const handleChatPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) {
        return;
      }
      const container = event.currentTarget;
      // 内容未溢出时滚动条区域只是一条空 gutter，点击不产生滚动，不算意图。
      if (container.scrollHeight <= container.clientHeight) {
        return;
      }

      const scrollbarStartX =
        container.getBoundingClientRect().left + container.clientWidth;
      if (event.clientX < scrollbarStartX) {
        return;
      }
      markUserScrollIntent(0);
      shouldStickToBottomRef.current = false;
    },
    [markUserScrollIntent],
  );

  const handleChatKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.target !== event.currentTarget) {
        return;
      }
      const scrollsUp =
        event.key === "ArrowUp" ||
        event.key === "PageUp" ||
        event.key === "Home" ||
        (event.key === " " && event.shiftKey);
      const scrollsDown =
        event.key === "ArrowDown" ||
        event.key === "PageDown" ||
        event.key === "End" ||
        (event.key === " " && !event.shiftKey);
      if (!scrollsUp && !scrollsDown) {
        return;
      }
      markUserScrollIntent(scrollsUp ? -1 : 1);
      if (scrollsUp && event.currentTarget.scrollTop > 0) {
        shouldStickToBottomRef.current = false;
      }
    },
    [markUserScrollIntent],
  );

  const handleChatScroll = useCallback((): void => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    deriveFollowStateFromScroll(container);

    // 只有“加载更早消息”检查走 rAF 节流，避免快速滚动时频繁触发分页逻辑。
    if (scrollRafIdRef.current !== 0) {
      return;
    }

    scrollRafIdRef.current = requestAnimationFrame(() => {
      scrollRafIdRef.current = 0;
      const throttledContainer = scrollRef.current;
      if (!throttledContainer) {
        return;
      }

      const isFollowingInitialContent =
        isInitialBottomPositioningRef.current && !isUserScrollIntentRef.current;
      if (isFollowingInitialContent) {
        return;
      }

      if (
        throttledContainer.scrollTop > LOAD_OLDER_SCROLL_THRESHOLD ||
        !hasMoreMessages ||
        isLoadingOlderMessages ||
        isLoadingOlderWithScrollRef.current
      ) {
        return;
      }

      void handleLoadOlderWithScroll();
    });
  }, [
    deriveFollowStateFromScroll,
    handleLoadOlderWithScroll,
    hasMoreMessages,
    isLoadingOlderMessages,
  ]);

  const handleScrollToBottom = useCallback((): void => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }

    // Cancel any tween already in flight before starting a new one.
    stopFollowAnimation();
    if (scrollToBottomAnimRef.current !== 0) {
      cancelAnimationFrame(scrollToBottomAnimRef.current);
      scrollToBottomAnimRef.current = 0;
    }

    shouldStickToBottomRef.current = true;
    isInitialBottomPositioningRef.current = false;
    isUserScrollIntentRef.current = false;
    lastUserScrollInputAtRef.current = -Infinity;
    lastUserScrollInputDirectionRef.current = 0;
    isSmoothScrollingToBottomRef.current = true;
    setShowScrollToBottom(false);

    const startTop = container.scrollTop;
    const startTimeMs = performance.now();
    const durationMs = 350;
    let lastTop = startTop;

    const tick = (nowMs: number): void => {
      if (scrollRef.current !== container) {
        scrollToBottomAnimRef.current = 0;
        isSmoothScrollingToBottomRef.current = false;
        return;
      }

      const maxScrollTop = container.scrollHeight - container.clientHeight;

      if (
        isUserScrollIntentRef.current &&
        Math.abs(container.scrollTop - lastTop) > 2
      ) {
        scrollToBottomAnimRef.current = 0;
        isSmoothScrollingToBottomRef.current = false;
        deriveFollowStateFromScroll(container);
        return;
      }

      const elapsed = nowMs - startTimeMs;
      const progress = Math.min(1, elapsed / durationMs);
      // easeOutCubic — decelerates to the target, feels native.
      const eased = 1 - Math.pow(1 - progress, 3);
      const currentTarget = startTop + (maxScrollTop - startTop) * eased;
      const nextTop = Math.min(currentTarget, maxScrollTop);
      container.scrollTop = nextTop;
      lastTop = nextTop;

      if (progress >= 1 || nextTop >= maxScrollTop - 1) {
        container.scrollTop = maxScrollTop;
        scrollToBottomAnimRef.current = 0;
        isSmoothScrollingToBottomRef.current = false;
        deriveFollowStateFromScroll(container);
        return;
      }

      scrollToBottomAnimRef.current = requestAnimationFrame(tick);
    };

    scrollToBottomAnimRef.current = requestAnimationFrame(tick);
  }, [deriveFollowStateFromScroll, stopFollowAnimation]);

  const handleSendWithScroll = useCallback(
    (message: string, options: ChatInputSendOptions) => {
      handleSendMessage(message, options);
      shouldStickToBottomRef.current = true;
      isInitialBottomPositioningRef.current = false;
      isUserScrollIntentRef.current = false;
      lastUserScrollInputAtRef.current = -Infinity;
      lastUserScrollInputDirectionRef.current = 0;
      setShowScrollToBottom(false);
      requestAnimationFrame(() => {
        glideOrPinToBottom();
      });
    },
    [handleSendMessage, glideOrPinToBottom],
  );

  // Cancel any pending scroll-throttle and scroll-to-bottom animation frames
  // on unmount.
  useEffect(() => {
    return () => {
      if (scrollRafIdRef.current !== 0) {
        cancelAnimationFrame(scrollRafIdRef.current);
        scrollRafIdRef.current = 0;
      }
      if (scrollToBottomAnimRef.current !== 0) {
        cancelAnimationFrame(scrollToBottomAnimRef.current);
        scrollToBottomAnimRef.current = 0;
      }
      if (wheelScrollbarTimerRef.current !== 0) {
        window.clearTimeout(wheelScrollbarTimerRef.current);
        wheelScrollbarTimerRef.current = 0;
      }
      stopFollowAnimation();
    };
  }, [stopFollowAnimation]);

  return {
    scrollRef,
    showScrollToBottom,
    markUserScrollIntent,
    handleChatWheel,
    handleChatPointerDown,
    handleChatPointerMove,
    handleChatPointerLeave,
    handleChatKeyDown,
    handleChatScroll,
    handleScrollToBottom,
    handleLoadOlderWithScroll,
    handleSendWithScroll,
    shouldStickToBottomRef,
    isInitialBottomPositioningRef,
    isUserScrollIntentRef,
  };
};
