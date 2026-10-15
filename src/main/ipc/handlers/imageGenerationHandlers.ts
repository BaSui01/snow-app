import { ipcMain, type IpcMainInvokeEvent } from "electron";
import {
  parseImageGenerationBatch,
  parseImageGenerationTask,
  type ImageGenerationBatchRegistration,
  type ImageGenerationBatchSnapshot,
  type ImageGenerationTaskSnapshot,
} from "../../../shared/imageGeneration";
import { getMainWindow } from "../../app/mainWindow";
import type { NativeBridge } from "../../native/types";
import {
  recordImageGenerationDelivery,
  type ImageGenerationDelivery,
} from "./imageGenerationToolBridge";

const MAX_IDENTIFIER_LENGTH = 512;
const MAX_BATCH_MEMBERS = 512;
const MAX_REGISTRATION_BYTES = 1024 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertMainFrame = (
  event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">,
): void => {
  const mainWindow = getMainWindow();
  if (
    !mainWindow ||
    mainWindow.isDestroyed() ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== event.sender.mainFrame
  ) {
    throw new Error(
      "Image generation IPC is restricted to the Snow main frame",
    );
  }
};

const requireIdentifier = (
  value: unknown,
  field: string,
  allowEmpty = false,
): string => {
  if (
    typeof value !== "string" ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    (!allowEmpty && !value.trim()) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`Invalid image generation ${field}`);
  }
  return value.trim();
};

const requireConversation = async (
  native: NativeBridge,
  value: unknown,
  allowEmpty = false,
): Promise<string> => {
  const conversationId = requireIdentifier(
    value,
    "conversation ID",
    allowEmpty,
  );
  if (conversationId && !(await native.getChatConversation(conversationId))) {
    throw new Error("Image generation conversation does not exist");
  }
  return conversationId;
};

const requireRegistration = (
  value: unknown,
): ImageGenerationBatchRegistration => {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !["conversationId", "batchId", "members"].includes(key),
    ) ||
    !Array.isArray(value.members) ||
    !value.members.length ||
    value.members.length > MAX_BATCH_MEMBERS
  ) {
    throw new Error("Invalid image generation batch registration");
  }
  const conversationId = requireIdentifier(
    value.conversationId,
    "conversation ID",
  );
  const batchId = requireIdentifier(value.batchId, "batch ID");
  const interactionIds = new Set<string>();
  const callIds = new Set<string>();
  const members = value.members.map((member: unknown) => {
    if (
      !isRecord(member) ||
      Object.keys(member).some(
        (key) => key !== "interactionId" && key !== "callId",
      )
    ) {
      throw new Error("Invalid image generation batch member");
    }
    const interactionId = requireIdentifier(
      member.interactionId,
      "interaction ID",
    );
    const callId = requireIdentifier(member.callId, "call ID");
    if (interactionIds.has(interactionId) || callIds.has(callId)) {
      throw new Error("Duplicate image generation batch member");
    }
    interactionIds.add(interactionId);
    callIds.add(callId);
    return { interactionId, callId };
  });
  const registration = { conversationId, batchId, members };
  if (
    Buffer.byteLength(JSON.stringify(registration), "utf8") >
    MAX_REGISTRATION_BYTES
  ) {
    throw new Error("Image generation batch registration is too large");
  }
  return registration;
};

const decodeNativeJson = (value: unknown): unknown => {
  if (typeof value !== "string") {
    throw new Error("Invalid image generation native response");
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // Never include native payloads: terminal results can contain private text.
    throw new Error("Invalid image generation native JSON response");
  }
};

const decodeBatch = (
  value: unknown,
  conversationId: string,
  batchId?: string,
): ImageGenerationBatchSnapshot => {
  const snapshot = parseImageGenerationBatch(value);
  if (
    !snapshot ||
    snapshot.conversationId !== conversationId ||
    (batchId !== undefined && snapshot.batchId !== batchId) ||
    snapshot.tasks.some(
      (task) =>
        task.conversationId !== conversationId ||
        task.batchId !== snapshot.batchId,
    )
  ) {
    throw new Error("Invalid image generation batch response scope");
  }
  return snapshot;
};

