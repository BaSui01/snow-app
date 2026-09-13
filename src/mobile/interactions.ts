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
 * 授权 / 提问卡片。重渲染时保留用户未提交的草稿：
 * 勾选项与自定义回答分别记录在两张表里。
 */
const questionDrafts = new Map<string, string>();
const questionSelections = new Map<string, string[]>();

const captureQuestionDrafts = (): void => {
  document.querySelectorAll<HTMLElement>(".question-card").forEach((card) => {
    const id = card.dataset.question;
    if (!id) return;
    const input = card.querySelector<HTMLInputElement>(".answer-input");
    questionDrafts.set(id, input ? input.value : "");
    questionSelections.set(
      id,
      Array.from(
        card.querySelectorAll<HTMLElement>(".question-option.selected"),
      ).map((node) => node.dataset.option ?? ""),
    );
  });
};

export const renderInteractions = (next: SnowRemoteState): void => {
  captureQuestionDrafts();
  const cards: string[] = [];

  (next.pendingAuthorizations || []).forEach((tool) => {
    cards.push(
      `<section class="interaction"><div class="interaction-title">${escapeHtml(t("remote.interaction.authRequired", { name: tool.name }))}</div><div class="interaction-copy">${escapeHtml(tool.arguments || t("remote.interaction.authFallback"))}</div><input class="reject-reason" maxlength="300" placeholder="${escapeHtml(t("remote.interaction.rejectPlaceholder"))}"><div class="interaction-actions"><button data-reject="${escapeHtml(tool.authorizationId)}">${t("remote.interaction.reject")}</button><button class="primary" data-approve="${escapeHtml(tool.authorizationId)}">${t("remote.interaction.approve")}</button></div></section>`,
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
        .join("")}</div><input class="answer-input" maxlength="500" value="${escapeHtml(draft)}" placeholder="${escapeHtml(t("remote.interaction.answerPlaceholder"))}"><div class="interaction-actions"><button data-cancel-question="${escapeHtml(question.questionId)}">${t("remote.interaction.cancel")}</button><button class="primary" data-answer="${escapeHtml(question.questionId)}">${t("remote.interaction.submitAnswer")}</button></div></section>`,
    );
  });

  $("interactions").innerHTML = cards.join("");
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
        await approveAuthorization(approve.dataset.approve ?? "");
        showNotice(t("remote.notice.approved"));
      } else if (reject) {
        const card = reject.closest<HTMLElement>(".interaction");
        const reason =
          card
            ?.querySelector<HTMLInputElement>(".reject-reason")
            ?.value.trim() ?? "";
        await rejectAuthorization(
          reject.dataset.reject ?? "",
          reason || undefined,
        );
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
