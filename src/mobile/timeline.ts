import type {
  SnowRemoteMessage,
  SnowRemoteState,
  SnowRemoteToolCall,
} from "../renderer/types/remoteControl";
import { fetchOlderMessages } from "./api";
import { $, escapeHtml } from "./dom";
import { messageTime } from "./format";
import { t } from "./i18n";
import { iconMarkup } from "./icons";
import { renderMarkdown } from "./markdown";
import { showNotice } from "./notice";
import { openImageLightbox } from "./overlays";

/**
 * 时间线渲染。
 *
 * 渲染策略（避免整段 innerHTML 重建）：
 * - 消息级 diff：按 id 复用消息节点，只有签名变化的消息才会被更新；
 * - 块级 diff：消息内部按「思考 / 正文 / 工具活动 / 光标 / 时间」
 *   分块比较，只替换发生变化的块；details 一律默认折叠（工具执行中 / 思考
 *   进行中都不自动展开，思考折叠时在头部显示单行预览），仅用户手动展开过
 *   的 details 在重建时保留展开状态；未变化的块保持原样；
 * - 工具活动再做工具级 diff，单个工具的流式输出不会重建其余工具。
 *
 * 消息模型：
 * - knownList 本地单调累积当前会话的全部已知消息（state 的消息窗口 +
 *   通过「加载更早」分页拿到的历史），并处理桌面端用户消息落库后
 *   「前端临时 id → 数据库 snowflake id」的原地迁移（见
 *   reconcileRemappedUserIds），避免同一消息以新旧两个 id 重复出现；
 * - 「是否还有更早记录」以桌面会话的 DB 分页状态（state.hasOlderMessages）
 *   为准，移动端自己加载过历史后以服务端响应的 hasMore 为准；
 * - 会话切换时清空并整表重建。
 */

/** 单次「加载更早」的分页大小（服务端限制 <= 50）。 */
const OLDER_PAGE_SIZE = 30;
/** 滚动到距顶部该像素范围内，自动触发加载更早记录。 */
const LOAD_EARLIER_THRESHOLD = 160;
/** 距底部小于该像素视为「在底部」：自动跟随与按钮显隐共用同一阈值。 */
const NEAR_BOTTOM_THRESHOLD = 48;
/** 「滚动到底部」按钮平滑回底的时长（与桌面端 ChatContent 的观感一致）。 */
const SCROLL_TO_BOTTOM_DURATION_MS = 350;

const TOOL_STATUS_LABEL_KEYS: Record<string, string> = {
  pending: "remote.message.toolPending",
  running: "remote.message.toolRunning",
  completed: "remote.message.toolCompleted",
  error: "remote.message.toolError",
};

// ── 模块状态 ──────────────────────────────────────────────────────────────

/** 最近一轮 /api/state 快照（本地加载历史后按它重绘）。 */
let currentState: SnowRemoteState | null = null;
/** 当前渲染的会话 id；变化即整表重建。 */
let renderedConversationId: string | null = null;
/** 当前会话累计的已知消息（时间正序，state 窗口 + 分页历史）。 */
let knownList: SnowRemoteMessage[] = [];
const knownIds = new Set<string>();
/** 是否可能还有更早的记录（初始由 state.hasOlderMessages 给出）。 */
let hasOlder = false;
/** 移动端自己是否完成过一次历史分页加载（完成后 hasOlder 以响应为准）。 */
let hasLoadedHistory = false;
let loadingOlder = false;
/** 用户是否停留在底部（决定新消息是否自动跟随）。 */
let userNearBottom = true;
/** 最近一次快照是否处于流式生成：按钮显示运行光环。 */
let streaming = false;
/** 平滑回底动画的帧句柄（0 = 空闲；非 0 期间滚动事件属于程序化滚动）。 */
let scrollToBottomAnim = 0;

// ── DOM 节点缓存 ──────────────────────────────────────────────────────────

type BlockNode = { key: string; sig: string; el: HTMLElement };
type MessageNode = {
  el: HTMLElement;
  blockHost: HTMLElement;
  blocks: BlockNode[];
  sig: string;
};

const renderedNodes = new Map<string, MessageNode>();

// ── 消息过滤 ──────────────────────────────────────────────────────────────

/**
 * 工具结果不作为独立消息渲染：assistant 消息的活动块已经包含工具的状态、
 * 参数与输出，独立的 role=tool 消息只在流式生成期间短暂出现（历史回放也
 * 不包含它），因此统一不进入消息列表。
 */