export const registerImageGenerationHandlers = (native: NativeBridge): void => {
  const rendererDeliveryEvents = new Set<ImageGenerationDelivery>([
    "callback_delivered",
    "no_active_callback",
    "callback_failed",
    "task_read_failed",
    "callback_budget_released",
  ]);
  ipcMain.on("image-generation:delivery", (event, payload: unknown) => {
    try {
      assertMainFrame(event);
      if (
        !isRecord(payload) ||
        !rendererDeliveryEvents.has(payload.delivery as ImageGenerationDelivery)
      )
        return;
      const conversationId = requireIdentifier(
        payload.conversationId,
        "conversation ID",
        true,
      );
      const taskId = requireIdentifier(payload.taskId ?? "", "task ID", true);
      const batchId = requireIdentifier(
        payload.batchId ?? "",
        "batch ID",
        true,
      );
      recordImageGenerationDelivery(
        payload.delivery as ImageGenerationDelivery,
        { conversationId, taskId, batchId },
      );
    } catch {
      // Untrusted metadata and disposed windows must not affect the IPC hot path.
    }
  });
  ipcMain.handle(
    "image-generation:register-batch",
    async (event, value: unknown): Promise<ImageGenerationBatchSnapshot> => {
      assertMainFrame(event);
      const registration = requireRegistration(value);
      await requireConversation(native, registration.conversationId);
      return decodeBatch(
        decodeNativeJson(
          await native.registerImageGenerationBatch(
            JSON.stringify(registration),
          ),
        ),
        registration.conversationId,
        registration.batchId,
      );
    },
  );
  ipcMain.handle(
    "image-generation:seal-batch",
    async (
      event,
      conversationId: unknown,
      batchId: unknown,
    ): Promise<ImageGenerationBatchSnapshot> => {
      assertMainFrame(event);
      const batch = requireIdentifier(batchId, "batch ID");
      const conversation = await requireConversation(native, conversationId);
      return decodeBatch(
        decodeNativeJson(
          await native.sealImageGenerationBatch(conversation, batch),
        ),
        conversation,
        batch,
      );
    },
  );
  ipcMain.handle(
    "image-generation:list-batches",
    async (
      event,
      conversationId: unknown,
    ): Promise<ImageGenerationBatchSnapshot[]> => {
      assertMainFrame(event);
      const conversation = await requireConversation(native, conversationId);
      const result = decodeNativeJson(
        await native.listImageGenerationBatches(conversation),
      );
      if (!Array.isArray(result)) {
        throw new Error("Invalid image generation batch list response");
      }
      const snapshots = result.map((batch: unknown) =>
        decodeBatch(batch, conversation),
      );
      for (const batch of snapshots) {
        for (const task of batch.tasks)
          recordImageGenerationDelivery("task_read_recovery", task);
      }
      return snapshots;
    },
  );
  ipcMain.handle(
    "image-generation:get-task",
    async (
      event,
      conversationId: unknown,
      taskId: unknown,
    ): Promise<ImageGenerationTaskSnapshot | null> => {
      assertMainFrame(event);
      const task = requireIdentifier(taskId, "task ID");
      // Unregistered direct calls deliberately use an empty conversation scope.
      const conversation = await requireConversation(
        native,
        conversationId,
        true,
      );
      try {
        const result = decodeNativeJson(
          await native.getImageGenerationTask(conversation, task),
        );
        if (result === null) {
          recordImageGenerationDelivery("task_read_missing", {
            conversationId: conversation,
            taskId: task,
          });
          return null;
        }
        const snapshot = parseImageGenerationTask(result);
        if (
          !snapshot ||
          snapshot.conversationId !== conversation ||
          snapshot.taskId !== task
        ) {
          throw new Error("Invalid image generation task response scope");
        }
        recordImageGenerationDelivery("task_read_recovery", snapshot);
        return snapshot;
      } catch {
        recordImageGenerationDelivery("task_read_failed", {
          conversationId: conversation,
          taskId: task,
        });
        throw new Error("Image generation task recovery failed");
      }
    },
  );
  ipcMain.handle(
    "image-generation:claim-notification",
    async (
      event,
      conversationId: unknown,
      batchId: unknown,
    ): Promise<boolean> => {
      assertMainFrame(event);
      const batch = requireIdentifier(batchId, "batch ID");
      const conversation = await requireConversation(native, conversationId);
      const claimed = await native.claimImageGenerationBatchNotification(
        conversation,
        batch,
      );
      if (typeof claimed !== "boolean") {
        throw new Error("Invalid image generation notification claim response");
      }
      return claimed;
    },
  );
  ipcMain.handle(
    "image-generation:release-notification",
    async (event, conversationId: unknown, batchId: unknown): Promise<void> => {
      assertMainFrame(event);
      const batch = requireIdentifier(batchId, "batch ID");
      const conversation = await requireConversation(native, conversationId);
      await native.releaseImageGenerationBatchNotification(conversation, batch);
    },
  );
};
