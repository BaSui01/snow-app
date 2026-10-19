/**
 * 工具失败纠错 Agent 面板（移动端）。
 *
 * 数据来源：远控 DTO SnowRemoteToolCall.correction（桌面 ToolCorrectionTree
 * 的移动端等价物，见 renderer/components/mainContent/chatMessages/toolCalls/
 * ToolCorrectionTree.tsx）。
 *
 * DOM 契约（styles/tools/correction.css 与 tools/index.ts 依赖，勿单独改动）：
 *   details.tc-corr.tc-corr--<status>[open]
 *     summary.tc-corr-head
 *       span.tc-corr-icon / .tc-corr-title / .tc-corr-subtitle
 *       span.tc-corr-state / .tc-corr-count / .tc-corr-chevron
 *     div.tc-corr-body
 *       details.tc-corr-detail > summary + .tc-corr-block
 *       ol.tc-corr-tree > li.tc-corr-node
 *         .tc-corr-node-head / .tc-corr-reason / .tc-corr-pre / details
 *       .tc-corr-failure / .tc-corr-pre--muted / .tc-corr-replaced
 *
 * 所有文本一律 createElement + textContent，数据不拼进 innerHTML。
 */
import type {
  SnowRemoteToolCorrection,
  SnowRemoteToolCorrectionAttempt,
} from "../../renderer/types/remoteControl";
import { t } from "../i18n";
import { iconMarkup, type MobileIconName } from "../icons";

/** 与桌面端一致的展示上限（避免超长参数 / 结果撑爆手机端）。 */
const MAX_PREVIEW_CHARS = 4_000;

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const icon = (name: MobileIconName, className: string): HTMLSpanElement => {
  const span = el("span", className);
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = iconMarkup(name);
  return span;
};

const previewText = (value: string, max = MAX_PREVIEW_CHARS): string =>
  value.length > max ? `${value.slice(0, max)}\n...` : value;

/** 参数原文 → 展示文本：美化 JSON，无法解析时保留原文。 */
const prettyArguments = (raw: string): string => {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
};

/** 尝试状态图标（与桌面 attemptIcon 的 CircleDot / CheckCircle2 / CircleSlash2 / AlertCircle 对应）。 */
const attemptIcon = (
  status: SnowRemoteToolCorrectionAttempt["status"],
): HTMLSpanElement => {
  if (status === "running") return icon("circle-dot", "tc-corr-node-icon");
  if (status === "succeeded") return icon("circle-check", "tc-corr-node-icon");
  if (status === "rejected") return icon("circle-slash-2", "tc-corr-node-icon");
  return icon("circle-alert", "tc-corr-node-icon");
};

/** 带标题的等宽文本块（修正参数 / 执行结果）。 */
const labeledBlock = (label: string, text: string): HTMLElement => {
  const block = el("div", "tc-corr-block");
  block.append(el("span", "tc-corr-k", label), el("pre", "tc-corr-pre", text));
  return block;
};

/** 可折叠的详情行（原始参数 / 查看参数与结果）。 */
const detailSection = (
  label: string,
  ...content: HTMLElement[]
): HTMLDetailsElement => {
  const detail = el("details", "tc-corr-detail");
  const summary = el("summary", "tc-corr-detail-summary", label);
  detail.append(summary, ...content);
  return detail;
};

/** 单次纠错尝试节点。 */
const attemptNode = (attempt: SnowRemoteToolCorrectionAttempt): HTMLElement => {
  const node = el("li", `tc-corr-node tc-corr-node--${attempt.status}`);

  const head = el("div", "tc-corr-node-head");
  head.append(
    attemptIcon(attempt.status),
    el(
      "span",
      "tc-corr-node-title",
      t("remote.toolCall.correction.attempt", { index: attempt.index }),
    ),
    el(
      "span",
      `tc-corr-attempt-state tc-corr-attempt-state--${attempt.status}`,
      t(`remote.toolCall.correction.attemptStatus.${attempt.status}`),
    ),
  );
  if (attempt.finishedAt !== undefined) {
    head.append(
      el(
        "span",
        "tc-corr-time",
        `${Math.max(0, attempt.finishedAt - attempt.startedAt)} ms`,
      ),
    );
  }
  node.append(head);

  if (attempt.reasoning) {
    const reason = el("div", "tc-corr-reason");
    reason.append(
      icon("lightbulb", "tc-corr-reason-icon"),
      el("span", "tc-corr-reason-text", attempt.reasoning),
    );
    node.append(reason);
  }

  if (attempt.error) {
    node.append(
      el(
        "pre",
        "tc-corr-pre tc-corr-pre--error",
        previewText(attempt.error, 1_200),
      ),
    );
  }

  const details = el("details", "tc-corr-detail");
  details.append(
    el(
      "summary",
      "tc-corr-detail-summary",
      t("remote.toolCall.correction.details"),
    ),
    labeledBlock(
      t("remote.toolCall.correction.arguments"),
      prettyArguments(attempt.arguments),
    ),
  );
  if (attempt.result !== undefined) {
    details.append(
      labeledBlock(
        t("remote.toolCall.correction.result"),
        previewText(attempt.result),
      ),
    );
  }
  node.append(details);

  return node;
};

