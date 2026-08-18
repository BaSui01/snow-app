import type { LspServerConfigInput } from "../../../../preload";
import type { LspServerConfig, LspServerDraft, LspStringItem } from "./types";

let stringItemSeq = 0;

export const createLspStringItem = (value = ""): LspStringItem => {
  stringItemSeq += 1;
  return { id: `lsp-item-${stringItemSeq}`, value };
};

/** 解析 JSON 数组字符串；非法时返回空数组。 */
const parseJsonArray = (json: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(json || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
};

/** 解析 JSON 对象字符串并美化；非法/空时返回空字符串。 */
export const formatJsonObject = (json: string): string => {
  if (!json.trim()) {
    return "";
  }
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
};

/** 校验初始化选项 JSON 文本；返回错误信息（空字符串 = 合法）。 */
export const validateInitializationOptions = (text: string): string => {
  if (!text.trim()) {
    return "";
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return "initializationOptions must be a JSON object";
    }
    return "";
  } catch {
    return "initializationOptions must be valid JSON";
  }
};

export const toDraft = (server: LspServerConfig): LspServerDraft => ({
  id: server.id,
  lang: server.lang,
  command: server.command,
  args: parseJsonArray(server.argsJson).map(createLspStringItem),
  fileExtensions: parseJsonArray(server.fileExtensionsJson).map(
    createLspStringItem
  ),
  installCommand: server.installCommand ?? "",
  initializationOptions: formatJsonObject(
    server.initializationOptionsJson ?? ""
  ),
  enabled: server.enabled,
  sortOrder: server.sortOrder,
  source: server.source,
});

export const toInput = (draft: LspServerDraft): LspServerConfigInput => ({
  lang: draft.lang.trim(),
  command: draft.command.trim(),
  argsJson: JSON.stringify(draft.args.map((item) => item.value)),
  fileExtensionsJson: JSON.stringify(
    draft.fileExtensions.map((item) => item.value)
  ),
  // napi Option<String> 不接受 null：空值省略字段（undefined）
  ...(draft.installCommand.trim() ? { installCommand: draft.installCommand.trim() } : {}),
  ...(draft.initializationOptions.trim()
    ? { initializationOptionsJson: draft.initializationOptions.trim() }
    : {}),
  enabled: draft.enabled,
  sortOrder: draft.sortOrder,
  source: draft.source,
});