const isRenderableMessage = (message: SnowRemoteMessage): boolean =>
  (message.role || "assistant") !== "tool";

// ── 通用工具 ──────────────────────────────────────────────────────────────

/** 按位置对齐子元素：复用元素只移动不重建，多余节点会被清理。 */
const alignChildren = (parent: HTMLElement, els: HTMLElement[]): void => {
  for (let i = 0; i < els.length; i += 1) {
    const current = parent.children[i];
    if (current !== els[i]) {
      parent.insertBefore(els[i], current ?? null);
    }
  }
  while (parent.children.length > els.length) {
    parent.lastElementChild?.remove();
  }
};

const htmlToElement = (html: string): HTMLElement => {
  const template = document.createElement("template");
  template.innerHTML = html;
  return (
    (template.content.firstElementChild as HTMLElement | null) ??
    document.createElement("div")
  );
};

/** 低成本内容签名：长度 + 头尾采样，避免每轮比较超长全文。 */
const contentDigest = (value: string): string =>
  value.length <= 64
    ? value
    : `${value.length}\u0003${value.slice(0, 32)}\u0003${value.slice(-32)}`;

/** 折叠头部单行思考预览的字符上限（与桌面端 ThinkingBlock 一致）。 */
const THINKING_PREVIEW_MAX_CHARS = 150;
const THINKING_PREVIEW_SCAN_CHARS = THINKING_PREVIEW_MAX_CHARS * 4;

/** 折叠头部的思考单行预览：去换行后取尾部，过长时加前导省略号。 */
const thinkingPreviewText = (content: string): string => {
  if (!content) return "";
  const hasMore = content.length > THINKING_PREVIEW_SCAN_CHARS;
  const tail = (
    hasMore ? content.slice(-THINKING_PREVIEW_SCAN_CHARS) : content
  ).replace(/[\n\r\t]+/g, " ");
  if (tail.length <= THINKING_PREVIEW_MAX_CHARS) {
    return hasMore ? "…" + tail : tail;
  }
  return "…" + tail.slice(-THINKING_PREVIEW_MAX_CHARS);
};

/**
 * 「思考中」显示判定，与桌面端 ChatMessageList 的门控一致：运行时标记
 * isThinkingActive 只在首个正文增量 / 重试时复位，消息落定（sent / error /
 * incomplete）后不会清零。因此必须叠加「消息仍在流式生成」（status=sending），
 * 否则思考已结束的消息会一直显示「Snow 正在思考」。
 */
const isThinkingDisplayActive = (message: SnowRemoteMessage): boolean =>
  Boolean(message.isThinkingActive) && message.status === "sending";

/**
 * 把旧元素的展开状态带给重建后的新元素。程序从不自动展开 details
 * （工具执行中 / 思考进行中也都保持折叠），因此 `open === true` 只可能
 * 来自用户点击；重建时保留它，避免流式更新打断用户阅读。
 */
const inheritUserOpen = (
  oldEl: HTMLElement | null | undefined,
  newEl: HTMLElement,
): void => {
  if (
    oldEl instanceof HTMLDetailsElement &&
    newEl instanceof HTMLDetailsElement &&
    oldEl.open
  ) {
    newEl.open = true;
  }
};

const toolText = (tool: SnowRemoteToolCall): string => {
  const chunks: string[] = [];
  if (tool.arguments)
    chunks.push(t("remote.tool.arguments") + "\n" + tool.arguments);
  if (tool.streamingStdout)
    chunks.push(t("remote.tool.stdout") + "\n" + tool.streamingStdout);
  if (tool.streamingStderr)
    chunks.push(t("remote.tool.stderr") + "\n" + tool.streamingStderr);
  if (tool.result) chunks.push(t("remote.tool.result") + "\n" + tool.result);
  return chunks.join("\n\n");
};

const toolSignature = (tool: SnowRemoteToolCall): string =>
  [
    tool.interactionId,
    tool.name,
    tool.status,
    (tool.arguments || "").length,
    (tool.result || "").length,
    (tool.streamingStdout || "").length,
    (tool.streamingStderr || "").length,
  ].join("\u0001");

const toolSummary = (tools: SnowRemoteToolCall[] | undefined): string =>
  (tools ?? []).map(toolSignature).join("\u0002");

