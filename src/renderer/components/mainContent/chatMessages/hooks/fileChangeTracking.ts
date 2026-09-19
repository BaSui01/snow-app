import type {
  ChatMessageRecord,
  FileChangeDiff,
  ToolCallInfo,
} from "../utils/conversationTypes";
import type { FileChangeRecord } from "../utils/conversationTypes";
import { parseToolCalls } from "../utils/conversationHelpers";
import { resolveResponseDisposition } from "../utils/responseDisposition";
import { pathsReferToSameFile } from "../toolCalls/shared/formatters";
import { generateComparePatch } from "../../../../utils/generateComparePatch";

/** Tools whose successful execution counts as a file modification. */
const FILE_MODIFYING_TOOLS = new Set([
  "filesystem-create",
  "filesystem-replace_edit",
  "filesystem-copy",
]);

/** 单次工具调用产生的文件变更（归属与时间戳由调用方补齐）。 */
type ExtractedFileMutation = Pick<
  FileChangeRecord,
  "filePath" | "kind" | "diff"
>;

/**
 * Build the diff patch for a successful file-modifying tool call so the
 * file-changes panel can show what actually changed:
 *   - filesystem-create: full file content (empty file -> content)
 *   - filesystem-replace_edit: the searchContent -> replaceContent
 *     replacement region with context lines
 *   - filesystem-copy: the pasted region (replacedContent -> pastedContent),
 *     read from the tool result because the arguments only carry line numbers
 * Every payload is persisted together with the call (arguments or result),
 * so the same patch can be rebuilt after a restart.
 */
const buildFileChangeDiff = (
  filePath: string,
  oldContent: string,
  newContent: string,
): FileChangeDiff | undefined => {
  if (!oldContent && !newContent) {
    return undefined;
  }
  try {
    const patch = generateComparePatch(filePath, oldContent, newContent);
    return patch ? { patch } : undefined;
  } catch {
    return undefined;
  }
};

const readText = (record: Record<string, unknown>, key: string): string =>
  typeof record[key] === "string" ? (record[key] as string) : "";

/**
 * 复制/剪切的文件变更：跨文件剪切会同时改写源文件与目标文件，因此产出两条
 * 记录（目标文件的粘贴区域 + 源文件的删除区域）；同文件移动只有一条记录。
 */
const buildCopyFileChanges = (
  args: Record<string, unknown>,
  result: Record<string, unknown>,
  filePath: string,
): ExtractedFileMutation[] => {
  const changes: ExtractedFileMutation[] = [
    {
      filePath,
      kind: "edit",
      diff: buildFileChangeDiff(
        filePath,
        readText(result, "replacedContent"),
        readText(result, "pastedContent"),
      ),
    },
  ];

  const sourceFilePath =
    readText(result, "sourceFilePath") || readText(args, "sourceFilePath");
  const removedContent = readText(result, "removedContent");
  if (
    result.deleteSource === true &&
    removedContent &&
    sourceFilePath &&
    !pathsReferToSameFile(sourceFilePath, filePath)
  ) {
    changes.push({
      filePath: sourceFilePath,
      kind: "edit",
      diff: buildFileChangeDiff(sourceFilePath, removedContent, ""),
    });
  }

  return changes;
};

/**
 * Extract the file-change records from a completed tool call, or an empty array
 * when the tool call did not modify a file (different tool, missing filePath,
 * or the tool result indicates failure).
 *
 * Only the dedicated filesystem write tools are tracked:
 *   - filesystem-create:        success = { "success": true, "path": ... }
 *   - filesystem-replace_edit:  success = { "success": true, ... }
 *   - filesystem-copy:          success = { "success": true, ... }
 * All of them carry the target path in the `filePath` argument, which is where
 * we read it from (the create result also echoes it, but the argument is the
 * single source of truth).
 *
 * The result JSON is parsed defensively: hooks may append context to the
 * result string, so a parse failure simply means "no record".
 */
export function extractFileChangesFromTool(
  toolName: string,
  argsJson: string,
  resultJson: string,
): ExtractedFileMutation[] {
  if (!FILE_MODIFYING_TOOLS.has(toolName)) {
    return [];
  }

  let args: unknown;
  let result: unknown;
  try {
    args = JSON.parse(argsJson);
    result = JSON.parse(resultJson);
  } catch {
    return [];
  }

  // A successful tool result carries "success": true. Anything else
  // (error JSON, plain text error, hook-abort JSON) is not a modification.
  if (
    typeof args !== "object" ||
    args === null ||
    typeof (args as Record<string, unknown>).filePath !== "string" ||
    typeof result !== "object" ||
    result === null ||
    (result as Record<string, unknown>).success !== true
  ) {
    return [];
  }

  const argsRecord = args as Record<string, unknown>;
  const resultRecord = result as Record<string, unknown>;
  const filePath = (argsRecord.filePath as string).trim();
  if (!filePath) {
    return [];
  }

  if (toolName === "filesystem-copy") {
    return buildCopyFileChanges(argsRecord, resultRecord, filePath);
  }

  if (toolName === "filesystem-create") {
    return [
      {
        filePath,
        kind: "create",
        diff: buildFileChangeDiff(
          filePath,
          "",
          readText(argsRecord, "content"),
        ),
      },
    ];
  }

  return [
    {
      filePath,
      kind: "edit",
      diff: buildFileChangeDiff(
        filePath,
        readText(argsRecord, "searchContent"),
        readText(argsRecord, "replaceContent"),
      ),
    },
  ];
}

