import type {
  CustomCommandInput,
  CustomCommandScope,
  CustomCommandType,
} from "../native/types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toText = (value: unknown): string =>
  typeof value === "string" ? value : "";

export const normalizeCustomCommand = (value: unknown): CustomCommandInput => {
  const source = isRecord(value) ? value : {};
  const name = toText(source.name).trim();
  if (!name) {
    throw new Error("Custom command name is required");
  }

  const scope: CustomCommandScope =
    source.scope === "project" ? "project" : "global";
  const projectId = toText(source.projectId).trim();
  if (scope === "project" && !projectId) {
    throw new Error(
      "Project id is required for project scoped custom commands",
    );
  }

  const commandType: CustomCommandType =
    source.commandType === "bash" ? "bash" : "prompt";
  const content = toText(source.content).trim();
  if (!content) {
    throw new Error("Custom command content is required");
  }

  const rawSortOrder = Number(source.sortOrder ?? 0);

  return {
    commandId: toText(source.commandId).trim(),
    scope,
    projectId: scope === "project" ? projectId : "",
    name,
    commandType,
    content,
    description: toText(source.description).trim(),
    enabled: source.enabled !== false,
    sortOrder: Number.isInteger(rawSortOrder) ? rawSortOrder : 0,
  };
};
