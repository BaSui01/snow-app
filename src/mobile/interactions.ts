import type { SnowRemoteState } from "../renderer/types/remoteControl";
import {
  answerQuestion,
  approveAuthorization,
  cancelQuestion,
  rejectAuthorization,
} from "./api";
import { $, escapeHtml } from "./dom";
import { t } from "./i18n";
import { iconMarkup } from "./icons";
import { showNotice } from "./notice";
import type { AppContext } from "./types";

/**
 * 授权 / 提问卡片（决策卡）。
 *
 * 手机屏幕放不下「正文 + 完整决策卡」，因此卡片做两级折叠：
 * - 外层：默认收成 44px 窄条（只显示标题与「查看」），点开才是完整卡片，
 *   同一时间只允许一张展开——这样待处理卡片不会盖住正在读的正文；
 * - 内层：参数 / 问题文本默认 3 行摘要，长内容提供「展开全文」，
 *   命令与参数在全文态用等宽字体显示，保证决策证据可核对。
 *
 * 折叠状态按卡片标识（a:授权 id / q:问题 id）记忆，轮询重建后不弹回；
 * 用户滑动正文时自动收起，但焦点仍在卡片内（正在输入）时绝不打断。
 *
 * 布局联动：卡片数量与堆叠高度写入 CSS 变量（--interaction-count /
 * --interaction-h），由样式层完成正文底部留白与悬浮按钮避让。
 */

/** 卡内输入草稿：重建 DOM 时保留用户未提交的内容。 */
const questionDrafts = new Map<string, string>();
const questionSelections = new Map<string, string[]>();
const rejectDrafts = new Map<string, string>();

/** 当前展开的卡片标识；同一时间只允许一张展开。 */
let expandedKey: string | null = null;
/** 已切到「全文」的卡片标识集合（收起卡片后再次展开仍保持全文态）。 */
const detailKeys = new Set<string>();

/** 最近一次渲染的内容签名；未变化时不重建 DOM（轮询帧不打断输入）。 */
let renderedSignature = "";

/** 程序化滚动保护窗口：贴底补偿不应被当成用户滑动而收起卡片。 */
let programmaticScrollUntil = 0;

/** 在卡片上开始的手势期间不自动收起（滑动可能穿透到正文滚动）。 */
let interactionGestureUntil = 0;

/** #interactions 尺寸观察器：把实际高度写给 CSS，供悬浮按钮 / 提示避让。 */
let heightObserver: ResizeObserver | null = null;

/** 用户滑动多少像素后自动收起展开的卡片（手指微动不触发）。 */
const COLLAPSE_SCROLL_PX = 16;
/** 内容超过该长度或行数时提供「展开全文」。 */
const DETAIL_LENGTH_THRESHOLD = 120;
const DETAIL_LINE_THRESHOLD = 3;
/** 距底部多少像素内视为「贴底」（与 timeline.ts 的跟随阈值一致）。 */
const STICK_THRESHOLD = 48;
/** 程序化滚动的保护时长。 */
const PROGRAMMATIC_SCROLL_MS = 240;

/** 输入焦点快照：重建前记录卡片标识与光标，重建后恢复到同一输入框。 */
let focusSnapshot: {
  cardKey: string;
  field: "answer" | "reject";
  start: number;
  end: number;
} | null = null;

/** 卡片标识：授权卡 a:authorizationId，提问卡 q:questionId。 */
const cardKeyOf = (card: Element | null): string =>
  (card as HTMLElement | null)?.dataset.key ?? "";

const needsDetail = (text: string): boolean =>
  text.length > DETAIL_LENGTH_THRESHOLD ||
  text.split("\n").length > DETAIL_LINE_THRESHOLD;

