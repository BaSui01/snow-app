import type { LspServerConfigInput } from "../native/types";
import { isRecord, toBoolean, toText } from "../utils/value";

const LSP_SOURCE_MANUAL = "manual";

const assertJsonArray = (value: string, fieldName: string): void => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || "[]");
  } catch {
    throw new Error(`${fieldName} must be valid JSON`);
  }

  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${fieldName} must be a JSON string array`);
  }
};

const assertJsonObject = (value: string, fieldName: string): void => {
  if (!value.trim()) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${fieldName} must be valid JSON`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`${fieldName} must be a JSON object`);
  }
};

/** 将渲染层/agent 输入规范化为 LspServerConfigInput（照 normalizeMcpServerConfig 模式）。 */
export const normalizeLspServerConfig = (
  value: unknown
): LspServerConfigInput => {
  const source = isRecord(value) ? value : {};
  const lang = toText(source.lang).trim();
  const command = toText(source.command).trim();
  const argsJson = toText(source.argsJson, "[]");
  const fileExtensionsJson = toText(source.fileExtensionsJson, "[]");
  const rawSortOrder = Number(source.sortOrder ?? 0);

  if (!lang) {
    throw new Error("Language is required");
  }
  if (!command) {
    throw new Error("Command is required");
  }

  assertJsonArray(argsJson, "Args");
  assertJsonArray(fileExtensionsJson, "File extensions");
  assertJsonObject(toText(source.initializationOptionsJson), "Initialization options");

  const installCommand = toText(source.installCommand).trim();
  const initializationOptions = toText(source.initializationOptionsJson).trim();

  return {
    lang,
    command,
    argsJson,
    fileExtensionsJson,
    // napi Option<String> 不接受 null：空值省略字段（undefined）
    ...(installCommand ? { installCommand } : {}),
    ...(initializationOptions ? { initializationOptionsJson: initializationOptions } : {}),
    enabled: toBoolean(source.enabled, true),
    sortOrder: Number.isInteger(rawSortOrder) ? rawSortOrder : 0,
    source: toText(source.source).trim() || LSP_SOURCE_MANUAL,
  };
};
