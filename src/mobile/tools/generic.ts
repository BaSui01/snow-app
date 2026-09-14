/**
 * 兜底工具卡：未被任何模块认领的工具（或模块渲染器返回 null / 抛错）走这里。
 *
 * 信息层级对齐桌面 ToolCallItem 的兜底分支：
 * - 头部：徽章为工具短名，摘要为参数摘要（argsSummary 无结果时留空）；
 * - 折叠体：参数（美化 JSON，无法解析时显示原文）→ 流式输出 → 结果
 *   （错误行 / 长文本字段 / JSON 美化 / 原文，带字符数徽标）；
 * - 参数与结果都为空时给一行无内容提示，避免出现空白折叠体。
 */
import type { SnowRemoteToolCall } from "../../renderer/types/remoteControl";
import { t } from "../i18n";
import {
  argsSummary,
  createToolNode,
  decodeEscapedNewlines,
  extractLongText,
  formatJson,
  isTruncated,
  parseJsonRecord,
  resolveStatus,
  tcBadge,
  tcErrorRow,
  tcPre,
  tcSection,
  toolShortName,
} from "./ui";

/** 参数原文 → 展示文本：美化 JSON，半截 JSON 回退原文，空参数返回空串。 */
const argumentsText = (raw?: string): string => {
  const trimmed = (raw ?? "").trim();
  if (!trimmed || trimmed === "{}") return "";
  const record = parseJsonRecord(trimmed);
  return record ? formatJson(record) : decodeEscapedNewlines(trimmed);
};

/** 结果 → 节点：错误行 / 长文本 / JSON 美化 / 原文（附字符数与截断徽标）。 */
const resultSection = (raw?: string): DocumentFragment => {
  const fragment = document.createDocumentFragment();
  if (!raw) return fragment;

  const record = parseJsonRecord(raw);
  const error =
    record && typeof record.error === "string" ? record.error.trim() : "";
  if (error) {
    fragment.append(tcErrorRow(error));
    return fragment;
  }

  const longText = record ? extractLongText(record) : null;
  const content =
    longText ?? (record ? formatJson(record) : decodeEscapedNewlines(raw));
  const meta: Node[] = [
    tcBadge(
      t("remote.toolCall.common.charCount", {
        count: content.length.toLocaleString(),
      }),
    ),
  ];
  if (isTruncated(raw)) {
    meta.push(tcBadge(t("remote.toolCall.common.truncated"), "warn"));
  }
  fragment.append(
    tcSection(t("remote.toolCall.common.result"), tcPre(content), { meta }),
  );
  return fragment;
};

/** 空态提示行。 */
const emptyRow = (text: string): HTMLElement => {
  const row = document.createElement("div");
  row.className = "tc-empty";
  row.textContent = text;
  return row;
};

export const renderGenericTool = (tool: SnowRemoteToolCall): HTMLElement => {
  const body = document.createDocumentFragment();

  const args = argumentsText(tool.arguments);
  const hasOutput = Boolean(
    tool.result || tool.streamingStdout || tool.streamingStderr,
  );
  if (args) {
    body.append(tcSection(t("remote.toolCall.common.arguments"), tcPre(args)));
  } else if (hasOutput) {
    // 有输出但没有参数：显式标注参数为空，避免读者误以为数据缺失。
    body.append(
      tcSection(
        t("remote.toolCall.common.arguments"),
        tcPre(t("remote.toolCall.common.noArgs")),
      ),
    );
  }
  if (tool.streamingStdout) {
    body.append(
      tcSection(
        t("remote.toolCall.common.stdout"),
        tcPre(tool.streamingStdout),
      ),
    );
  }
  if (tool.streamingStderr) {
    const error = tcPre(tool.streamingStderr);
    error.classList.add("tc-pre-err");
    body.append(tcSection(t("remote.toolCall.common.stderr"), error));
  }
  body.append(resultSection(tool.result));
  if (!body.childNodes.length) {
    body.append(emptyRow(t("remote.toolCall.common.empty")));
  }

  return createToolNode({
    tool,
    status: resolveStatus(tool),
    badge: toolShortName(tool.name),
    display: argsSummary(tool.arguments),
    displayTitle: tool.arguments,
    body,
  });
};
