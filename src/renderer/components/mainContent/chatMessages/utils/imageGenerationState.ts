import {
  isImageGenerationTerminal,
  parseImageGenerationTask,
  type ImageGenerationBatchSnapshot,
  type ImageGenerationTaskSnapshot,
} from "../../../../../shared/imageGeneration";
import { isRecord, parseImageGenResult } from "../toolCalls/imagegenUtils";
import type {
  ChatConversationMessage,
  ToolCallInfo,
} from "./conversationTypes";

export type ImageGenerationLabels = {
  failed: string;
  cancelled: string;
  unavailable: string;
  untracked: string;
};

const resultRecord = (
  result: string | undefined,
): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(result ?? "");
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const imageGenerationTaskId = (
  call: ToolCallInfo,
): string | undefined => {
  const taskId = resultRecord(call.result)?.taskId;
  return (
    call.imageGenerationTaskId ||
    (typeof taskId === "string" ? taskId : undefined)
  );
};

/** Never use arguments/prompt to associate paid requests with gallery slots. */
export const matchesImageGenerationTask = (
  call: ToolCallInfo,
  task: Pick<
    ImageGenerationTaskSnapshot,
    "taskId" | "interactionId" | "callId"
  >,
): boolean => {
  if (call.name !== "imagegen-generate") return false;
  const taskId = imageGenerationTaskId(call);
  if (taskId) return taskId === task.taskId;
  if (call.callId && task.callId) return call.callId === task.callId;
  return Boolean(
    call.interactionId && task.interactionId === call.interactionId,
  );
};

/** Labels reflect persisted execution state, not the number of visible cards. */
export const imageGenerationStatusKey = (call: ToolCallInfo): string => {
  if (call.imageGenerationTaskStatus === "registered")
    return "toolCall.imagegen.queued";
  if (call.imageGenerationTaskStatus === "queued")
    return "toolCall.imagegen.backendQueued";
  if (call.imageGenerationTaskStatus === "running")
    return "toolCall.imagegen.generating";
  if (parseImageGenResult(call.result).type === "pending")
    return "toolCall.imagegen.asyncPendingNotice";
  return call.status === "pending"
    ? "toolCall.imagegen.queued"
    : "toolCall.imagegen.submitting";
};

/** A delayed invoke receipt must not replace an already consumed terminal. */
export const settleImageGenerationReceipt = (
  call: ToolCallInfo,
  result: string,
): ToolCallInfo => {
  if (
    call.imageGenerationTaskStatus &&
    isImageGenerationTerminal(call.imageGenerationTaskStatus)
  ) {
    return call;
  }
  const parsed = parseImageGenResult(result);
  const record = resultRecord(result);
  const task = parseImageGenerationTask(record?.task);
  return {
    ...call,
    result,
    status:
      parsed.type === "pending"
        ? "running"
        : parsed.type === "error"
          ? "error"
          : "completed",
    imageGenerationTaskId:
      typeof record?.taskId === "string"
        ? record.taskId
        : call.imageGenerationTaskId,
    imageGenerationBatchId:
      typeof record?.batchId === "string"
        ? record.batchId
        : call.imageGenerationBatchId,
    imageGenerationTaskStatus:
      parsed.type === "pending"
        ? call.imageGenerationTaskStatus === "running" ||
          task?.status === "running"
          ? "running"
          : "queued"
        : parsed.type === "error"
          ? "failed"
          : "completed",
  };
};

