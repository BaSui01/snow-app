import type {
  CustomCommandRecord,
  CustomCommandType,
} from "../../../../../preload";
import { parseContentSegments } from "../fileTagUtils";

export const CUSTOM_COMMANDS_CHANGED_EVENT = "snow:custom-commands-changed";

export const notifyCustomCommandsChanged = (): void => {
  window.dispatchEvent(new Event(CUSTOM_COMMANDS_CHANGED_EVENT));
};

export const CUSTOM_COMMAND_ARGUMENTS_PLACEHOLDER = "$ARGUMENTS";

export const CUSTOM_COMMAND_NAME_PATTERN = /^[\p{L}\p{N}_.-]+$/u;

export type EffectiveCustomCommand = {
  commandId: string;
  scope: "global" | "project";
  name: string;
  commandType: CustomCommandType;
  content: string;
  description: string;
  sortOrder: number;
};

export const selectEffectiveCustomCommands = (
  records: CustomCommandRecord[],
): EffectiveCustomCommand[] =>
  records
    .filter((record) => record.enabled && !record.shadowed)
    .map((record) => ({
      commandId: record.commandId,
      scope: record.scope,
      name: record.name,
      commandType: record.commandType,
      content: record.content,
      description: record.description,
      sortOrder: record.sortOrder,
    }))
    .sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) {
        return a.sortOrder - b.sortOrder;
      }
      return a.name.localeCompare(b.name);
    });

export const applyCustomCommandArguments = (
  content: string,
  args?: string,
): string => {
  const trimmedArgs = args?.trim() ?? "";
  if (content.includes(CUSTOM_COMMAND_ARGUMENTS_PLACEHOLDER)) {
    return content
      .split(CUSTOM_COMMAND_ARGUMENTS_PLACEHOLDER)
      .join(trimmedArgs);
  }
  if (!trimmedArgs) {
    return content;
  }
  return `${content} ${trimmedArgs}`;
};

export const extractCustomCommandArguments = (
  rawValue: string,
  commandLabel: string,
): string => {
  const plain = parseContentSegments(rawValue)
    .map((segment) => {
      if (segment.type === "text") {
        return segment.content;
      }
      const tag = segment.tag as unknown as Record<string, unknown>;
      for (const key of ["path", "skillId", "url", "content", "shortHash"]) {
        const value = tag[key];
        if (typeof value === "string" && value.length > 0) {
          return value;
        }
      }
      return "";
    })
    .join("");

  const matched = plain.trim().match(/^\/(\S+)\s+([\s\S]*)$/);
  if (!matched || matched[1].toLowerCase() !== commandLabel.toLowerCase()) {
    return "";
  }
  return matched[2].trim();
};
