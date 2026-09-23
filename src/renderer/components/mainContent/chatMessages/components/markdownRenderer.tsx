import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Download } from "lucide-react";
import "katex/dist/katex.min.css";
import MarkdownWorker from "./markdownWorker?worker";
import type {
  MarkdownChunk,
  MarkdownRenderRequest,
  MarkdownRenderResponse,
} from "./markdownWorker";
import {
  injectCachedDiagrams,
  openExportMenu,
  openMermaidImageViewer,
  renderMermaidBlocks,
  setMermaidView,
  watchThemeForMermaid,
} from "./mermaidRenderer";
import { openTableExportMenu } from "./tableExport";
import { openInSystemBrowser, openLinkOpenMenu } from "./linkOpenMenu";
import { useI18n } from "../../../../i18n";
import { downloadImageSrc } from "../../../../utils/imageDownload";
import { Tooltip } from "../../../common/Tooltip";

/**
 * Singleton Web Worker that performs markdown-it + highlight.js rendering off
 * the main thread. Shared by every MarkdownBlock instance so that cache state
 * (worker-side LRU) is preserved across the whole conversation.
 *
 * The worker is lazily created on first use to avoid paying the spawn cost for
 * conversations that never render markdown (e.g. an empty chat).
 */
let workerSingleton: Worker | null = null;

/**
 * Lazily create the shared markdown worker and attach a single global
 * `onmessage` listener that routes responses back to the pending request map.
 * A single listener is preferable to per-request `{ once: true }` listeners,
 * which would accumulate between dispatch and response when many frames are
 * in flight during a burst of streaming chunks.
 */
const getMarkdownWorker = (): Worker => {
  if (!workerSingleton) {
    const worker = new MarkdownWorker();
    worker.addEventListener("message", handleWorkerMessage as EventListener);
    workerSingleton = worker;
  }
  return workerSingleton;
};

/**
 * Monotonic request id used to correlate worker responses with the latest
 * content dispatched from a hook instance. A single shared counter is fine:
 * ids only need to be unique within the worker round-trip window, and using a
 * shared counter avoids per-instance state in the dispatch loop.
 */
let sharedRequestId = 0;
const nextRequestId = (): number => ++sharedRequestId;

/** 一次渲染请求的结果：changedFrom 起（含）的块需要重建。 */
type RenderedChunks = {
  changedFrom: number;
  chunks: MarkdownChunk[];
};

/**
 * Pending request registry. Keyed by request id so the global worker
 * `onmessage` handler can route the response back to the originating hook.
 * Entries are self-removing on resolve to avoid leaks.
 */
type PendingEntry = {
  resolve: (result: RenderedChunks) => void;
};
const pendingRequests = new Map<number, PendingEntry>();

const handleWorkerMessage = (
  event: MessageEvent<MarkdownRenderResponse>,
): void => {
  const { id, changedFrom, chunks } = event.data;
  const entry = pendingRequests.get(id);
  if (entry) {
    pendingRequests.delete(id);
    entry.resolve({ changedFrom, chunks });
  }
};

/**
 * 派发一次渲染。knownKeys 是调用方已提交（DOM 中已就位）的块指纹，worker
 * 只返回从第一处不同开始的块，调用方据此增量更新；streaming 为 true 时
 * worker 不写缓存——流式中间态每帧都不同，缓存它们没有任何复用价值。
 */
const dispatchRender = (
  content: string,
  knownKeys: string[],
  streaming: boolean,
): Promise<RenderedChunks> => {
  const worker = getMarkdownWorker();
  const id = nextRequestId();
  return new Promise<RenderedChunks>((resolve) => {
    pendingRequests.set(id, { resolve });
    const request: MarkdownRenderRequest = {
      id,
      content,
      knownKeys,
      streaming,
    };
    worker.postMessage(request);
  });
};

/** 主线程侧的 DOM 镜像：已提交块的指纹与对应的顶层节点。 */
type CommittedChunk = {
  key: string;
  nodes: Node[];
};

/**
 * 终态内容缓存（整份 content → 完整块列表）：只写入非流式（终态）渲染
 * 结果——流式中间态每帧都不同，存进来只会把上限挤满、徒增 GC（worker
 * 侧同理）。命中时组件首帧即可同步还原内容，翻页加载旧消息时不会先
 * 塌成空白再涌入。总量按条数 + 字节双上限控制。
 */
