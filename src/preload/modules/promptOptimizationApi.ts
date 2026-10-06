import { ipcRenderer, type IpcRendererEvent } from "electron";
import type {
  PromptOptimizationRequest,
  PromptOptimizationResult,
} from "../types/promptOptimization";

const CHUNK_CHANNEL = "prompt:optimization:chunk";
const streams = new Set<string>();

export const promptOptimizationApi = {
  optimizePrompt: (
    request: PromptOptimizationRequest,
    onChunk: (delta: string) => void,
  ): Promise<PromptOptimizationResult> => {
    if (
      !request ||
      typeof request.streamId !== "string" ||
      !request.streamId.trim() ||
      request.streamId !== request.streamId.trim()
    ) {
      return Promise.reject(new Error("Invalid prompt optimization stream ID"));
    }
    if (typeof onChunk !== "function") {
      return Promise.reject(
        new Error("Prompt optimization chunk callback is required"),
      );
    }
    if (streams.has(request.streamId)) {
      return Promise.reject(
        new Error("Prompt optimization stream is already running"),
      );
    }
    const streamId = request.streamId;
    streams.add(streamId);
    let callbackError: unknown;
    let callbackFailed = false;
    const handleChunk = (_event: IpcRendererEvent, payload: unknown): void => {
      if (!payload || typeof payload !== "object") return;
      const value = payload as { streamId?: unknown; delta?: unknown };
      if (
        value.streamId !== streamId ||
        typeof value.delta !== "string" ||
        !value.delta ||
        callbackFailed
      )
        return;
      try {
        onChunk(value.delta);
      } catch (error) {
        callbackError = error;
        callbackFailed = true;
        // Never leave an unhandled IPC rejection when a consumer throws.
        void ipcRenderer
          .invoke("prompt:optimization:abort", streamId)
          .catch(() => {});
      }
    };
    ipcRenderer.on(CHUNK_CHANNEL, handleChunk);
    return ipcRenderer
      .invoke("prompt:optimization:run", request)
      .then((result: PromptOptimizationResult) => {
        if (callbackFailed) throw callbackError;
        return result;
      })
      .finally(() => {
        streams.delete(streamId);
        ipcRenderer.removeListener(CHUNK_CHANNEL, handleChunk);
      });
  },
  abortPromptOptimization: (streamId: string): Promise<boolean> =>
    ipcRenderer.invoke("prompt:optimization:abort", streamId),
};
