import { ipcRenderer, type IpcRendererEvent } from "electron";
import {
  parseImageGenerationBatch,
  parseImageGenerationTask,
  type ImageGenerationApi,
  type ImageGenerationBatchSnapshot,
  type ImageGenerationTaskSnapshot,
} from "../../shared/imageGeneration";

const TASK_CHANNEL = "imagegen:task";
const MAX_BUFFERED_TASKS = 32;
const MAX_BUFFERED_RESULT_CHARACTERS = 4 * 1024 * 1024;
const MAX_SEEN_TASK_VERSIONS = 256;
type TaskListener = (task: ImageGenerationTaskSnapshot) => void;
const listeners = new Set<TaskListener>();
const bufferedTasks = new Map<string, ImageGenerationTaskSnapshot>();
const seenVersions = new Map<string, string>();
let bufferedCharacters = 0;
let unloaded = false;

export const logImageGenerationDelivery = (
  delivery:
    | "callback_delivered"
    | "no_active_callback"
    | "callback_failed"
    | "task_read_failed"
    | "callback_budget_released",
  identity: { conversationId: string; taskId?: string; batchId?: string },
): void => {
  try {
    // A narrow, non-blocking event sink in main performs metadata-only logging.
    ipcRenderer.send("image-generation:delivery", {
      delivery,
      conversationId: identity.conversationId,
      taskId: identity.taskId ?? "",
      batchId: identity.batchId ?? "",
    });
  } catch {
    // Window teardown and logging failures cannot alter task results.
  }
};

const deliverTask = (
  listener: TaskListener,
  task: ImageGenerationTaskSnapshot,
): void => {
  try {
    listener(task);
  } catch {
    logImageGenerationDelivery("callback_failed", task);
  }
};

export const publishImageGenerationTask = (value: unknown): void => {
  if (unloaded) return;
  const task = parseImageGenerationTask(value);
  if (!task) return;
  const previousVersion = seenVersions.get(task.taskId);
  if (previousVersion === task.updatedAt) return;
  // Query recovery is authoritative, but an older queued IPC must not replace it.
  if (
    previousVersion !== undefined &&
    Date.parse(previousVersion) > Date.parse(task.updatedAt)
  )
    return;
  seenVersions.delete(task.taskId);
  seenVersions.set(task.taskId, task.updatedAt);
  while (seenVersions.size > MAX_SEEN_TASK_VERSIONS) {
    const oldest = seenVersions.keys().next().value;
    if (oldest !== undefined) seenVersions.delete(oldest);
  }
  const previous = bufferedTasks.get(task.taskId);
  if (previous) bufferedCharacters -= previous.resultJson.length;
  bufferedTasks.delete(task.taskId);
  if (task.resultJson.length <= MAX_BUFFERED_RESULT_CHARACTERS) {
    bufferedTasks.set(task.taskId, task);
    bufferedCharacters += task.resultJson.length;
  }
  while (
    bufferedTasks.size > MAX_BUFFERED_TASKS ||
    bufferedCharacters > MAX_BUFFERED_RESULT_CHARACTERS
  ) {
    const oldest = bufferedTasks.keys().next().value;
    if (oldest === undefined) break;
    const removed = bufferedTasks.get(oldest);
    bufferedCharacters -= removed?.resultJson.length ?? 0;
    bufferedTasks.delete(oldest);
  }
  for (const listener of [...listeners]) deliverTask(listener, task);
};

const taskListener = (_event: IpcRendererEvent, value: unknown): void => {
  publishImageGenerationTask(value);
};
// Installed when the preload module loads, independent of invoke or React mounts.
ipcRenderer.on(TASK_CHANNEL, taskListener);
window.addEventListener(
  "unload",
  () => {
    unloaded = true;
    ipcRenderer.removeListener(TASK_CHANNEL, taskListener);
    listeners.clear();
    bufferedTasks.clear();
    seenVersions.clear();
    bufferedCharacters = 0;
  },
  { once: true },
);

const decodeBatch = (
  value: unknown,
  conversationId: string,
  batchId?: string,
): ImageGenerationBatchSnapshot => {
  const batch = parseImageGenerationBatch(value);
  if (
    !batch ||
    batch.conversationId !== conversationId ||
    (batchId !== undefined && batch.batchId !== batchId) ||
    batch.tasks.some(
      (task) =>
        task.conversationId !== conversationId ||
        task.batchId !== batch.batchId,
    )
  )
    throw new Error("Invalid image generation batch response");
  return batch;
};

export const imageGenerationApi: ImageGenerationApi = {
  onImageGenerationTask: (listener) => {
    listeners.add(listener);
    for (const task of [...bufferedTasks.values()]) {
      if (!listeners.has(listener)) break;
      deliverTask(listener, task);
    }
    return () => {
      listeners.delete(listener);
    };
  },
  registerImageGenerationBatch: async (registration) =>
    decodeBatch(
      await ipcRenderer.invoke("image-generation:register-batch", registration),
      registration.conversationId.trim(),
      registration.batchId.trim(),
    ),
  sealImageGenerationBatch: async (conversationId, batchId) =>
    decodeBatch(
      await ipcRenderer.invoke(
        "image-generation:seal-batch",
        conversationId,
        batchId,
      ),
      conversationId.trim(),
      batchId.trim(),
    ),
  listImageGenerationBatches: async (conversationId) => {
    const value: unknown = await ipcRenderer.invoke(
      "image-generation:list-batches",
      conversationId,
    );
    if (!Array.isArray(value))
      throw new Error("Invalid image generation batch list response");
    const batches = value.map((batch: unknown) =>
      decodeBatch(batch, conversationId.trim()),
    );
    for (const batch of batches) {
      for (const task of batch.tasks) publishImageGenerationTask(task);
    }
    return batches;
  },
  getImageGenerationTask: async (conversationId, taskId) => {
    const value: unknown = await ipcRenderer.invoke(
      "image-generation:get-task",
      conversationId,
      taskId,
    );
    if (value === null) return null;
    const task = parseImageGenerationTask(value);
    if (
      !task ||
      task.conversationId !== conversationId.trim() ||
      task.taskId !== taskId.trim()
    ) {
      throw new Error("Invalid image generation task response");
    }
    publishImageGenerationTask(task);
    return task;
  },
  claimImageGenerationBatchNotification: async (conversationId, batchId) => {
    const value: unknown = await ipcRenderer.invoke(
      "image-generation:claim-notification",
      conversationId,
      batchId,
    );
    if (typeof value !== "boolean")
      throw new Error("Invalid image generation notification claim response");
    return value;
  },
  releaseImageGenerationBatchNotification: async (conversationId, batchId) => {
    await ipcRenderer.invoke(
      "image-generation:release-notification",
      conversationId,
      batchId,
    );
  },
};