const CONTENT_CACHE_MAX_ENTRIES = 24;
const CONTENT_CACHE_MAX_BYTES = 4 * 1024 * 1024;
const CONTENT_CACHE_MAX_CONTENT_CHARS = 200_000;

type ContentCacheEntry = { chunks: MarkdownChunk[]; size: number };

const contentCache = new Map<string, ContentCacheEntry>();
let contentCacheBytes = 0;

const contentCacheGet = (content: string): MarkdownChunk[] | undefined => {
  const entry = contentCache.get(content);
  if (!entry) {
    return undefined;
  }
  // LRU：命中后移到队尾。
  contentCache.delete(content);
  contentCache.set(content, entry);
  return entry.chunks;
};

const contentCacheSet = (content: string, chunks: MarkdownChunk[]): void => {
  if (!content || content.length > CONTENT_CACHE_MAX_CONTENT_CHARS) {
    return;
  }
  if (contentCache.has(content)) {
    return;
  }
  let size = content.length;
  for (const chunk of chunks) {
    size += chunk.key.length + chunk.html.length;
  }
  while (
    contentCache.size >= CONTENT_CACHE_MAX_ENTRIES ||
    contentCacheBytes + size > CONTENT_CACHE_MAX_BYTES
  ) {
    const oldestKey = contentCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    const evicted = contentCache.get(oldestKey);
    contentCache.delete(oldestKey);
    if (evicted) {
      contentCacheBytes -= evicted.size;
    }
  }
  contentCache.set(content, { chunks, size });
  contentCacheBytes += size;
};

/**
 * 预热一批 markdown 渲染结果（翻页加载旧消息时使用）。
 *
 * MarkdownBlock 挂载时若缓存未命中，首帧为空，内容要等 worker 往返后才
 * 涌入——新插入消息的高度因此经历「近空白 → 真实高度」的剧变。
 * 分页加载的滚动恢复若在这个窗口期按偏小的 scrollHeight 补偿 scrollTop，
 * 视口位置必然错位，随后涌入的内容再推挤视口，表现为滚动位置跳变。
 * 翻页前先把渲染结果写进缓存，新消息挂载首帧即为最终高度。
 *
 * 带整体超时保护：worker 单例在流式输出期间被持续占用，预热请求可能
 * 排队很久；超时后放弃等待（已在途的渲染仍会写缓存），调用方照常
 * 渲染消息，不要让翻页卡死在预热上。
 */
export const prefetchMarkdown = async (
  contents: string[],
  timeoutMs = 1500,
): Promise<void> => {
  const pending = contents.filter(
    (content) => content && !contentCache.has(content),
  );
  if (pending.length === 0) {
    return;
  }
  await Promise.race([
    Promise.allSettled(
      pending.map(async (content) => {
        const { chunks } = await dispatchRender(content, [], false);
        contentCacheSet(content, chunks);
      }),
    ),
    new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs);
    }),
  ]);
};

/**
 * 流式柔和渐显使用的 CSS 类：每帧新增的文本被包进带该类名的 span，
 * 通过 opacity 动画从透明柔和浮现，替代打字机式的整块跳变。
 */
const MD_STREAM_FADE_CLASS = "md-stream-fade-in";

/** 深度优先找到 DOM 树中最后一个非空文本节点（流式新增内容的锚点）。 */
const findLastNonEmptyTextNode = (root: Node): Text | null => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  let current: Node | null;
  while ((current = walker.nextNode())) {
    const text = current as Text;
    if (text.nodeValue && text.nodeValue.trim().length > 0) {
      last = text;
    }
  }
  return last;
};

/** 节点列表中的最后一个非空文本节点（块级渲染下遍历范围只有该块）。 */
const findLastNonEmptyTextNodeIn = (nodes: readonly Node[]): Text | null => {
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const found = findLastNonEmptyTextNode(nodes[i]);
    if (found) {
      return found;
    }
  }
  return null;
};

/** 解析单块 HTML：只解析该块片段，不再对整篇内容做 DOM 级解析。 */
const parseChunkNodes = (html: string): Node[] => {
  const template = document.createElement("template");
  template.innerHTML = html;
  return Array.from(template.content.childNodes);
};

/**
 * 新增文本的淡入 span。动画结束后还原为普通文本节点，避免长时间流式
 * 在 DOM 中累积大量带残留动画的 span。
 */
const createFadeSpan = (text: string): HTMLSpanElement => {
  const span = document.createElement("span");
  span.className = MD_STREAM_FADE_CLASS;
  span.textContent = text;
  span.addEventListener(
    "animationend",
    () => {
      span.replaceWith(document.createTextNode(span.textContent ?? ""));
    },
    { once: true },
  );
  return span;
};

