import type { SnowRemoteState } from "../renderer/types/remoteControl";
import {
  answerQuestion,
  approveAuthorization,
  cancelQuestion,
  rejectAuthorization,
} from "./api";
import { $, escapeHtml } from "./dom";
import { t } from "./i18n";
import { showNotice } from "./notice";
import type { AppContext } from "./types";

/**
 * 授权 / 提问卡片。重渲染保留用户未提交的草稿（勾选项、自定义回答、拒绝理由），
 * 且只在内容签名变化时重建 DOM——轮询帧不销毁输入框，移动端键盘不被打断。
 */
const questionDrafts = new Map<string, string>();
const questionSelections = new Map<string, string[]>();
const rejectDrafts = new Map<string, string>();

let renderedSignature = "";

/** 输入焦点快照：重建前记录卡片标识与光标，重建后恢复到同一输入框。 */
let focusSnapshot: {
  cardKey: string;
  field: "answer" | "reject";
  start: number;
  end: number;
} | null = null;

/** 卡片标识：提问卡取 questionId，授权卡取 authorizationId，两者互不混用。 */
const cardKeyOf = (card: Element | null): string => {
  const element = card as HTMLElement | null;
  if (element?.dataset.question) return "q:" + element.dataset.question;
  if (element?.dataset.auth) return "a:" + element.dataset.auth;
  return "";
};

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
  const input = card?.querySelector<HTMLInputElement>(
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

export const renderInteractions = (next: SnowRemoteState): void => {
  const signature = buildSignature(next);
  if (signature === renderedSignature) return;
  renderedSignature = signature;
  captureDrafts();
  const cards: string[] = [];

  (next.pendingAuthorizations || []).forEach((tool) => {
    const authorizationId = tool.authorizationId ?? "";
    const reason = rejectDrafts.get(authorizationId) || "";
    cards.push(
      `<section class="interaction" data-auth="${escapeHtml(authorizationId)}"><div class="interaction-title">${escapeHtml(t("remote.interaction.authRequired", { name: tool.name }))}</div><div class="interaction-copy">${escapeHtml(tool.arguments || t("remote.interaction.authFallback"))}</div><input class="reject-reason" maxlength="300" value="${escapeHtml(reason)}" placeholder="${escapeHtml(t("remote.interaction.rejectPlaceholder"))}"><div class="interaction-actions"><button data-reject="${escapeHtml(authorizationId)}">${t("remote.interaction.reject")}</button><button class="primary" data-approve="${escapeHtml(authorizationId)}">${t("remote.interaction.approve")}</button></div></section>`,
    );
  });

  (next.pendingQuestions || []).forEach((question) => {
    const selected = questionSelections.get(question.questionId) || [];
    const draft = questionDrafts.get(question.questionId) || "";
    cards.push(
      `<section class="interaction question-card" data-question="${escapeHtml(question.questionId)}"><div class="interaction-title">${t("remote.interaction.questionTitle")}</div><div class="interaction-copy">${escapeHtml(question.question)}</div><div class="interaction-options">${question.options
        .map(
          (option) =>
            `<button class="question-option${selected.indexOf(option) !== -1 ? " selected" : ""}" data-option="${escapeHtml(option)}">${escapeHtml(option)}</button>`,
        )
        .join(
          "",
        )}</div><input class="answer-input" maxlength="500" value="${escapeHtml(draft)}" placeholder="${escapeHtml(t("remote.interaction.answerPlaceholder"))}"><div class="interaction-actions"><button data-cancel-question="${escapeHtml(question.questionId)}">${t("remote.interaction.cancel")}</button><button class="primary" data-answer="${escapeHtml(question.questionId)}">${t("remote.interaction.submitAnswer")}</button></div></section>`,
    );
  });

  $("interactions").innerHTML = cards.join("");
  restoreFocus();
};

export const initInteractions = (ctx: AppContext): void => {
  $("interactions").onclick = async (event) => {
    const target = event.target as HTMLElement;
    const approve = target.closest<HTMLElement>("[data-approve]");
    const reject = target.closest<HTMLElement>("[data-reject]");
    const option = target.closest<HTMLElement>("[data-option]");
    const answer = target.closest<HTMLElement>("[data-answer]");
    const cancel = target.closest<HTMLElement>("[data-cancel-question]");

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
