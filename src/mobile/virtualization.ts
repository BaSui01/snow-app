/**
 * 消息区视口虚拟化（移动端）。
 *
 * 与桌面端 useViewportVirtualization / VirtualizedMessage 同一套思路：
 * 长会话下消息列表持续增长，而每轮 /api/state 轮询只要签名变化就要重绘
 * 消息区——视口外的消息即使看不见也一直挂在文档里，Markdown、代码高亮、
 * 工具卡片与思考全文都要参与布局重排与绘制，消息越多越卡（滚动掉帧、
 * 键盘弹出 / 屏幕旋转后的页面伸缩迟缓）。
 *
 * 这里用一个共享 IntersectionObserver 跟踪「哪些消息 id 位于滚动视口内
 * （含上下 600px 缓冲）」：视口外的消息整体卸载内容（.message-shell 及其
 * 全部块），只留一个按实测高度撑开的空 article；回到视口内时按需重建。
 *   - 视口外消息不再参与每轮快照的块级 diff 与 Markdown 重建；
 *   - 视口外消息从布局树中消失，滚动 / 键盘弹出时的重排成本大幅下降；
 *   - 图片、代码高亮等重资源随内容卸载，长会话内存占用明显降低。
 *
 * 高度稳定性是虚拟化的前提：消息切换为占位符时必须与真实内容同高，否则
 * 滚动条会跳动。ResizeObserver 持续把真实内容高度写入高度缓存
 * （Map<id, px>，按 id 节流），占位符直接取缓存值；从未测量过的消息回退到
 * 80px 默认值。
 *
 * 恒定渲染（无论几何位置）的消息：
 *   - 最后一条 assistant 消息，流式输出始终留在 DOM 里（setPinnedMessageIds）；
 *   - 「加载更早」新分页进来的消息与刚完成 id 迁移的消息（markForceVisible），
 *     它们必须在观察器给出首批判定前就按真实内容排版，否则翻页的滚动恢复
 *     会按 80px 占位符几何校正，真实内容展开后视口被顶下去。
 */

/** 视口上下额外保持渲染的缓冲像素：快速滚动时不至于先闪出空占位符。 */
const VIEWPORT_BUFFER_PX = 600;
/** 从未测量过高度的消息，占位符回退高度。 */
const PLACEHOLDER_FALLBACK_HEIGHT = 80;
/** 单个 id 高度写缓存的最小间隔（ms）：流式期间 ResizeObserver 会连发。 */
const HEIGHT_MEASURE_THROTTLE_MS = 200;
/** 占位符节点的类名标记：高度来自 inline style，不参与高度测量。 */
const PLACEHOLDER_CLASS = "is-placeholder";

/** 可见集合变化时的回调（由 timeline 提供：重绘消息区）。 */
let onVisibilityChange: () => void = () => {};
/**
 * 当前应渲染真实内容的 id 集合；null = 观察器尚未给出首批报告，
 * 此时所有消息都渲染真实内容（首屏不会是一墙空占位符）。
 */
let visibleIds: ReadonlySet<string> | null = null;
/** 恒定渲染的消息 id（流式中的最后一条 assistant）。 */
let pinnedIds: ReadonlySet<string> = new Set<string>();
/** id → 最近一次实测渲染高度（px），供占位符取用。 */
const heights = new Map<string, number>();
/** 双向映射：观察器目标 ↔ 消息 id。 */
const nodeToId = new Map<HTMLElement, string>();
const idToNode = new Map<string, HTMLElement>();
/** id → 最近测量时间，用于节流高度写入。 */
const lastMeasureAt = new Map<string, number>();
/** 当前与视口相交的 id：观察器回调里原地增删，变化时才推给 visibleIds。 */
const intersectingIds = new Set<string>();
/** 在观察器给出首批判定前强制真实渲染的 id（新分页 / id 迁移）。 */
const forceVisibleIds = new Set<string>();
/** 待测量高度的 id：每轮 reconcile 结束后一次性批量测量（单次强制布局）。 */
const measureQueue = new Set<string>();

let intersectionObserver: IntersectionObserver | null = null;
let resizeObserver: ResizeObserver | null = null;

const sameIdSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
};

/** 由「相交 + 强制可见 + 恒定渲染」重算可见集合，变化时才通知调用方重绘。 */
const flushVisibleIds = (): void => {
  const next = new Set<string>(intersectingIds);
  for (const id of forceVisibleIds) next.add(id);
  for (const id of pinnedIds) next.add(id);
  if (visibleIds !== null && sameIdSet(visibleIds, next)) return;
  visibleIds = next;
  onVisibilityChange();
};

/** IntersectionObserver 回调：维护相交 id 集合。 */
const handleIntersection = (entries: IntersectionObserverEntry[]): void => {
  let changed = false;
  for (const entry of entries) {
    const id = nodeToId.get(entry.target as HTMLElement);
    if (!id) continue;
    // 观察器已给出该 id 的权威判定：强制可见的逃生通道功成身退。
    if (forceVisibleIds.delete(id)) changed = true;
    if (entry.isIntersecting) {
      if (!intersectingIds.has(id)) {
        intersectingIds.add(id);
        changed = true;
      }
    } else if (intersectingIds.delete(id)) {
      changed = true;
    }
  }
  if (changed) flushVisibleIds();
};