/**
 * 流式渲染最小间隔（ms）。
 *
 * 流式期间 content 每 chunk 都在变，长文本的 markdown 全量解析 + DOM 整块
 * 替换是流式高 CPU 的主因：若每帧（60fps）渲染一次，几万字内容每秒解析
 * 60 次，worker 与合成器双双打满。降到 10fps 后视觉无感（流式文本本身
 * 就在滚动），解析/布局/合成开销降低约 6 倍。
 *
 * 内容按安全边界分块后，每次只需重算变化的尾块，间隔维持不变即可。
 */
const MIN_RENDER_INTERVAL_MS = 100;
/** 超长文本（>= 100KB）的流式渲染间隔：块级增量后单次成本已与增量成
 *  正比，但固化块较多时切分扫描本身仍是 O(全文)，保留降频兜底。 */
const LONG_TEXT_THRESHOLD = 100_000;
const LONG_TEXT_INTERVAL_MS = 300;

/** 一批待提交的渲染结果：changedFrom 起（含）的块需要重建。 */
type PendingRender = {
  changedFrom: number;
  chunks: MarkdownChunk[];
  /** 该结果是否为流式渲染（流式提交走增量淡入路径） */
  streaming: boolean;
};

/**
 * Render streaming markdown with frame-aligned throttling.
 *
 * During the AI loop, `content` mutates on every streamed chunk (potentially
 * dozens of times per second). Re-rendering on every chunk janks the main
 * thread. Instead we coalesce updates to at most one render per animation
 * frame: the latest content is always used, and intermediate chunks are
 * dropped. This keeps the visible output responsive without queueing a
 * backlog of stale renders.
 *
 * 在帧合并 + 最小间隔节流之上：
 *   - 请求携带已提交块的指纹，worker 只回传从第一处不同开始的块；
 *   - paused（内容离屏/折叠）期间不派发，重新可见时立即渲染最新一版。
 *
 * The hook also tracks the latest in-flight request id so that out-of-order
 * worker responses never overwrite newer results.
 */