/** user 消息的附件/引用块（与旧版整段渲染保持相同结构）。 */
const userContentBlocksHtml = (message: SnowRemoteMessage): string => {
  if (!Array.isArray(message.contentBlocks)) {
    return `<div class="markdown">${renderMarkdown(message.content || "")}</div>`;
  }
  return (
    '<div class="message-content-blocks">' +
    message.contentBlocks
      .map((block) => {
        if (block.type === "text") {
          return `<div class="markdown">${renderMarkdown(block.text || "")}</div>`;
        }
        if (
          block.type === "image" &&
          /^\/api\/message-images\/[A-Za-z0-9_%.-]+\/\d+$/.test(
            block.source || "",
          )
        ) {
          return `<img class="remote-image" src="${escapeHtml(block.source)}" alt="${escapeHtml(block.name || t("remote.message.imageAlt"))}" loading="lazy">`;
        }
        const name =
          (block.type === "reference" ? block.label : block.name) ||
          t("remote.message.attachment");
        const detail =
          block.type === "file"
            ? block.isDirectory
              ? t("remote.message.folder")
              : t("remote.message.file")
            : block.type === "reference"
              ? block.detail || block.kind || t("remote.message.reference")
              : t("remote.message.reference");
        const icon =
          block.type === "file"
            ? block.isDirectory
              ? iconMarkup("folder")
              : iconMarkup("file")
            : iconMarkup("arrow-up-right");
        return `<div class="remote-attachment"><span class="remote-attachment-icon">${icon}</span><span class="remote-attachment-copy"><div class="remote-attachment-name">${escapeHtml(name)}</div><div class="remote-attachment-detail">${escapeHtml(detail)}</div></span></div>`;
      })
      .join("") +
    "</div>"
  );
};

// ── 工具（详情）元素 ──────────────────────────────────────────────────────

const createToolEl = (tool: SnowRemoteToolCall): HTMLDetailsElement => {
  const label = t(TOOL_STATUS_LABEL_KEYS[tool.status] ?? tool.status);
  const detail = toolText(tool);
  const details = document.createElement("details");
  const statusClass = TOOL_STATUS_LABEL_KEYS[tool.status]
    ? tool.status
    : "error";
  details.className = `tool ${statusClass}`;
  details.dataset.toolId = tool.interactionId;
  details.dataset.sig = toolSignature(tool);
  // 默认折叠（含执行中）：展开只看用户点击。

  const summary = document.createElement("summary");
  const dot = document.createElement("span");
  dot.className = "tool-dot";
  const name = document.createElement("span");
  name.className = "tool-name";
  name.textContent = tool.name;
  const state = document.createElement("span");
  state.className = "tool-state";
  state.textContent = label;
  summary.append(dot, name, state);
  details.append(summary);

  if (detail) {
    const body = document.createElement("div");
    body.className = "tool-body";
    body.textContent = detail;
    details.append(body);
  }
  return details;
};

/** 工具级 keyed diff：只重建签名变化的工具条目；用户展开状态跨重建保留。 */
const syncToolList = (host: HTMLElement, tools: SnowRemoteToolCall[]): void => {
  const existing = new Map<string, HTMLDetailsElement>();
  for (const child of Array.from(host.children)) {
    const el = child as HTMLDetailsElement;
    const id = el.dataset.toolId ?? "";
    if (id) existing.set(id, el);
  }

  const nextEls: HTMLElement[] = [];
  for (const tool of tools) {
    const sig = toolSignature(tool);
    const old = existing.get(tool.interactionId);
    existing.delete(tool.interactionId);
    if (old && old.dataset.sig === sig) {
      nextEls.push(old);
      continue;
    }
    const el = createToolEl(tool);
    inheritUserOpen(old, el);
    old?.remove();
    nextEls.push(el);
  }

  for (const old of existing.values()) old.remove();
  alignChildren(host, nextEls);
};

// ── 块定义 ────────────────────────────────────────────────────────────────

type BlockSpec = {
  key: string;
  sig: string;
  create: () => HTMLElement;
  /** 可选原地更新（工具活动块用它做工具级 diff，避免重建整个块）。 */
  patch?: (el: HTMLElement) => void;
};