/** ResizeObserver 回调：把真实内容高度写入缓存（占位符高度来自 inline
 *  style，不是真实内容高度，写回会污染实测值）。高度变化无需重绘：占位符
 *  在创建 / 虚拟化的那一刻读取缓存值。 */
const handleResize = (entries: ResizeObserverEntry[]): void => {
  const now = Date.now();
  for (const entry of entries) {
    const node = entry.target as HTMLElement;
    if (node.classList.contains(PLACEHOLDER_CLASS)) continue;
    const id = nodeToId.get(node);
    if (!id) continue;
    if (now - (lastMeasureAt.get(id) ?? 0) < HEIGHT_MEASURE_THROTTLE_MS) {
      continue;
    }
    const height = Math.round(entry.contentRect.height);
    if (height <= 0) continue;
    lastMeasureAt.set(id, now);
    heights.set(id, height);
  }
};

export const initViewportVirtualization = (
  root: HTMLElement,
  onVisibilityFlushed: () => void,
): void => {
  onVisibilityChange = onVisibilityFlushed;
  intersectionObserver = new IntersectionObserver(handleIntersection, {
    root,
    rootMargin: `${VIEWPORT_BUFFER_PX}px 0px ${VIEWPORT_BUFFER_PX}px 0px`,
    threshold: 0,
  });
  resizeObserver = new ResizeObserver(handleResize);
};

/**
 * 会话切换 / 消息区整表重建：可见集与高度缓存全部失效（消息 id、滚动位置
 * 都换了），回到「未初始化」状态——下一次重绘渲染全部真实内容，随后由
 * 观察器首批报告接管。
 */
export const resetViewportVirtualization = (): void => {
  visibleIds = null;
  pinnedIds = new Set<string>();
  heights.clear();
  lastMeasureAt.clear();
  measureQueue.clear();
  intersectingIds.clear();
  forceVisibleIds.clear();
  for (const node of idToNode.values()) {
    intersectionObserver?.unobserve(node);
    resizeObserver?.unobserve(node);
  }
  idToNode.clear();
  nodeToId.clear();
};

/** 设置恒定渲染的消息 id（流式中的最后一条 assistant）。 */
export const setPinnedMessageIds = (ids: ReadonlySet<string>): void => {
  pinnedIds = ids;
};

/**
 * 该消息本轮是否渲染真实内容。
 *
 * visibleIds 为 null 表示观察器尚未给出首批报告，全部按真实内容渲染；
 * 此外强制可见与恒定渲染的 id 无条件真实渲染。
 */
export const isMessageVisible = (id: string): boolean =>
  visibleIds === null ||
  visibleIds.has(id) ||
  forceVisibleIds.has(id) ||
  pinnedIds.has(id);

/** 在观察器给出首批判定前保持真实渲染（新分页 / id 迁移的消息）。 */
export const markForceVisible = (ids: Iterable<string>): void => {
  for (const id of ids) forceVisibleIds.add(id);
};

/** 占位符高度：优先取实测缓存，未测量过的消息用默认值。 */
export const messagePlaceholderHeight = (id: string): number =>
  heights.get(id) ?? PLACEHOLDER_FALLBACK_HEIGHT;

/** 消息节点从列表移除（不再是当前会话的消息）：停止观察并清掉 id 绑定。 */
export const detachMessageNode = (id: string): void => {
  const node = idToNode.get(id);
  if (!node) return;
  intersectionObserver?.unobserve(node);
  resizeObserver?.unobserve(node);
  nodeToId.delete(node);
  idToNode.delete(id);
  measureQueue.delete(id);
  forceVisibleIds.delete(id);
  intersectingIds.delete(id);
};

/**
 * 消息节点进入 DOM（真实内容或占位符）：登记观察并排队一次高度测量。
 * 占位符同样要被观察——否则滚回视口时无法复活。
 */
export const attachMessageNode = (id: string, node: HTMLElement): void => {
  const previous = idToNode.get(id);
  if (previous && previous !== node) detachMessageNode(id);
  idToNode.set(id, node);
  nodeToId.set(node, id);
  intersectionObserver?.observe(node);
  resizeObserver?.observe(node);
  measureQueue.add(id);
};

/**
 * 每轮消息区重绘结束后调用：对新增 / 复活的真实内容节点做一次批量高度测量。
 * 循环结束后才读取几何，整个批次只触发一次强制布局；测量的意义在于紧随其
 * 后的 IntersectionObserver 首批报告能立刻用实测高度占位，避免文档高度先
 * 塌成 80px 再撑开造成的滚动跳动。
 */
export const flushMessageMeasures = (): void => {
  if (measureQueue.size === 0) return;
  const now = Date.now();
  for (const id of Array.from(measureQueue)) {
    measureQueue.delete(id);
    const node = idToNode.get(id);
    if (!node) continue;
    if (node.classList.contains(PLACEHOLDER_CLASS)) continue;
    const height = Math.round(node.getBoundingClientRect().height);
    if (height <= 0) continue;
    heights.set(id, height);
    lastMeasureAt.set(id, now);
  }
};