/**
 * Collect the file-change records for a conversation. Main-agent changes are
 * stored under the conversation's own key (agent: "main"); sub-agent changes
 * are stored under both the sub-agent's key and the parent conversation's key
 * (agent: "sub", tagged with the sub-agent name) at record time — so a single
 * lookup here yields the full picture for display.
 *
 * Repeated edits to the same file are normalized to a single entry: only the
 * latest change (highest timestamp) survives, carrying the final diff, so the
 * stats list never shows multiple rows for one file path. Records are
 * returned in chronological order of their last modification.
 */
export function collectConversationFileChanges(
  fileChangeStats: Record<string, FileChangeRecord[]>,
  conversationId: string,
): FileChangeRecord[] {
  const changes = fileChangeStats[conversationId] ?? [];
  const latestByPath = new Map<string, FileChangeRecord>();
  for (const change of changes) {
    const existing = latestByPath.get(change.filePath);
    if (!existing || change.timestamp >= existing.timestamp) {
      latestByPath.set(change.filePath, change);
    }
  }
  return [...latestByPath.values()].sort(
    (left, right) => left.timestamp - right.timestamp,
  );
}

/** Count of unique file paths in a list of change records. */
export function countUniqueFiles(changes: FileChangeRecord[]): number {
  return new Set(changes.map((change) => change.filePath)).size;
}

export type FileChangeLineStats = {
  additions: number;
  deletions: number;
};

/**
 * Sum added and deleted lines from the unified diffs captured for file tools.
 * The first two lines are diff headers and are intentionally excluded.
 */
export function countFileChangeLines(
  changes: FileChangeRecord[],
): FileChangeLineStats {
  let additions = 0;
  let deletions = 0;

  for (const change of changes) {
    if (!change.diff?.patch || change.diff.isBinary) {
      continue;
    }

    const lines = change.diff.patch.split("\n").slice(2);
    for (const line of lines) {
      if (line.startsWith("+")) {
        additions += 1;
      } else if (line.startsWith("-")) {
        deletions += 1;
      }
    }
  }

  return { additions, deletions };
}

/** A file change extracted from persisted history, without agent attribution
 *  (the caller decides whether it belongs to the main agent or a sub-agent). */
export type ExtractedFileChange = Pick<
  FileChangeRecord,
  "filePath" | "kind" | "timestamp" | "diff"
>;

/**
 * Strip hook-appended sections from a persisted tool result so the raw
 * success JSON (which lives before the "[Hook Context]" marker) can be
 * parsed. Mirrors how toolExecution.ts appends hook context at runtime.
 */
const stripHookSuffix = (result: string): string =>
  result.split("\n\n[Hook Context]")[0] ?? result;

/**
 * Rebuild file-change records from persisted history records. The database
 * stores each assistant message's tool calls in `toolCallsJson` and each
 * tool result as `[Tool: name#callId]\n<result>` segments inside tool-message
 * content — the same pairing logic `buildConversationMessages` uses for the
 * live message list, so this reconstruction matches what the runtime stats
 * would have recorded.
 *
 * Timestamps come from the message's persisted `createdAt` so re-running this
 * extraction (e.g. after switching conversations) yields stable keys that the
 * merge step can de-duplicate against.
 */
export function extractFileChangesFromRecords(
  records: ChatMessageRecord[],
): ExtractedFileChange[] {
  const toolResultQueues = new Map<string, string[]>();
  for (const record of records) {
    if (record.role !== "tool" || !record.content) {
      continue;
    }
    for (const segment of record.content.split("\n\n")) {
      const match = segment.match(/^\[Tool:\s*(.+?)\]\n([\s\S]*)$/);
      if (!match) {
        continue;
      }
      const queue = toolResultQueues.get(match[1]) ?? [];
      queue.push(match[2]);
      toolResultQueues.set(match[1], queue);
    }
  }

  const consumeToolResult = (toolCall: ToolCallInfo): string | undefined => {
    const identifiers = toolCall.callId
      ? [`${toolCall.name}#${toolCall.callId}`, toolCall.name]
      : [toolCall.name];
    for (const identifier of identifiers) {
      const queue = toolResultQueues.get(identifier);
      if (queue && queue.length > 0) {
        return queue.shift();
      }
    }
    return undefined;
  };

  const changes: ExtractedFileChange[] = [];
  for (const record of records) {
    if (
      record.role !== "assistant" ||
      resolveResponseDisposition(record).kind !== "complete"
    ) {
      continue;
    }
    for (const toolCall of parseToolCalls(record.toolCallsJson)) {
      const result = consumeToolResult(toolCall);
      if (result === undefined) {
        continue;
      }
      const extracted = extractFileChangesFromTool(
        toolCall.name,
        toolCall.arguments,
        stripHookSuffix(result),
      );
      if (extracted.length === 0) {
        continue;
      }
      const parsedTimestamp = Date.parse(record.createdAt);
      const timestamp = Number.isFinite(parsedTimestamp)
        ? parsedTimestamp
        : Date.now();
      for (const change of extracted) {
        changes.push({ ...change, timestamp });
      }
    }
  }
  return changes;
}