const contentBlockSig = (message: SnowRemoteMessage): string => {
  const blocks = message.contentBlocks;
  if (!Array.isArray(blocks)) return contentDigest(message.content || "");
  return (
    contentDigest(message.content || "") +
    "\u0001" +
    blocks
      .map((block) =>
        block.type === "text"
          ? `t${block.text.length}`
          : block.type === "image"
            ? `i${block.source}`
            : block.type === "file"
              ? `f${block.name}${block.isDirectory ? "d" : "f"}`
              : `r${block.kind}${block.label}${block.detail ?? ""}`,
      )
      .join("\u0002")
  );
};

const buildMessageBlocks = (
  message: SnowRemoteMessage,
  index: number,
  total: number,
  isStreaming: boolean,
): BlockSpec[] => {
  const role = message.role || "assistant";
  const body = message.content || "";
  const blocks: BlockSpec[] = [];

  const thinking = message.thinking || "";
  if (thinking) {
    const thinkingActive = isThinkingDisplayActive(message);
    const summaryText = thinkingActive
      ? t("remote.message.thinkingActive")
      : message.thinkingDurationMs
        ? t("remote.message.thinkingDone", {
            seconds: Math.max(1, Math.round(message.thinkingDurationMs / 1000)),
          })
        : t("remote.message.thinkingView");
    // 折叠头部的单行预览：仅思考进行中展示（参考桌面端 ThinkingBlock）。
    const preview = thinkingActive ? thinkingPreviewText(thinking) : "";
    blocks.push({
      key: "thinking",
      sig: `${contentDigest(thinking)}|${thinkingActive ? 1 : 0}|${message.thinkingDurationMs ?? 0}`,
      create: () => {
        const details = document.createElement("details");
        details.className = "thinking";
        const summary = document.createElement("summary");
        const title = document.createElement("span");
        title.className = "thinking-title";
        title.textContent = summaryText;
        summary.append(title);
        if (preview) {
          const previewEl = document.createElement("span");
          previewEl.className = "thinking-preview";
          previewEl.textContent = preview;
          summary.append(previewEl);
        }
        const content = document.createElement("div");
        content.className = "thinking-body";
        content.textContent = thinking;
        details.append(summary, content);
        return details;
      },
    });
  }

  // 块顺序与桌面端 AiResponse 一致：思考 → 正文 → 工具活动。
  blocks.push({
    key: "content",
    sig: contentBlockSig(message),
    create: () =>
      htmlToElement(
        role === "user"
          ? userContentBlocksHtml(message)
          : `<div class="markdown">${renderMarkdown(body)}</div>`,
      ),
  });

  const tools = message.toolCalls ?? [];
  if (tools.length) {
    blocks.push({
      key: "activity",
      sig: toolSummary(tools),
      create: () => {
        const el = document.createElement("div");
        el.className = "activity";
        syncToolList(el, tools);
        return el;
      },
      patch: (el) => syncToolList(el, tools),
    });
  }

  if (isStreaming && index === total - 1 && role === "assistant") {
    blocks.push({
      key: "caret",
      sig: "caret",
      create: () => {
        const el = document.createElement("span");
        el.className = "streaming-caret";
        return el;
      },
    });
  }

  const time = messageTime(message.timestamp);
  if (time) {
    blocks.push({
      key: "time",
      sig: time,
      create: () => {
        const el = document.createElement("div");
        el.className = "message-time";
        el.textContent = time;
        return el;
      },
    });
  }

  return blocks;
};

/** 块级 diff：签名未变的块保持原 DOM（含 details 展开状态）。 */
const syncBlocks = (
  host: HTMLElement,
  blocks: BlockNode[],
  specs: BlockSpec[],
): BlockNode[] => {
  const byKey = new Map(blocks.map((block) => [block.key, block]));
  const nextBlocks: BlockNode[] = [];
  const nextEls: HTMLElement[] = [];

  for (const spec of specs) {
    const existing = byKey.get(spec.key);
    if (existing && existing.sig === spec.sig) {
      nextBlocks.push(existing);
      nextEls.push(existing.el);
      continue;
    }
    if (existing && spec.patch) {
      spec.patch(existing.el);
      nextBlocks.push({ key: spec.key, sig: spec.sig, el: existing.el });
      nextEls.push(existing.el);
      continue;
    }
    const el = spec.create();
    // 程序从不自动展开 details；旧元素处于展开只可能来自用户操作，
    // 重建时保留（未变化的块整体保留，同样不受刷新影响）。
    inheritUserOpen(existing?.el, el);
    existing?.el.remove();
    nextBlocks.push({ key: spec.key, sig: spec.sig, el });
    nextEls.push(el);
  }

  for (const block of blocks) {
    if (!nextBlocks.some((next) => next.el === block.el)) block.el.remove();
  }
  alignChildren(host, nextEls);
  return nextBlocks;
};

