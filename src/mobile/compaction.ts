import type { SnowRemoteState } from "../renderer/types/remoteControl";
import { escapeHtml } from "./dom";
import { t } from "./i18n";
import { iconMarkup } from "./icons";
import { renderMarkdown } from "./markdown";

let node: HTMLElement | null = null;
let lastSig = "";

const previewDigest = (value: string): string =>
  value.length <= 64 ? value : `${value.length}\u0003${value.slice(-32)}`;

const streamMarkup = (preview: string): string =>
  `<section class="compaction-stream" aria-live="polite"><div class="compaction-stream-title"><span class="compaction-stream-icon">${iconMarkup("minimize-2")}</span><span class="compaction-stream-heading">${t("remote.compaction.generating")}</span><span class="compaction-spinner">${iconMarkup("loader-circle")}</span></div><div class="compaction-stream-body">${
    preview
      ? `<div class="markdown">${renderMarkdown(preview)}</div>`
      : '<div class="compaction-placeholder"><span></span><span></span><span></span></div>'
  }</div></section>`;

const errorMarkup = (error: string): string =>
  `<div class="compaction-error" role="alert">${iconMarkup("circle-alert")}<span>${t("remote.compaction.failed")}: ${escapeHtml(error)}</span></div>`;

export const compactionCardHtml = (content: string): string =>
  `<details class="compaction-card"><summary class="compaction-card-header"><span class="compaction-card-icon">${iconMarkup("minimize-2")}</span><span class="compaction-card-copy"><strong>${t("remote.compaction.summary")}</strong><span class="compaction-card-desc">${t("remote.compaction.compacted")}</span></span><span class="compaction-card-action">${iconMarkup("chevron-down")}</span></summary><div class="compaction-card-body"><div class="markdown">${renderMarkdown(content)}</div></div></details>`;

export const syncCompactionNode = (
  state: SnowRemoteState,
): HTMLElement | null => {
  const isCompacting = Boolean(state.isCompacting);
  const error = state.compactionError ?? "";
  if (!isCompacting && !error) {
    if (node) {
      node.remove();
      node = null;
      lastSig = "";
    }
    return null;
  }
  const sig = `${isCompacting ? 1 : 0}\u0001${error}\u0001${
    isCompacting ? previewDigest(state.compactionPreview ?? "") : ""
  }`;
  if (!node || sig !== lastSig) {
    const parts: string[] = [];
    if (isCompacting) parts.push(streamMarkup(state.compactionPreview ?? ""));
    if (error) parts.push(errorMarkup(error));
    const next = document.createElement("div");
    next.className = "compaction-block";
    next.innerHTML = parts.join("");
    node?.remove();
    node = next;
    lastSig = sig;
  }
  const body = node.querySelector<HTMLElement>(".compaction-stream-body");
  if (body) body.scrollTop = body.scrollHeight;
  return node;
};
