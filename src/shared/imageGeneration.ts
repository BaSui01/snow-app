export const IMAGE_GENERATION_CONTEXT_KEY = "__snowImageGeneration";

export type ImageGenerationTaskStatus =
  "registered" | "queued" | "running" | "completed" | "failed" | "cancelled";

export type ImageGenerationTaskSnapshot = {
  taskId: string;
  conversationId: string;
  batchId: string;
  interactionId: string;
  callId: string;
  status: ImageGenerationTaskStatus;
  asynchronous: boolean;
  resultJson: string;
  createdAt: string;
  updatedAt: string;
  durationMs: number;
};

export type ImageGenerationBatchRegistration = {
  conversationId: string;
  batchId: string;
  members: Array<{ interactionId: string; callId: string }>;
};

export type ImageGenerationBatchSnapshot = {
  batchId: string;
  conversationId: string;
  sealed: boolean;
  notified: boolean;
  tasks: ImageGenerationTaskSnapshot[];
};

export type ImageGenerationApi = {
  onImageGenerationTask: (
    listener: (task: ImageGenerationTaskSnapshot) => void,
  ) => () => void;
  registerImageGenerationBatch: (
    registration: ImageGenerationBatchRegistration,
  ) => Promise<ImageGenerationBatchSnapshot>;
  sealImageGenerationBatch: (
    conversationId: string,
    batchId: string,
  ) => Promise<ImageGenerationBatchSnapshot>;
  listImageGenerationBatches: (
    conversationId: string,
  ) => Promise<ImageGenerationBatchSnapshot[]>;
  getImageGenerationTask: (
    conversationId: string,
    taskId: string,
  ) => Promise<ImageGenerationTaskSnapshot | null>;
  claimImageGenerationBatchNotification: (
    conversationId: string,
    batchId: string,
  ) => Promise<boolean>;
  releaseImageGenerationBatchNotification: (
    conversationId: string,
    batchId: string,
  ) => Promise<void>;
};

export type ImageGenerationNativeApi = {
  registerImageGenerationBatch: (registrationJson: string) => Promise<string>;
  sealImageGenerationBatch: (
    conversationId: string,
    batchId: string,
  ) => Promise<string>;
  listImageGenerationBatches: (conversationId: string) => Promise<string>;
  getImageGenerationTask: (
    conversationId: string,
    taskId: string,
  ) => Promise<string>;
  claimImageGenerationBatchNotification: (
    conversationId: string,
    batchId: string,
  ) => Promise<boolean>;
  releaseImageGenerationBatchNotification: (
    conversationId: string,
    batchId: string,
  ) => Promise<void>;
  recoverInterruptedImageGenerationTasks: () => Promise<number>;
};

const TASK_STATUSES = new Set<ImageGenerationTaskStatus>([
  "registered",
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const isImageGenerationTerminal = (
  status: ImageGenerationTaskStatus,
): boolean =>
  status === "completed" || status === "failed" || status === "cancelled";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseImageGenerationTask = (
  value: unknown,
): ImageGenerationTaskSnapshot | null => {
  if (!isRecord(value)) return null;
  const strings = [
    "taskId",
    "conversationId",
    "batchId",
    "interactionId",
    "callId",
    "resultJson",
    "createdAt",
    "updatedAt",
  ];
  if (
    strings.some((key) => typeof value[key] !== "string") ||
    !value.taskId ||
    !value.batchId ||
    !TASK_STATUSES.has(value.status as ImageGenerationTaskStatus) ||
    typeof value.asynchronous !== "boolean" ||
    typeof value.durationMs !== "number" ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0
  )
    return null;
  return value as ImageGenerationTaskSnapshot;
};

export const parseImageGenerationBatch = (
  value: unknown,
): ImageGenerationBatchSnapshot | null => {
  if (
    !isRecord(value) ||
    typeof value.batchId !== "string" ||
    !value.batchId ||
    typeof value.conversationId !== "string" ||
    typeof value.sealed !== "boolean" ||
    typeof value.notified !== "boolean" ||
    !Array.isArray(value.tasks)
  )
    return null;
  const tasks = value.tasks.map(parseImageGenerationTask);
  if (tasks.some((task) => task === null)) return null;
  return { ...value, tasks } as ImageGenerationBatchSnapshot;
};