// ── 消息节点 ──────────────────────────────────────────────────────────────

const messageSignature = (
  message: SnowRemoteMessage,
  index: number,
  total: number,
  isStreaming: boolean,
): string => {
  const role = message.role || "assistant";
  const caret = isStreaming && index === total - 1 && role === "assistant";
  return [
    message.id,
    role,
    message.status || "",
    contentBlockSig(message),
    contentDigest(message.thinking || ""),
    isThinkingDisplayActive(message) ? "t1" : "t0",
    String(message.thinkingDurationMs ?? 0),
    caret ? "c1" : "c0",
    toolSummary(message.toolCalls),
    contentDigest(message.content || ""),
  ].join("\u0001");
};

const createMessageNode = (
  message: SnowRemoteMessage,
  index: number,
  total: number,
  isStreaming: boolean,
): MessageNode => {
  const role = message.role || "assistant";
  const el = document.createElement("article");
  el.className =
    role === "user" || role === "assistant" ? `message ${role}` : "message";
  const shell = document.createElement("div");
  shell.className = "message-shell";
  el.append(shell);
  const blocks = syncBlocks(
    shell,
    [],
    buildMessageBlocks(message, index, total, isStreaming),
  );
  return {
    el,
    blockHost: shell,
    blocks,
    sig: messageSignature(message, index, total, isStreaming),
  };
};

const updateMessageNode = (
  node: MessageNode,
  message: SnowRemoteMessage,
  index: number,
  total: number,
  isStreaming: boolean,
): void => {
  const signature = messageSignature(message, index, total, isStreaming);
  if (signature === node.sig) return;
  node.sig = signature;
  node.blocks = syncBlocks(
    node.blockHost,
    node.blocks,
    buildMessageBlocks(message, index, total, isStreaming),
  );
};

// ── 消息区装配 ────────────────────────────────────────────────────────────

const emptyHtml = (): string =>
  `<div class="empty"><div><img class="snow-logo" src="/icon.png" alt=""><strong>${t("remote.empty.start.title")}</strong><span>${t("remote.empty.start.detail")}</span></div></div>`;

const paintEmpty = (): void => {
  const container = $("messages");
  const html = emptyHtml();
  if (container.dataset.emptyHtml === html) return;
  container.dataset.emptyHtml = html;
  container.innerHTML = html;
  renderedNodes.clear();
};

const reconcileMessages = (rebuild: boolean): void => {
  const container = $("messages");
  const state = currentState;
  if (!state) return;
  const isStreaming = state.isStreaming;

  if (rebuild) {
    renderedNodes.clear();
    container.textContent = "";
    delete container.dataset.emptyHtml;
  }

  if (!knownList.length) {
    for (const node of renderedNodes.values()) node.el.remove();
    renderedNodes.clear();
    paintEmpty();
    return;
  }

  if (container.dataset.emptyHtml || renderedNodes.size === 0) {
    // 从空态（或静态连接占位）进入消息态：清掉占位内容。
    container.textContent = "";
    delete container.dataset.emptyHtml;
  }

  const nextEls: HTMLElement[] = [];
  const nextIdSet = new Set<string>();
  for (let index = 0; index < knownList.length; index += 1) {
    const message = knownList[index];
    if (nextIdSet.has(message.id)) {
      // 异常数据（重复 id）：不复用缓存，构造独立节点保证列表结构正确。
      nextEls.push(
        createMessageNode(message, index, knownList.length, isStreaming).el,
      );
      continue;
    }
    nextIdSet.add(message.id);
    let node = renderedNodes.get(message.id);
    if (node) {
      updateMessageNode(node, message, index, knownList.length, isStreaming);
    } else {
      node = createMessageNode(message, index, knownList.length, isStreaming);
      renderedNodes.set(message.id, node);
    }
    nextEls.push(node.el);
  }

  for (const [id, node] of Array.from(renderedNodes.entries())) {
    if (!nextIdSet.has(id)) {
      node.el.remove();
      renderedNodes.delete(id);
    }
  }

  const expected = new Set<Element>(nextEls);
  for (const child of Array.from(container.children)) {
    if (!expected.has(child)) child.remove();
  }
  alignChildren(container, nextEls);
};