/**
 * 纠错状态 → 面板元素。running / failed 默认展开（与桌面初始展开规则一致），
 * 其余状态默认收起；历史重建时由 tools/index.ts 恢复用户之前的展开状态。
 */
export const createCorrectionPanel = (
  correction: SnowRemoteToolCorrection,
): HTMLDetailsElement => {
  const details = el("details", `tc-corr tc-corr--${correction.status}`);
  details.open =
    correction.status === "running" || correction.status === "failed";

  const head = el("summary", "tc-corr-head");
  head.append(
    icon("drill", "tc-corr-icon"),
    el("span", "tc-corr-title", t("remote.toolCall.correction.title")),
    el("span", "tc-corr-subtitle", t("remote.toolCall.correction.subtitle")),
    el(
      "span",
      `tc-corr-state tc-corr-state--${correction.status}`,
      t(`remote.toolCall.correction.status.${correction.status}`),
    ),
  );
  if (correction.attempts.length > 0) {
    head.append(
      el(
        "span",
        "tc-corr-count",
        t("remote.toolCall.correction.attemptCount", {
          count: correction.attempts.length,
        }),
      ),
    );
  }
  head.append(icon("chevron-down", "tc-corr-chevron"));
  details.append(head);

  const body = el("div", "tc-corr-body");

  const originalBlock = el("div", "tc-corr-block");
  originalBlock.append(
    el("pre", "tc-corr-pre", prettyArguments(correction.originalArguments)),
  );
  body.append(
    detailSection(
      t("remote.toolCall.correction.originalArguments"),
      originalBlock,
    ),
  );
  if (correction.attempts.length > 0) {
    const tree = el("ol", "tc-corr-tree");
    for (const attempt of correction.attempts) {
      tree.append(attemptNode(attempt));
    }
    body.append(tree);
  }

  if (correction.failureCode) {
    body.append(
      el(
        "div",
        "tc-corr-failure",
        t(`remote.toolCall.correction.failure.${correction.failureCode}`),
      ),
    );
  }

  if (correction.failureDetail) {
    body.append(
      el(
        "pre",
        "tc-corr-pre tc-corr-pre--muted",
        previewText(correction.failureDetail, 1_200),
      ),
    );
  }

  if (correction.attempts.some((attempt) => attempt.status === "succeeded")) {
    const replaced = el("div", "tc-corr-replaced");
    replaced.append(
      icon("circle-check", "tc-corr-replaced-icon"),
      el(
        "span",
        "tc-corr-replaced-text",
        t("remote.toolCall.correction.replaced"),
      ),
    );
    body.append(replaced);
  }

  details.append(body);
  return details;
};

/** 缩短签名用的稳定散列（FNV-1a，32 位）。 */
const digestHash = (text: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

/**
 * 纠错状态摘要：参与消息 / 工具卡签名，保证实时纠错进度（尝试追加、状态变化、
 * 结果替换）能触发移动端重绘。
 */
export const correctionDigest = (
  correction?: SnowRemoteToolCorrection,
): string => {
  if (!correction) return "";
  const attempts = correction.attempts
    .map((attempt) =>
      [
        attempt.index,
        attempt.status,
        digestHash(attempt.arguments),
        digestHash(attempt.reasoning ?? ""),
        digestHash(attempt.error ?? ""),
        digestHash(attempt.result ?? ""),
        attempt.finishedAt ?? 0,
      ].join(":"),
    )
    .join(",");
  return [
    correction.status,
    digestHash(correction.originalArguments),
    correction.failureCode ?? "",
    digestHash(correction.failureDetail ?? ""),
    attempts,
  ].join("|");
};