const useMarkdownRender = (
  content: string,
  options: {
    committedRef: { current: CommittedChunk[] };
    streaming: boolean;
    paused: boolean;
    minIntervalMs?: number;
  },
): { pending: PendingRender | null; version: number } => {
  const { committedRef, streaming, paused, minIntervalMs } = options;

  const [state, setState] = useState<{
    pending: PendingRender | null;
    version: number;
  }>(() => {
    // Warm the state synchronously from the cache when possible so that the
    // first paint after mount is not blank while the worker warms up.
    const cached = contentCacheGet(content);
    return cached
      ? {
          pending: { changedFrom: 0, chunks: cached, streaming: false },
          version: 1,
        }
      : { pending: null, version: 0 };
  });

  // Holds the latest content so the rAF callback always reads the newest
  // value without re-subscribing on every change.
  const contentRef = useRef(content);
  contentRef.current = content;
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // 未显式指定时按内容长度自适应：超长文本自动降频，避免 worker 打满。
  const intervalMsRef = useRef(MIN_RENDER_INTERVAL_MS);
  intervalMsRef.current =
    minIntervalMs ??
    (content.length >= LONG_TEXT_THRESHOLD
      ? LONG_TEXT_INTERVAL_MS
      : MIN_RENDER_INTERVAL_MS);

  // Tracks the request id of the most recent dispatch so that a late worker
  // response for a previous chunk cannot clobber a fresher one.
  const latestRequestIdRef = useRef(0);
  // Non-null while a frame is scheduled; used to dedupe rAF requests.
  const scheduledFrameRef = useRef<number | null>(null);
  // Timestamp of the last time a render result was committed to state.
  const lastRenderAtRef = useRef(0);

  const scheduleRender = useCallback((): void => {
    if (scheduledFrameRef.current !== null) {
      return;
    }

    const runRender = (): void => {
      scheduledFrameRef.current = null;
      // 内容不可见时（离屏/折叠）不派发：内容仍在变，等重新可见时渲染
      // 最新一版即可，期间省下 worker 与主线程的全部开销。
      if (pausedRef.current) {
        return;
      }
      // Throttle: if the minimum interval has not elapsed since the last
      // commit, defer to the next frame and re-check. While content keeps
      // changing (streaming), this naturally coalesces to ~10fps; once it
      // stabilizes, the final render fires within one interval.
      if (performance.now() - lastRenderAtRef.current < intervalMsRef.current) {
        scheduledFrameRef.current = requestAnimationFrame(runRender);
        return;
      }
      const currentContent = contentRef.current;
      const isStreaming = streamingRef.current;
      const requestId = nextRequestId();
      latestRequestIdRef.current = requestId;
      const knownKeys = committedRef.current.map((chunk) => chunk.key);
      void dispatchRender(currentContent, knownKeys, isStreaming).then(
        ({ changedFrom, chunks }) => {
          // Drop stale results: if a newer request superseded this one while
          // the worker was busy, keep the newer one authoritative.
          if (latestRequestIdRef.current !== requestId) {
            return;
          }
          lastRenderAtRef.current = performance.now();
          if (!isStreaming && changedFrom === 0) {
            // 终态且拿到完整块列表：缓存下来，供重挂载/翻页首帧同步还原。
            contentCacheSet(currentContent, chunks);
          }
          if (
            changedFrom >= committedRef.current.length &&
            chunks.length === 0
          ) {
            return;
          }
          setState((prev) => ({
            pending: { changedFrom, chunks, streaming: isStreaming },
            version: prev.version + 1,
          }));
        },
      );
    };

    scheduledFrameRef.current = requestAnimationFrame(runRender);
  }, [committedRef]);

  useEffect(() => {
    if (paused) {
      return;
    }
    // Fast path: synchronous cache hit — no frame scheduling needed.
    const cached = contentCacheGet(content);
    if (cached) {
      latestRequestIdRef.current = 0;
      setState((prev) => ({
        pending: { changedFrom: 0, chunks: cached, streaming: false },
        version: prev.version + 1,
      }));
      return;
    }
    scheduleRender();
  }, [content, paused, scheduleRender]);

  // Cancel any pending rAF on unmount. The shared worker itself is left
  // alive (singleton) so other MarkdownBlock instances keep their warm cache;
  // it is cheap to keep around and avoids re-spawn churn when switching chats.
  useEffect(() => {
    return () => {
      if (scheduledFrameRef.current !== null) {
        cancelAnimationFrame(scheduledFrameRef.current);
        scheduledFrameRef.current = null;
      }
    };
  }, []);

  return { pending: state.pending, version: state.version };
};

/** 来源徽章悬停信息（fixed 坐标系 + 摘要数据）。 */
type BadgeHoverInfo = {
  x: number;
  top: number;
  width: number;
  height: number;
  title: string;
  url: string;
  summary: string;
  host: string;
};

/** favicon 加载结果缓存（按 img-proxy URL），会话内不重复探测。 */
const faviconStatusCache = new Map<string, "ok" | "fail">();

/**
 * 已注册 load/error 监听的 img。流式期间 bindFaviconFallback 随每次渲染
 * 重入，同一 img 只允许绑定一次监听，避免 once 监听器随渲染次数累积。
 */
const faviconBoundImgs = new WeakSet<HTMLImageElement>();

/** 默认显示地球占位图标，真实 favicon 加载成功才加 favicon-ok 切换显示；
 *  失败/缺失稳定回退默认图标。须在 useLayoutEffect 中调用（paint 前判定，
 *  缓存命中时 complete=true 同步确定，避免首帧闪烁）。 */
const bindFaviconFallback = (root: HTMLElement): void => {
  root
    .querySelectorAll<HTMLImageElement>("img.md-source-badge-favicon")
    .forEach((img) => {
      const badge = img.closest(".md-source-badge");
      if (!badge) {
        return;
      }
      const cached = faviconStatusCache.get(img.src);
      if (cached === "ok") {
        badge.classList.add("favicon-ok");
        return;
      }
      if (cached === "fail") {
        return;
      }
      const markLoaded = (): void => {
        faviconStatusCache.set(img.src, "ok");
        badge.classList.add("favicon-ok");
      };
      if (img.complete) {
        if (img.naturalWidth > 0) {
          markLoaded();
        } else {
          faviconStatusCache.set(img.src, "fail");
        }
        return;
      }
      // 流式重入防抖：已在等待加载结果的 img 不重复绑定监听。
      if (faviconBoundImgs.has(img)) {
        return;
      }
      faviconBoundImgs.add(img);
      img.addEventListener("load", markLoaded, { once: true });
      img.addEventListener(
        "error",
        () => {
          faviconStatusCache.set(img.src, "fail");
          // 防御：favicon-ok 已加上后本次加载仍失败（DOM 重建后重新请求），
          // 摘掉标记回退占位图标，避免出现空白图标。
          badge.classList.remove("favicon-ok");
        },
        { once: true },
      );
    });
};