/** 取消进行中的平滑回底动画。 */
const cancelScrollToBottomAnim = (): void => {
  if (scrollToBottomAnim !== 0) {
    cancelAnimationFrame(scrollToBottomAnim);
    scrollToBottomAnim = 0;
  }
};

/**
 * 同步「滚动到底部」按钮：离开底部即显示（显隐阈值与自动跟随共用，和
 * 桌面端行为一致）；流式生成期间显示光环；平滑回底动画期间保持隐藏。
 */
const syncScrollToBottomButton = (): void => {
  const timeline = $("timeline");
  const button = $<HTMLButtonElement>("scrollToBottomButton");
  const distance =
    timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
  button.hidden = scrollToBottomAnim !== 0 || distance < NEAR_BOTTOM_THRESHOLD;
  button.classList.toggle("streaming", streaming);
};

/** 平滑滚动回底部：easeOutCubic 补间；流式期间内容增高时每帧重取目标追赶。 */
const scrollTimelineToBottom = (timeline: HTMLElement): void => {
  cancelScrollToBottomAnim();
  userNearBottom = true;
  const startTop = timeline.scrollTop;
  const startTime = performance.now();
  const tick = (now: number): void => {
    const maxTop = timeline.scrollHeight - timeline.clientHeight;
    const progress = Math.min(
      1,
      (now - startTime) / SCROLL_TO_BOTTOM_DURATION_MS,
    );
    const eased = 1 - Math.pow(1 - progress, 3);
    const nextTop = Math.min(startTop + (maxTop - startTop) * eased, maxTop);
    timeline.scrollTop = nextTop;
    if (progress >= 1 || nextTop >= maxTop - 1) {
      scrollToBottomAnim = 0;
      timeline.scrollTop = maxTop;
      syncScrollToBottomButton();
      return;
    }
    scrollToBottomAnim = requestAnimationFrame(tick);
  };
  scrollToBottomAnim = requestAnimationFrame(tick);
  syncScrollToBottomButton();
};

const paint = (options: {
  follow: boolean;
  anchorEl: HTMLElement | null;
  rebuild?: boolean;
}): void => {
  const timeline = $("timeline");
  const anchorEl = options.anchorEl;
  // 在更新前记录锚点位置；更新后回补滚动偏移，保证视口内容不跳动。
  const anchorTop = anchorEl ? anchorEl.getBoundingClientRect().top : null;

  reconcileMessages(Boolean(options.rebuild));

  if (anchorEl !== null && anchorTop !== null) {
    timeline.scrollTop += anchorEl.getBoundingClientRect().top - anchorTop;
    return;
  }

  requestAnimationFrame(() => {
    // 跟随底部：抢占进行中的平滑回底动画，直接钉底避免动画向旧目标回写。
    if (options.follow) {
      cancelScrollToBottomAnim();
      timeline.scrollTop = timeline.scrollHeight;
    }
    syncScrollToBottomButton();
  });
};

// ── 历史分页 ──────────────────────────────────────────────────────────────

let earlierButtonKey = "";
/** 分页请求代际：会话切换或并发保护时递增，使在途请求失效。 */
let loadGeneration = 0;

const updateLoadEarlierButton = (): void => {
  const hasMessages = knownList.length > 0;
  const key = `${loadingOlder ? 1 : 0}|${hasOlder ? 1 : 0}|${hasMessages ? 1 : 0}`;
  if (key === earlierButtonKey) return;
  earlierButtonKey = key;
  const button = $<HTMLButtonElement>("loadEarlier");
  button.classList.toggle("loading", loadingOlder);
  button.disabled = loadingOlder;
  $("loadEarlierLabel").textContent = loadingOlder
    ? t("remote.timeline.loadingEarlier")
    : t("remote.timeline.loadEarlier");
  // 没有已知消息（空会话 / 新建会话）时不存在「更早的记录」入口。
  button.hidden = !loadingOlder && (!hasOlder || !hasMessages);
};