const captureDrafts = (): void => {
  const host = $("interactions");
  const active = document.activeElement as HTMLInputElement | null;
  const field = active?.classList.contains("answer-input")
    ? "answer"
    : active?.classList.contains("reject-reason")
      ? "reject"
      : null;
  const cardKey =
    active && field && host.contains(active)
      ? cardKeyOf(active.closest(".interaction"))
      : "";
  focusSnapshot =
    active && field && cardKey
      ? {
          cardKey,
          field,
          start: active.selectionStart ?? active.value.length,
          end: active.selectionEnd ?? active.value.length,
        }
      : null;

  host.querySelectorAll<HTMLElement>(".interaction").forEach((card) => {
    const questionId = card.dataset.question;
    if (questionId) {
      questionDrafts.set(
        questionId,
        card.querySelector<HTMLInputElement>(".answer-input")?.value ?? "",
      );
      questionSelections.set(
        questionId,
        Array.from(
          card.querySelectorAll<HTMLElement>(".question-option.selected"),
        ).map((node) => node.dataset.option ?? ""),
      );
    }
    const authorizationId = card.dataset.auth;
    if (authorizationId) {
      rejectDrafts.set(
        authorizationId,
        card.querySelector<HTMLInputElement>(".reject-reason")?.value ?? "",
      );
    }
  });
};

const restoreFocus = (): void => {
  const snapshot = focusSnapshot;
  if (!snapshot) return;
  const card = Array.from(
    $("interactions").querySelectorAll<HTMLElement>(".interaction"),
  ).find((item) => cardKeyOf(item) === snapshot.cardKey);
  // 折叠状态下的输入框不可见，不能抢焦点（等用户重新展开再恢复）。
  if (!card || !card.classList.contains("is-open")) return;
  const input = card.querySelector<HTMLInputElement>(
    snapshot.field === "answer" ? ".answer-input" : ".reject-reason",
  );
  if (!input) return;
  input.focus();
  input.setSelectionRange(snapshot.start, snapshot.end);
};

/** 渲染签名：待授权清单与待提问清单的展示内容，未变化时完全不触碰 DOM。 */
const buildSignature = (next: SnowRemoteState): string =>
  JSON.stringify([
    (next.pendingAuthorizations || []).map((tool) => [
      tool.authorizationId,
      tool.name,
      tool.arguments ?? "",
    ]),
    (next.pendingQuestions || []).map((question) => [
      question.questionId,
      question.question,
      question.options,
    ]),
  ]);

/**
 * 把折叠 / 全文状态写回 DOM。切换只改类与属性，不重建 DOM——
 * 因此输入草稿、光标、音频等状态天然保留。
 */
const applyCardStates = (): void => {
  const host = $("interactions");
  let anyOpen = false;
  host.querySelectorAll<HTMLElement>(".interaction").forEach((card) => {
    const key = cardKeyOf(card);
    const open = key !== "" && key === expandedKey;
    const full = open && detailKeys.has(key);
    if (open) anyOpen = true;

    card.classList.toggle("is-open", open);
    card.classList.toggle("is-collapsed", !open);

    const body = card.querySelector<HTMLElement>(".interaction-body");
    if (body) body.hidden = !open;

    const head = card.querySelector<HTMLButtonElement>(".interaction-head");
    head?.setAttribute("aria-expanded", String(open));

    const label = card.querySelector<HTMLElement>(".interaction-toggle-label");
    if (label) {
      label.textContent = t(
        open ? "remote.interaction.collapse" : "remote.interaction.view",
      );
    }

    const copy = card.querySelector<HTMLElement>(".interaction-copy");
    copy?.classList.toggle("is-full", full);

    const more = card.querySelector<HTMLButtonElement>(".interaction-more");
    if (more) {
      more.setAttribute("aria-expanded", String(full));
      more.textContent = t(
        full
          ? "remote.interaction.collapseDetail"
          : "remote.interaction.expandDetail",
      );
    }
  });
  // 有卡片展开时放宽堆叠限高（见 app.css），保证全文与按钮同时可见；
  // 没有展开时仍按窄条堆叠限高，避免遮挡正文。
  host.classList.toggle("is-expanded", anyOpen);
};

/** 卡片数量 → CSS：正文底部按窄条总高预留空间（见 app.css 的折叠层）。 */
const syncInteractionCount = (count: number): void => {
  document.documentElement.style.setProperty(
    "--interaction-count",
    String(count),
  );
};