/** 判断非 http(s) href 是否像本地文件链接（相对路径/绝对路径/带扩展名文件名）。 */
const isFileLinkHref = (href: string): boolean => {
  if (!href || href.length > 512 || /\s/.test(href)) {
    return false;
  }
  // 页内锚点与协议链接（mailto:/tel:/data: 等）不是文件链接；Windows 盘符（C:\）除外。
  if (href.startsWith("#")) {
    return false;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[a-zA-Z]:[\\/]/.test(href)) {
    return false;
  }
  return (
    /[\\/]/.test(href) || /(?:^|[\\/])[^\\/]+\.[a-zA-Z0-9]{1,12}$/.test(href)
  );
};

/**
 * 把一次渲染结果提交到容器：先与已提交块对齐（key 相同的块保持现有 DOM
 * 不动，因此同一结果重复提交是幂等的），再只重建真正变化的块。
 *
 * 流式时的淡入保持原观感：
 *   - 尾块仍是"文本继续增长"时复用它的 DOM，只把新增文本包成淡入 span；
 *   - 否则重建该块并让新的最后一段文本整体淡入。
 */
const commitMarkdownChunks = (
  container: HTMLElement,
  committed: CommittedChunk[],
  pending: PendingRender,
  lastTailTextRef: { current: string },
): void => {
  const { changedFrom, chunks, streaming } = pending;

  // 与已提交块对齐：worker 判定的变化点之后，仍可能有一批 key 相同的块
  // （例如缓存命中后的重复提交），这些块无需重建。
  let index = Math.min(changedFrom, committed.length);
  let cursor = 0;
  while (
    cursor < chunks.length &&
    index < committed.length &&
    committed[index].key === chunks[cursor].key
  ) {
    index += 1;
    cursor += 1;
  }

  // 尾块复用：唯一要替换的旧块就是尾块，且新尾块的最后一个文本是旧文本的
  // 延长——保持旧 DOM 稳定，只追加新增文本（流式最常见的路径）。文本不
  // 连续或结构变化时落到下方重建路径。
  const tailIndex = committed.length - 1;
  const tailNodes = tailIndex >= 0 ? committed[tailIndex].nodes : [];
  let reuseTail = false;
  let appendText = "";
  let parsedTailNodes: Node[] | null = null;
  if (
    streaming &&
    chunks.length === 1 &&
    cursor === 0 &&
    index === tailIndex &&
    tailNodes.length > 0 &&
    lastTailTextRef.current !== ""
  ) {
    parsedTailNodes = parseChunkNodes(chunks[0].html);
    const tailText =
      findLastNonEmptyTextNodeIn(parsedTailNodes)?.nodeValue ?? "";
    if (tailText.startsWith(lastTailTextRef.current)) {
      reuseTail = true;
      appendText = tailText.slice(lastTailTextRef.current.length);
      lastTailTextRef.current = tailText;
      committed[tailIndex] = { key: chunks[0].key, nodes: tailNodes };
    }
  }

  // 删除需要重建的旧块节点。
  const removeFrom = reuseTail ? committed.length : index;
  for (let i = committed.length - 1; i >= removeFrom; i -= 1) {
    for (const node of committed[i].nodes) {
      node.parentNode?.removeChild(node);
    }
  }
  if (committed.length > removeFrom) {
    committed.length = removeFrom;
  }

  if (reuseTail) {
    if (appendText.trim().length > 0) {
      const domLastText = findLastNonEmptyTextNodeIn(tailNodes);
      if (domLastText?.parentNode) {
        domLastText.parentNode.insertBefore(
          createFadeSpan(appendText),
          domLastText.nextSibling,
        );
      }
    }
  } else {
    for (let i = cursor; i < chunks.length; i += 1) {
      const nodes =
        parsedTailNodes && i === cursor
          ? parsedTailNodes
          : parseChunkNodes(chunks[i].html);
      const fragment = document.createDocumentFragment();
      for (const node of nodes) {
        fragment.appendChild(node);
      }
      container.appendChild(fragment);
      for (const node of nodes) {
        // favicon 判定只针对新增节点，且必须在插入文档后（缓存命中的
        // 图片插入后才 complete，可同步确定，不再每次扫描整个容器）。
        if (node.nodeType === Node.ELEMENT_NODE) {
          bindFaviconFallback(node as HTMLElement);
        }
      }
      committed.push({ key: chunks[i].key, nodes });
    }

    // 新插入内容里最后一段文本整体淡入（与整块重建时的观感一致）。
    if (streaming && chunks.length > cursor) {
      const lastNodes = committed[committed.length - 1]?.nodes ?? [];
      const lastText = findLastNonEmptyTextNodeIn(lastNodes);
      if (lastText) {
        const text = lastText.nodeValue ?? "";
        lastText.parentNode?.replaceChild(createFadeSpan(text), lastText);
        lastTailTextRef.current = text;
      }
    }
  }

  if (!streaming) {
    lastTailTextRef.current = "";
  }
};