const loadEarlier = async (): Promise<void> => {
  const conversationId = renderedConversationId;
  if (!conversationId || loadingOlder || !hasOlder || !knownList.length) {
    return;
  }
  loadingOlder = true;
  loadGeneration += 1;
  const generation = loadGeneration;
  updateLoadEarlierButton();
  try {
    const page = await fetchOlderMessages(
      conversationId,
      knownList[0].id,
      OLDER_PAGE_SIZE,
    );
    if (
      generation !== loadGeneration ||
      conversationId !== renderedConversationId
    ) {
      return;
    }
    const fresh = page.items.filter(
      (item) => !knownIds.has(item.id) && isRenderableMessage(item),
    );
    if (fresh.length) {
      const anchorEl =
        ($("messages").firstElementChild as HTMLElement | null) ?? null;
      knownList = [...fresh, ...knownList];
      for (const item of fresh) knownIds.add(item.id);
      paint({ follow: false, anchorEl });
    }
    hasOlder = page.hasMore;
    hasLoadedHistory = true;
  } catch (error) {
    if (generation === loadGeneration) {
      showNotice((error as Error).message, true);
    }
  } finally {
    if (generation === loadGeneration) {
      loadingOlder = false;
      updateLoadEarlierButton();
    }
  }
};

/**
 * 桌面端会在用户消息落库后把前端临时 id（`user-…`）原地替换为数据库
 * snowflake id（数字串，见 renderer 的 remapPersistedUserMessageIds）。
 * 移动端按 id 累积消息且从不移除旧条目，若不处理这层迁移，同一条消息会以
 * 「临时 id 副本 + 数字 id 副本」出现两次（刷新页面整表重建才恢复）。判定
 * 与桌面端一致：纯数字串为持久化 id，其余为前端临时 id。
 */
const isFrontendId = (id: string): boolean => Number.isNaN(Number(id));

/**
 * id 迁移的消息身份签名：角色 + 时间 + 正文/内容块摘要。图片块 source 中的
 * 消息 id（`/api/message-images/<messageId>/<n>`）会随迁移一起变化，比较前
 * 先归一化该段。
 */
const remapIdentity = (message: SnowRemoteMessage): string => {
  const blocks = message.contentBlocks;
  const blockSig = Array.isArray(blocks)
    ? blocks
        .map((block) => {
          if (block.type === "text")
            return `t${contentDigest(block.text || "")}`;
          if (block.type === "image")
            return `i${block.name}\u0003${block.source.replace(
              /^\/api\/message-images\/[^/]+\//,
              "/api/message-images/",
            )}`;
          if (block.type === "file")
            return `f${block.name}${block.isDirectory ? "d" : "f"}`;
          return `r${block.kind}${block.label}${block.detail ?? ""}`;
        })
        .join("\u0002")
    : contentDigest(message.content || "");
  return `${message.role || "assistant"}\u0001${message.timestamp}\u0001${blockSig}`;
};

/**
 * 合并快照前的 id 迁移对账：
 * 1. 快照中已消失的临时 id 用户消息与快照中新出现的数字 id 用户消息按序
 *    配对（身份签名一致才迁移），原地换 id，DOM 节点缓存跟随换 key；
 * 2. 数字副本已在本地、只剩临时 id 残留的旧副本：把数字副本移回临时副本
 *    的原位置并清理残留，恢复正确顺序（同时修复已产生的历史性重复）。
 */
const reconcileRemappedUserIds = (incoming: SnowRemoteMessage[]): void => {
  const incomingIds = new Set(incoming.map((message) => message.id));
  const staleIndexes: number[] = [];
  knownList.forEach((message, index) => {
    if ((message.role || "assistant") !== "user") return;
    if (!isFrontendId(message.id)) return;
    if (incomingIds.has(message.id)) return;
    staleIndexes.push(index);
  });
  if (!staleIndexes.length) return;

  const freshPersisted = incoming.filter(
    (message) =>
      (message.role || "assistant") === "user" &&
      !isFrontendId(message.id) &&
      !knownIds.has(message.id),
  );

  // 1. 按序配对迁移。
  const pairs = Math.min(staleIndexes.length, freshPersisted.length);
  for (let i = 0; i < pairs; i += 1) {
    const index = staleIndexes[i];
    const previous = knownList[index];
    const next = freshPersisted[i];
    if (remapIdentity(previous) !== remapIdentity(next)) continue;
    knownIds.delete(previous.id);
    knownIds.add(next.id);
    knownList[index] = next;
    const node = renderedNodes.get(previous.id);
    if (node) {
      renderedNodes.delete(previous.id);
      renderedNodes.set(next.id, node);
    }
  }

  // 2. 修复残留：数字副本已在本地时，把它移回临时副本的原位置。
  const placed = new Set<number>();
  const removals = new Set<number>();
  for (const index of staleIndexes) {
    const stale = knownList[index];
    if (!stale || !isFrontendId(stale.id)) continue;
    let twinIndex = -1;
    for (let i = 0; i < knownList.length; i += 1) {
      if (i === index || placed.has(i) || removals.has(i)) continue;
      const candidate = knownList[i];
      if ((candidate.role || "assistant") !== "user") continue;
      if (isFrontendId(candidate.id)) continue;
      if (remapIdentity(candidate) !== remapIdentity(stale)) continue;
      twinIndex = i;
      break;
    }
    if (twinIndex === -1) continue;
    knownIds.delete(stale.id);
    knownList[index] = knownList[twinIndex];
    placed.add(index);
    removals.add(twinIndex);
  }
  if (removals.size) {
    knownList = knownList.filter((_, index) => !removals.has(index));
  }
};