export const projectImageGenerationTask = (
  call: ToolCallInfo,
  task: ImageGenerationTaskSnapshot,
  labels: ImageGenerationLabels,
): ToolCallInfo => {
  const terminal = isImageGenerationTerminal(task.status);
  // A list started before a completion can arrive after the completion event.
  if (
    !terminal &&
    call.imageGenerationTaskStatus &&
    isImageGenerationTerminal(call.imageGenerationTaskStatus)
  ) {
    return call;
  }
  let result = call.result;
  if (terminal) {
    result = task.resultJson;
    const parsed = parseImageGenResult(result);
    if (task.status !== "completed" || parsed.type !== "success") {
      const detail = resultRecord(result);
      result = JSON.stringify({
        ...(detail ?? {}),
        status: task.status,
        taskId: task.taskId,
        batchId: task.batchId,
        error:
          typeof detail?.error === "string" && detail.error.trim()
            ? detail.error
            : task.status === "cancelled"
              ? labels.cancelled
              : task.status === "failed"
                ? labels.failed
                : labels.unavailable,
      });
    }
  } else if (!result || parseImageGenResult(result).type === "pending") {
    result = JSON.stringify({
      ...(resultRecord(result) ?? {}),
      status: "pending",
      taskId: task.taskId,
      batchId: task.batchId,
    });
  }
  const status = terminal
    ? task.status === "completed" &&
      parseImageGenResult(result).type === "success"
      ? "completed"
      : "error"
    : task.status === "registered"
      ? "pending"
      : "running";
  if (
    call.result === result &&
    call.status === status &&
    call.imageGenerationTaskId === task.taskId &&
    call.imageGenerationTaskStatus === task.status
  )
    return call;
  return {
    ...call,
    result,
    status,
    imageGenerationTaskId: task.taskId,
    imageGenerationBatchId: task.batchId,
    imageGenerationTaskStatus: task.status,
    ...(terminal ? { streamingImages: undefined } : {}),
  };
};

/** Pure projection; storage, notification claims and queueing stay outside React. */
export const reconcileImageGenerationMessages = (
  messages: ChatConversationMessage[],
  tasks: ImageGenerationTaskSnapshot[],
  labels: ImageGenerationLabels,
  markUntracked = false,
): ChatConversationMessage[] => {
  let changed = false;
  const next = messages.map((message) => {
    let messageChanged = false;
    const toolCalls = message.toolCalls?.map((call) => {
      if (call.name !== "imagegen-generate") return call;
      const task = tasks.find((item) => matchesImageGenerationTask(call, item));
      let projected = task
        ? projectImageGenerationTask(call, task, labels)
        : call;
      const parsed = parseImageGenResult(call.result);
      if (
        !task &&
        markUntracked &&
        (parsed.type === "pending" ||
          (parsed.type === "empty" && call.status === "error"))
      ) {
        projected = {
          ...call,
          status: "error",
          imageGenerationTaskStatus: "failed",
          streamingImages: undefined,
          result: JSON.stringify({
            status: "failed",
            error: labels.untracked,
            errorCode: "IMAGE_GENERATION_UNTRACKED",
          }),
        };
      }
      if (projected !== call) messageChanged = true;
      return projected;
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...message, toolCalls };
  });
  return changed ? next : messages;
};

export const mergeImageGenerationBatch = (
  previous: ImageGenerationBatchSnapshot | undefined,
  incoming: ImageGenerationBatchSnapshot,
): ImageGenerationBatchSnapshot => {
  if (!previous) return incoming;
  const tasks = new Map(previous.tasks.map((task) => [task.taskId, task]));
  for (const task of incoming.tasks) {
    const current = tasks.get(task.taskId);
    if (
      !current ||
      (!isImageGenerationTerminal(current.status) &&
        (isImageGenerationTerminal(task.status) ||
          task.updatedAt >= current.updatedAt))
    ) {
      tasks.set(task.taskId, task);
    }
  }
  return {
    ...incoming,
    sealed: previous.sealed || incoming.sealed,
    notified: previous.notified || incoming.notified,
    tasks: [...tasks.values()],
  };
};

export const canNotifyImageGenerationBatch = (
  batch: ImageGenerationBatchSnapshot,
): boolean =>
  batch.sealed &&
  !batch.notified &&
  batch.tasks.length > 0 &&
  batch.tasks.every((task) => isImageGenerationTerminal(task.status)) &&
  batch.tasks.some((task) => task.asynchronous);
