import type { WebContents } from "electron";
import {
  IMAGE_GENERATION_CONTEXT_KEY,
  parseImageGenerationTask,
  type ImageGenerationTaskSnapshot,
} from "../../../shared/imageGeneration";
import { snowLog } from "../../../utils/snowLogger";
import type { BashStreamChunk } from "../../native/types";
import { safeSend } from "../../utils/safeSend";

const MCP_TOOL_CHUNK_CHANNEL = "mcp:call-tool:chunk";
const MAX_CONTEXT_ID_LENGTH = 512;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Classification follows the native recovery of polluted tool names. Other
// tools keep their original arguments, names, and streaming behavior.
const isImageGenerationTool = (name: string): boolean => {
  if (!/[<>\[\]# \t\n\r"']/u.test(name)) return name === "imagegen-generate";
  const fragments = name.match(/[A-Za-z0-9_-]+/gu) ?? [];
  let longest = "";
  for (const fragment of fragments) {
    if (fragment.includes("-") && fragment.length > longest.length)
      longest = fragment;
  }
  return longest === "imagegen-generate";
};

const requireContextId = (value: string): string => {
  if (
    value.length > MAX_CONTEXT_ID_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("Invalid image generation runtime context ID");
  }
  return value;
};

export const injectImageGenerationContext = (
  toolName: string,
  argsJson: string,
  conversationId: string,
  interactionId: string,
): string => {
  if (!isImageGenerationTool(toolName)) return argsJson;
  let args: unknown;
  try {
    args = JSON.parse(argsJson) as unknown;
  } catch {
    throw new Error("Image generation arguments must be a JSON object");
  }
  if (!isRecord(args)) {
    throw new Error("Image generation arguments must be a JSON object");
  }
  return JSON.stringify({
    ...args,
    [IMAGE_GENERATION_CONTEXT_KEY]: {
      conversationId: requireContextId(conversationId),
      interactionId: requireContextId(interactionId),
    },
  });
};

export type ImageGenerationDelivery =
  | "chunk_ipc_sent"
  | "chunk_ipc_dropped"
  | "task_ipc_sent"
  | "task_ipc_dropped"
  | "task_snapshot_rejected"
  | "callback_delivered"
  | "no_active_callback"
  | "callback_failed"
  | "task_read_recovery"
  | "task_read_missing"
  | "task_read_failed"
  | "callback_budget_released";

type TaskIdentity = {
  conversationId: unknown;
  taskId?: unknown;
  batchId?: unknown;
};

const logIdentifier = (value: unknown): string =>
  typeof value === "string" &&
  value.length <= MAX_CONTEXT_ID_LENGTH &&
  /^[A-Za-z0-9._:-]*$/u.test(value)
    ? value
    : "";

export const recordImageGenerationDelivery = (
  delivery: ImageGenerationDelivery,
  identity: TaskIdentity,
): void => {
  try {
    const entry = {
      module: "imagegen/ipc",
      func: "delivery",
      message: `Image generation ${delivery}`,
      context: JSON.stringify({
        conversation_id: logIdentifier(identity.conversationId),
        taskId: logIdentifier(identity.taskId),
        batchId: logIdentifier(identity.batchId),
      }),
    };
    if (/dropped|rejected|failed|released/u.test(delivery)) snowLog.warn(entry);
    else snowLog.debug(entry);
  } catch {
    // Logging is fire-and-forget and cannot replace an already-persisted result.
  }
};

// Explicitly select contract fields; unknown native metadata never crosses the
// dedicated task channel, even if the shared parser permits extension fields.
const taskPayload = (
  task: ImageGenerationTaskSnapshot,
): ImageGenerationTaskSnapshot => ({
  taskId: task.taskId,
  conversationId: task.conversationId,
  batchId: task.batchId,
  interactionId: task.interactionId,
  callId: task.callId,
  status: task.status,
  asynchronous: task.asynchronous,
  resultJson: task.resultJson,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
  durationMs: task.durationMs,
});

export const forwardMcpToolChunk = (
  sender: WebContents,
  streamId: string,
  conversationId: string,
  chunk: BashStreamChunk,
): void => {
  if (chunk.stream !== "imagegen") {
    safeSend(sender, MCP_TOOL_CHUNK_CHANNEL, { streamId, chunk });
    return;
  }
  let metadata: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(chunk.data);
    if (isRecord(value)) metadata = value;
  } catch {
    // Never log native text, prompts, result payloads, or exception messages.
  }
  const identity = {
    conversationId,
    taskId: metadata.taskId,
    batchId: metadata.batchId,
  };
  let chunkSent = false;
  try {
    chunkSent = safeSend(sender, MCP_TOOL_CHUNK_CHANNEL, { streamId, chunk });
  } catch {
    // A disposed renderer must not fail the native task.
  }
  recordImageGenerationDelivery(
    chunkSent ? "chunk_ipc_sent" : "chunk_ipc_dropped",
    identity,
  );

  const task = parseImageGenerationTask(metadata.task);
  if (!task || task.conversationId !== conversationId) {
    if (metadata.task !== undefined || metadata.type !== "partial_image") {
      recordImageGenerationDelivery("task_snapshot_rejected", identity);
    }
    return;
  }
  let taskSent = false;
  try {
    taskSent = safeSend(sender, "imagegen:task", taskPayload(task));
  } catch {
    // The persisted task remains queryable after window refresh or disposal.
  }
  recordImageGenerationDelivery(
    taskSent ? "task_ipc_sent" : "task_ipc_dropped",
    task,
  );
};