/** 卡片堆叠实际高度 → CSS：让「回到底部」按钮与状态提示抬到卡片上方。 */
const syncInteractionHeight = (): void => {
  const stack = $("interactions");
  const height = stack.children.length > 0 ? stack.offsetHeight + 8 : 0;
  document.documentElement.style.setProperty("--interaction-h", `${height}px`);
};

const ensureHeightObserver = (): void => {
  if (heightObserver || typeof ResizeObserver === "undefined") return;
  heightObserver = new ResizeObserver(syncInteractionHeight);
  heightObserver.observe($("interactions"));
};

/**
 * 用户原本贴在底部时，卡片高度变化（展开 / 收起 / 数量变化）后继续保持贴底，
 * 避免「留白变大 → 距离底部超过阈值 → 自动跟随悄悄失效」。
 */
const keepBottomIfNear = (): void => {
  const timeline = $("timeline");
  const distance =
    timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
  if (distance >= STICK_THRESHOLD) return;
  programmaticScrollUntil = performance.now() + PROGRAMMATIC_SCROLL_MS;
  timeline.scrollTop = timeline.scrollHeight;
};

/**
 * 展开的卡片若超出堆叠可视区，滚动堆叠让它的标题行完整露出（不滚动正文）。
 * 卡片高度已受堆叠限高约束，优先显示顶部——用户先看标题与结论，再往下看参数。
 */
const revealCardInStack = (card: HTMLElement): void => {
  const stack = $("interactions");
  if (stack.scrollHeight <= stack.clientHeight) return;
  const top = card.offsetTop;
  const bottom = top + card.offsetHeight;
  if (top < stack.scrollTop || bottom > stack.scrollTop + stack.clientHeight) {
    stack.scrollTop = top;
  }
};

/**
 * 正文一滑动就把展开的卡片收成窄条（给正文让路）。
 * 卡片内部滚动、输入框聚焦、按钮点击都不会触发收起。
 */
const initAutoCollapse = (): void => {
  const timeline = $("timeline");
  let lastTop = timeline.scrollTop;
  let accumulated = 0;
  // 手势起点在卡片上时，滑动可能穿透到正文滚动：整段手势内不自动收起。
  $("interactions").addEventListener(
    "pointerdown",
    () => {
      interactionGestureUntil = performance.now() + 600;
    },
    { passive: true },
  );
  timeline.addEventListener(
    "scroll",
    () => {
      const top = timeline.scrollTop;
      const delta = Math.abs(top - lastTop);
      lastTop = top;
      // 没有展开的卡片时清空累计：否则收起后再次展开，第一次轻扫就会
      // 带着上一轮的累计值直接收起，用户会觉得「点开就自己关了」。
      if (expandedKey === null) {
        accumulated = 0;
        return;
      }
      if (delta === 0) return;
      if (performance.now() < programmaticScrollUntil) return;
      if (performance.now() < interactionGestureUntil) {
        accumulated = 0;
        return;
      }
      if ($("interactions").contains(document.activeElement)) return;
      accumulated += delta;
      if (accumulated < COLLAPSE_SCROLL_PX) return;
      accumulated = 0;
      expandedKey = null;
      applyCardStates();
      syncInteractionHeight();
    },
    { passive: true },
  );
};

/** 卡片标题行：整行是折叠 / 展开开关。 */
const headHtml = (key: string, title: string, bodyId: string): string =>
  `<button class="interaction-head" type="button" data-toggle="${escapeHtml(key)}" aria-expanded="false" aria-controls="${bodyId}">` +
  `<span class="interaction-title">${escapeHtml(title)}</span>` +
  `<span class="interaction-toggle-label">${escapeHtml(t("remote.interaction.view"))}</span>` +
  `<span class="interaction-chevron" aria-hidden="true">${iconMarkup("chevron-down")}</span>` +
  `</button>`;