export const MarkdownBlock = memo(
  ({
    className,
    content,
    streaming = false,
    onFileLinkClick,
    minRenderIntervalMs,
    paused = false,
  }: {
    className: string;
    content: string;
    streaming?: boolean;
    /** 非 http(s) 文件链接点击回调：宿主（如右侧文件阅读器）用它打开新阅读器 tab。 */
    onFileLinkClick?: (href: string) => void;
    /** 流式渲染最小间隔（ms），覆盖默认 100ms。思考过程等幕后内容可传更大值。 */
    minRenderIntervalMs?: number;
    /** 内容不可见（离屏/折叠）时暂停派发渲染：内容照常记录，重新可见后立即渲染最新版。 */
    paused?: boolean;
  }): React.JSX.Element => {
    const { t } = useI18n();

    const containerRef = useRef<HTMLDivElement | null>(null);
    // 已提交块（主线程侧 DOM 镜像）：随提交更新，供下一次请求声明已就位的块。
    const committedRef = useRef<CommittedChunk[]>([]);
    // 尾块最后一个非空文本节点的文本：流式增量追加时判断新文本是否为旧文本的延长。
    const lastTailTextRef = useRef("");
    const { pending, version } = useMarkdownRender(content, {
      committedRef,
      streaming,
      paused,
      minIntervalMs: minRenderIntervalMs,
    });

    // Markdown 图片灯箱：点击图片在放大视图中查看（复用生图工具灯箱样式）。
    const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

    // 来源徽章悬停 Tooltip 状态。
    const [hoverBadge, setHoverBadge] = useState<BadgeHoverInfo | null>(null);

    // 徽章悬停：收集位置与数据，渲染 Tooltip。
    const handleBadgeMouseOver = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        const badge = (e.target as HTMLElement).closest(
          ".md-source-badge",
        ) as HTMLElement | null;
        if (!badge) {
          return;
        }
        const rect = badge.getBoundingClientRect();
        const url = badge.dataset.url ?? "";
        let host = "";
        try {
          host = url ? new URL(url).host : "";
        } catch {
          host = "";
        }
        setHoverBadge({
          x: rect.left + rect.width / 2,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          title: badge.dataset.title ?? "",
          url,
          summary: badge.dataset.summary ?? "",
          host,
        });
      },
      [],
    );

    // 离开徽章（含徽章内部移动）时关闭。
    const handleBadgeMouseOut = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        const related = e.relatedTarget as HTMLElement | null;
        if (related?.closest?.(".md-source-badge")) {
          return;
        }
        setHoverBadge(null);
      },
      [],
    );

    // Esc 关闭灯箱
    useEffect(() => {
      if (!lightboxSrc) {
        return;
      }
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          setLightboxSrc(null);
        }
      };
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }, [lightboxSrc]);

    // 块级增量提交：只重建变化的块，已提交块的 DOM 保持稳定不动；
    // 流式新增文本的柔和渐显与结构变化时的整体淡入在提交内完成。
    // 同一结果重复提交是幂等的（见 commitMarkdownChunks）。
    useLayoutEffect(() => {
      const node = containerRef.current;
      if (!node || !pending) {
        return;
      }
      commitMarkdownChunks(
        node,
        committedRef.current,
        pending,
        lastTailTextRef,
      );
    }, [pending]);

    // During streaming, skip all mermaid operations entirely — only the code
    // view is shown. Once streaming ends (`streaming` flips to false), both
    // phases fire in a single pass to render every diagram at once. This
    // avoids any flicker from repeatedly attempting to parse incomplete code.
    //
    // Phase 1 — synchronous cache injection (before browser paint) so that
    // already-rendered diagrams appear right after a chunk commit.
    useLayoutEffect(() => {
      if (streaming) return;
      const node = containerRef.current;
      if (node && version > 0) {
        injectCachedDiagrams(node);
      }
    }, [version, streaming]);

    // Phase 2 — async rendering of uncached diagrams, debounced via rAF.
    useEffect(() => {
      if (streaming) return;
      const node = containerRef.current;
      if (!node || version === 0) return;

      const frame = requestAnimationFrame(() => {
        void renderMermaidBlocks(node);
      });
      return () => cancelAnimationFrame(frame);
    }, [version, streaming]);

    // Attach the global theme-change observer once for the whole app so that
    // diagrams re-render when the user switches between light/dark.
    useEffect(() => watchThemeForMermaid(), []);

    const handleClick = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        const target = e.target as HTMLElement;

        // --- 来源徽章点击：弹出内部/系统浏览器选择菜单 ---
        const badge = target.closest(".md-source-badge") as HTMLElement | null;
        if (badge) {
          const url = badge.dataset.url ?? "";
          if (e.button === 0 && /^https?:\/\//i.test(url)) {
            e.preventDefault();
            if (e.metaKey || e.ctrlKey) {
              openInSystemBrowser(url);
            } else {
              openLinkOpenMenu(e.clientX, e.clientY, url, {
                inApp: t("markdown.link.openInApp"),
                external: t("markdown.link.openExternal"),
              });
            }
          }
          return;
        }

        // --- 普通链接拦截 ---
        // markdown-it 默认渲染出的 <a> 没有 target，普通点击会走 Electron 默认行为
        // （主进程 setWindowOpenHandler 转交系统浏览器）。这里统一拦截：普通点击弹出
        // 内部/系统浏览器选择菜单，Cmd/Ctrl+点击直接系统浏览器打开；中键不拦截，
        // 放行 Electron 默认转交系统浏览器。仅处理 http(s) 链接，
        // 非 http(s) 的（如 mailto:）保持默认行为。
        const anchor = target.closest("a") as HTMLAnchorElement | null;
        if (anchor) {
          const href = anchor.getAttribute("href") ?? "";
          if (/^https?:\/\//i.test(href)) {
            if (e.button !== 0) {
              return;
            }
            e.preventDefault();
            if (e.metaKey || e.ctrlKey) {
              openInSystemBrowser(href);
            } else {
              openLinkOpenMenu(e.clientX, e.clientY, href, {
                inApp: t("markdown.link.openInApp"),
                external: t("markdown.link.openExternal"),
              });
            }
            return;
          }
          // 非 http(s) 链接：若像本地文件路径且宿主提供了回调（右侧文件阅读器），
          // 拦截默认导航（渲染进程导航到相对 URL 会直接黑屏），
          // 改为在右侧面板新建文件阅读器 tab。
          if (onFileLinkClick && isFileLinkHref(href)) {
            e.preventDefault();
            onFileLinkClick(href);
            return;
          }
        }

        // --- Markdown 图片点击放大 ---
        // 复用生图工具灯箱体验：点击图片在放大视图中查看（本地/远程图均已是
        // img-proxy:// URL）。在链接处理之后执行，保证 a 内的图片仍优先走链接逻辑。
        const image = target.closest("img") as HTMLImageElement | null;
        if (image) {
          const src = image.currentSrc || image.src;
          if (src) {
            e.preventDefault();
            setLightboxSrc(src);
            return;
          }
        }

        // --- Markdown 表格下载：按钮弹出 CSV / XLSX 格式菜单 ---
        const tableDownloadBtn = target.closest(
          "[data-table-action='download']",
        ) as HTMLElement | null;
        if (tableDownloadBtn) {
          const table = tableDownloadBtn
            .closest(".table-wrapper")
            ?.querySelector<HTMLTableElement>("table");
          if (table) {
            e.preventDefault();
            openTableExportMenu(tableDownloadBtn, table);
          }
          return;
        }

        // --- Mermaid block interactions ---
        const mermaidBlock = target.closest(
          ".mermaid-block",
        ) as HTMLElement | null;

        // Copy mermaid source
        if (mermaidBlock) {
          const copyBtn = target.closest(
            ".mermaid-btn-copy",
          ) as HTMLElement | null;
          if (copyBtn) {
            const raw = copyBtn.dataset.code;
            if (raw) {
              const code = decodeURIComponent(raw);
              navigator.clipboard.writeText(code).then(() => {
                copyBtn.classList.add("copied");
                window.setTimeout(
                  () => copyBtn.classList.remove("copied"),
                  2000,
                );
              });
            }
            return;
          }

          // Toggle code / diagram view, or open export menu
          const actionBtn = target.closest(
            "[data-mermaid-action]",
          ) as HTMLElement | null;
          if (actionBtn) {
            const action = actionBtn.dataset.mermaidAction;
            if (action === "code" || action === "diagram") {
              setMermaidView(mermaidBlock, action);
            } else if (action === "download") {
              openExportMenu(actionBtn, mermaidBlock);
            }
            return;
          }

          // Click on the rendered diagram opens the full-size viewer.
          if (target.closest(".mermaid-view-diagram svg")) {
            openMermaidImageViewer(mermaidBlock);
            return;
          }
        }

        // --- Handoff tag（工作流交接文档折叠块）展开/收起 ---
        const handoffToggle = target.closest(
          ".md-handoff-toggle",
        ) as HTMLElement | null;
        if (handoffToggle) {
          const block = handoffToggle.closest(".md-handoff-block");
          if (block) {
            block.classList.toggle("expanded");
            handoffToggle.setAttribute(
              "aria-expanded",
              block.classList.contains("expanded") ? "true" : "false",
            );
          }
          return;
        }

        // --- Regular code block interactions ---
        // Handle collapse / expand toggle
        const langBtn = target.closest(
          ".code-block-lang",
        ) as HTMLElement | null;
        if (langBtn) {
          const wrapper = langBtn.closest(".code-block-wrapper");
          if (wrapper) {
            wrapper.classList.toggle("collapsed");
          }
          return;
        }

        // Handle copy button
        const copyBtn = target.closest(
          ".code-block-copy",
        ) as HTMLElement | null;
        if (!copyBtn) return;

        const raw = copyBtn.dataset.code;
        if (!raw) return;

        const code = decodeURIComponent(raw);
        navigator.clipboard.writeText(code).then(() => {
          copyBtn.classList.add("copied");
          window.setTimeout(() => copyBtn.classList.remove("copied"), 2000);
        });
      },
      [onFileLinkClick, t],
    );

    return (
      <>
        <div
          className={className}
          onClick={handleClick}
          onAuxClick={handleClick}
          onMouseOver={handleBadgeMouseOver}
          onMouseOut={handleBadgeMouseOut}
          ref={containerRef}
        />
        {lightboxSrc
          ? createPortal(
              <div
                className="tool-call-imagegen-lightbox markdown-image-lightbox"
                onClick={() => setLightboxSrc(null)}
                role="presentation"
              >
                <img
                  src={lightboxSrc}
                  alt=""
                  draggable={false}
                  onClick={(event) => event.stopPropagation()}
                />
                <div
                  className="tool-call-imagegen-lightbox-toolbar"
                  onClick={(event) => event.stopPropagation()}
                >
                  <button
                    type="button"
                    className="tool-call-imagegen-download"
                    onClick={() => {
                      void downloadImageSrc(lightboxSrc).catch((error) => {
                        console.error("[markdown] save image failed:", error);
                      });
                    }}
                    title="下载"
                    aria-label="下载"
                  >
                    <Download size={13} aria-hidden="true" />
                    下载
                  </button>
                  <button
                    type="button"
                    className="tool-call-imagegen-lightbox-close"
                    onClick={() => setLightboxSrc(null)}
                    aria-label="关闭"
                  >
                    ✕
                  </button>
                </div>
              </div>,
              document.body,
            )
          : null}

        {/* 来源徽章悬停 Tooltip（受控 visible，anchor 为 0 尺寸占位）。 */}
        {hoverBadge
          ? createPortal(
              <span
                className="md-source-tooltip-host"
                style={{ left: hoverBadge.x, top: hoverBadge.top }}
              >
                <Tooltip
                  visible
                  content={
                    <span className="md-source-tooltip">
                      <strong className="md-source-tooltip-title">
                        {hoverBadge.title}
                      </strong>
                      {hoverBadge.summary ? (
                        <span className="md-source-tooltip-summary">
                          {hoverBadge.summary}
                        </span>
                      ) : null}
                      <span className="md-source-tooltip-url">
                        {hoverBadge.host}
                      </span>
                    </span>
                  }
                >
                  <span className="md-source-badge-anchor" aria-hidden="true" />
                </Tooltip>
              </span>,
              document.body,
            )
          : null}
      </>
    );
  },
);

MarkdownBlock.displayName = "MarkdownBlock";
