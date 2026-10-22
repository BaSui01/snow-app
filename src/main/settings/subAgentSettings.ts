import { randomUUID } from "node:crypto";
import type { SubAgentConfigInput } from "../native/types";
import { isRecord, toInteger, toText } from "../utils/value";

const BUILTIN_GENERAL_AGENT_ID = "agent_general";
const SUB_AGENT_SOURCE_BUILTIN = "builtin";
const SUB_AGENT_SOURCE_MANUAL = "manual";

/** 只做形态规范化（去空白、去重、排序）；通配符/保留名/格式由 Rust 存储层统一校验。 */
const normalizeToolsJson = (value: unknown): string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(toText(value, "[]"));
  } catch {
    throw new Error("Sub-agent tools must be valid JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Sub-agent tools must be a JSON string array");
  }

  const tools = parsed
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
  return JSON.stringify(Array.from(new Set(tools)).sort());
};

export const normalizeSubAgentConfig = (
  value: unknown,
): SubAgentConfigInput => {
  const source = isRecord(value) ? value : {};
  const agentId =
    toText(source.agentId).trim() ||
    `agent_${randomUUID().replaceAll("-", "")}`;
  const name = toText(source.name).trim();
  const description = toText(source.description).trim();
  const configProfile = toText(source.configProfile).trim();
  const model = toText(source.model).trim();
  const builtin = agentId === BUILTIN_GENERAL_AGENT_ID;
  const rawProjectId = toText(source.projectId).trim();

  if (!name) {
    throw new Error("Sub-agent name is required");
  }
  if (name.length > 100) {
    throw new Error("Sub-agent name must be no longer than 100 characters");
  }
  if (description.length > 500) {
    throw new Error(
      "Sub-agent description must be no longer than 500 characters",
    );
  }
  return {
    agentId,
    name,
    description,
    systemPrompt: toText(source.systemPrompt),
    toolsJson: normalizeToolsJson(source.toolsJson),
    configProfile,
    model,
    builtin,
    sortOrder: toInteger(source.sortOrder, 0),
    source: builtin ? SUB_AGENT_SOURCE_BUILTIN : SUB_AGENT_SOURCE_MANUAL,
    projectId: rawProjectId || undefined,
  };
};