/** 长内容才提供「展开全文」，短内容不额外增加按钮噪音。 */
const detailButtonHtml = (key: string, text: string): string =>
  needsDetail(text)
    ? `<button class="interaction-more" type="button" data-more="${escapeHtml(key)}" aria-expanded="false">${escapeHtml(t("remote.interaction.expandDetail"))}</button>`
    : "";

export const renderInteractions = (next: SnowRemoteState): void => {
  const signature = buildSignature(next);
  if (signature === renderedSignature) return;
  renderedSignature = signature;
  captureDrafts();

  const authorizations = next.pendingAuthorizations || [];
  const questions = next.pendingQuestions || [];

  // 卡片被处理掉后，对应折叠 / 全文状态一起失效，避免无主状态越积越多。
  const validKeys = new Set<string>();
  authorizations.forEach((tool) =>
    validKeys.add("a:" + (tool.authorizationId ?? "")),
  );
  questions.forEach((question) => validKeys.add("q:" + question.questionId));
  if (expandedKey !== null && !validKeys.has(expandedKey)) expandedKey = null;
  Array.from(detailKeys).forEach((key) => {
    if (!validKeys.has(key)) detailKeys.delete(key);
  });

  const cards: string[] = [];

  authorizations.forEach((tool, index) => {
    const authorizationId = tool.authorizationId ?? "";
    const key = "a:" + authorizationId;
    const reason = rejectDrafts.get(authorizationId) || "";
    const copy = tool.arguments || t("remote.interaction.authFallback");
    const bodyId = `interaction-body-a-${index}`;
    cards.push(
      `<section class="interaction is-collapsed" data-auth="${escapeHtml(authorizationId)}" data-key="${escapeHtml(key)}">` +
        headHtml(
          key,
          t("remote.interaction.authRequired", { name: tool.name }),
          bodyId,
        ) +
        `<div class="interaction-body" id="${bodyId}" hidden>` +
        `<div class="interaction-copy">${escapeHtml(copy)}</div>` +
        detailButtonHtml(key, copy) +
        `<input class="reject-reason" maxlength="300" value="${escapeHtml(reason)}" placeholder="${escapeHtml(t("remote.interaction.rejectPlaceholder"))}">` +
        `<div class="interaction-actions">` +
        `<button data-reject="${escapeHtml(authorizationId)}">${t("remote.interaction.reject")}</button>` +
        `<button class="primary" data-approve="${escapeHtml(authorizationId)}">${t("remote.interaction.approve")}</button>` +
        `</div></div></section>`,
    );
  });

  questions.forEach((question, index) => {
    const key = "q:" + question.questionId;
    const selected = questionSelections.get(question.questionId) || [];
    const draft = questionDrafts.get(question.questionId) || "";
    const bodyId = `interaction-body-q-${index}`;
    const title =
      t("remote.interaction.questionTitle") + " · " + question.question;
    const options = question.options
      .map(
        (option) =>
          `<button class="question-option${selected.indexOf(option) !== -1 ? " selected" : ""}" data-option="${escapeHtml(option)}">${escapeHtml(option)}</button>`,
      )
      .join("");
    cards.push(
      `<section class="interaction question-card is-collapsed" data-question="${escapeHtml(question.questionId)}" data-key="${escapeHtml(key)}">` +
        headHtml(key, title, bodyId) +
        `<div class="interaction-body" id="${bodyId}" hidden>` +
        `<div class="interaction-copy">${escapeHtml(question.question)}</div>` +
        detailButtonHtml(key, question.question) +
        `<div class="interaction-options">${options}</div>` +
        `<input class="answer-input" maxlength="500" value="${escapeHtml(draft)}" placeholder="${escapeHtml(t("remote.interaction.answerPlaceholder"))}">` +
        `<div class="interaction-actions">` +
        `<button data-cancel-question="${escapeHtml(question.questionId)}">${t("remote.interaction.cancel")}</button>` +
        `<button class="primary" data-answer="${escapeHtml(question.questionId)}">${t("remote.interaction.submitAnswer")}</button>` +
        `</div></div></section>`,
    );
  });

  $("interactions").innerHTML = cards.join("");
  applyCardStates();
  restoreFocus();
  syncInteractionCount(cards.length);
  syncInteractionHeight();
  requestAnimationFrame(() => {
    syncInteractionHeight();
    keepBottomIfNear();
  });
};