/** state 窗口与本地已知消息合并：同 id 原地更新，新 id 追加到末尾。 */
const mergeKnown = (incoming: SnowRemoteMessage[]): void => {
  if (!incoming.length) return;
  reconcileRemappedUserIds(incoming);
  const indexById = new Map<string, number>();
  knownList.forEach((item, index) => indexById.set(item.id, index));
  for (const message of incoming) {
    if (!isRenderableMessage(message)) continue;
    const index = indexById.get(message.id);
    if (index === undefined) {
      knownList.push(message);
      knownIds.add(message.id);
      indexById.set(message.id, knownList.length - 1);
    } else {
      knownList[index] = message;
    }
  }
};

// ── 公共入口 ──────────────────────────────────────────────────────────────

/**
 * 渲染消息区。仅在 main.ts 检测到快照签名变化时调用；
 * isFirstRender 表示本次是首次渲染（必然滚到底部）。
 */
export const renderTimeline = (
  next: SnowRemoteState,
  isFirstRender: boolean,
): void => {
  currentState = next;
  streaming = next.isStreaming;
  const conversationChanged =
    (next.activeConversationId ?? null) !== renderedConversationId;
  if (conversationChanged) {
    renderedConversationId = next.activeConversationId ?? null;
    knownList = [];
    knownIds.clear();
    // 状态未知（undefined）时默认不显示「加载更早」入口，待桌面会话状态
    // 就绪后的下一轮快照跟随更新；新建会话（无活动会话）固定为 false。
    hasOlder = next.hasOlderMessages ?? false;
    hasLoadedHistory = false;
    loadingOlder = false;
    loadGeneration += 1;
    userNearBottom = true;
    cancelScrollToBottomAnim();
  } else if (!hasLoadedHistory) {
    // 移动端尚未自己翻页：跟随桌面会话的 DB 分页状态（状态未知时保留现值）。
    hasOlder = next.hasOlderMessages ?? hasOlder;
  }
  mergeKnown(next.messages);
  paint({
    follow: isFirstRender || userNearBottom,
    anchorEl: null,
    rebuild: conversationChanged,
  });
  updateLoadEarlierButton();
};

export const initTimeline = (): void => {
  const timeline = $("timeline");
  timeline.addEventListener("scroll", () => {
    // 平滑回底动画期间：滚动本身是程序化行为，不重推导跟随状态。
    if (scrollToBottomAnim !== 0) return;
    const distance =
      timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
    userNearBottom = distance < NEAR_BOTTOM_THRESHOLD;
    syncScrollToBottomButton();
    if (timeline.scrollTop <= LOAD_EARLIER_THRESHOLD) {
      void loadEarlier();
    }
  });
  // 手指按下即视为用户接管滚动：打断按钮触发的平滑回底并恢复按钮显隐。
  timeline.addEventListener(
    "pointerdown",
    () => {
      if (scrollToBottomAnim !== 0) {
        cancelScrollToBottomAnim();
        syncScrollToBottomButton();
      }
    },
    { passive: true },
  );
  $("loadEarlier").onclick = () => {
    void loadEarlier();
  };
  $("scrollToBottomButton").onclick = () => {
    scrollTimelineToBottom(timeline);
  };
  $("messages").onclick = (event) => {
    const image = (event.target as HTMLElement).closest<HTMLImageElement>(
      ".remote-image",
    );
    if (!image) return;
    openImageLightbox(image.src);
  };
};