export const initInteractions = (ctx: AppContext): void => {
  ensureHeightObserver();
  initAutoCollapse();

  $("interactions").onclick = async (event) => {
    const target = event.target as HTMLElement;
    const toggle = target.closest<HTMLElement>("[data-toggle]");
    const more = target.closest<HTMLElement>("[data-more]");
    const approve = target.closest<HTMLElement>("[data-approve]");
    const reject = target.closest<HTMLElement>("[data-reject]");
    const option = target.closest<HTMLElement>("[data-option]");
    const answer = target.closest<HTMLElement>("[data-answer]");
    const cancel = target.closest<HTMLElement>("[data-cancel-question]");

    // 折叠 / 展开：只切状态与类，不重建 DOM（保住草稿与光标）。
    if (toggle) {
      const key = toggle.dataset.toggle ?? "";
      const card = toggle.closest<HTMLElement>(".interaction");
      const willOpen = expandedKey !== key;
      // 收起时焦点若在卡内，先移到标题按钮，避免随 body 隐藏而丢失。
      if (!willOpen && card?.contains(document.activeElement)) {
        (toggle as HTMLButtonElement).focus();
      }
      expandedKey = willOpen ? key : null;
      applyCardStates();
      syncInteractionHeight();
      if (willOpen && card) {
        requestAnimationFrame(() => revealCardInStack(card));
      }
      return;
    }

    // 内容「摘要 ↔ 全文」：同样只切类。
    if (more) {
      const key = more.dataset.more ?? "";
      if (detailKeys.has(key)) detailKeys.delete(key);
      else detailKeys.add(key);
      applyCardStates();
      syncInteractionHeight();
      return;
    }

    if (option) {
      const card = option.closest<HTMLElement>(".question-card");
      const questionId = card?.dataset.question;
      option.classList.toggle("selected");
      if (questionId && card) {
        questionSelections.set(
          questionId,
          Array.from(
            card.querySelectorAll<HTMLElement>(".question-option.selected"),
          ).map((node) => node.dataset.option ?? ""),
        );
      }
      return;
    }

    try {
      if (approve) {
        const authorizationId = approve.dataset.approve ?? "";
        await approveAuthorization(authorizationId);
        rejectDrafts.delete(authorizationId);
        showNotice(t("remote.notice.approved"));
      } else if (reject) {
        const authorizationId = reject.dataset.reject ?? "";
        const card = reject.closest<HTMLElement>(".interaction");
        const reason =
          card
            ?.querySelector<HTMLInputElement>(".reject-reason")
            ?.value.trim() ?? "";
        await rejectAuthorization(authorizationId, reason || undefined);
        rejectDrafts.delete(authorizationId);
        showNotice(t("remote.notice.rejected"));
      } else if (cancel) {
        await cancelQuestion(cancel.dataset.cancelQuestion ?? "");
        showNotice(t("remote.notice.cancelled"));
      } else if (answer) {
        const card = answer.closest<HTMLElement>(".question-card");
        const selected = card
          ? Array.from(
              card.querySelectorAll<HTMLElement>(".question-option.selected"),
            ).map((node) => node.dataset.option ?? "")
          : [];
        const custom =
          card
            ?.querySelector<HTMLInputElement>(".answer-input")
            ?.value.trim() ?? "";
        const questionId = answer.dataset.answer ?? "";
        questionDrafts.delete(questionId);
        questionSelections.delete(questionId);
        await answerQuestion(questionId, selected, custom ? [custom] : []);
        showNotice(t("remote.notice.answered"));
      } else {
        return;
      }
      await ctx.refresh(false);
    } catch (error) {
      showNotice((error as Error).message, true);
    }
  };
};
