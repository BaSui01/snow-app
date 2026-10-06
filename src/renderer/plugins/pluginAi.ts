import { splitDraftText } from "../components/mainContent/chatInput/fileTagUtils";
import type { PluginView } from "./types";

export type OptimizePromptOptions = {
  draft: string;
  conversationId?: string;
  apiProfile?: string;
  model?: string;
  contextRounds?: number;
  includeContext?: boolean;
  optimizationInstructions?: string;
  onChunk?: (delta: string) => void;
  signal?: AbortSignal;
};

export type PluginAiApi = {
  optimizePrompt?: (
    options: OptimizePromptOptions,
  ) => Promise<{ content: string }>;
};

type OptimizationBackend = {
  optimizePrompt?: (
    request: Omit<OptimizePromptOptions, "onChunk" | "signal"> & {
      streamId: string;
    },
    onChunk: (delta: string) => void,
  ) => Promise<{ content: string }>;
  abortPromptOptimization?: (streamId: string) => Promise<boolean>;
};

/** Only available in the ESM API; never fall back to ordinary conversation APIs. */
export const createPluginAiApi = (plugin: PluginView): PluginAiApi => {
  const backend = window.snow as typeof window.snow & OptimizationBackend;
  if (
    typeof backend.optimizePrompt !== "function" ||
    typeof backend.abortPromptOptimization !== "function"
  ) {
    return {};
  }
  return {
    optimizePrompt: async (options) => {
      if (
        !options ||
        typeof options.draft !== "string" ||
        !options.draft.trim()
      ) {
        throw new Error(
          "A non-empty, explicitly user-requested draft is required",
        );
      }
      if (splitDraftText(options.draft).chips.length > 0) {
        throw new Error("draft must be plain text without encoded chips");
      }
      // Default to no history. A conversation ID alone must not grant messages.
      if (
        options.includeContext === true &&
        !plugin.privacy.includes("messages")
      ) {
        throw new Error(
          "Declare 'messages' in plugin privacy scopes to include context",
        );
      }
      if (
        options.includeContext !== undefined &&
        typeof options.includeContext !== "boolean"
      ) {
        throw new Error("includeContext must be a boolean");
      }
      for (const key of ["conversationId", "apiProfile", "model"] as const) {
        if (options[key] !== undefined && typeof options[key] !== "string") {
          throw new Error(`${key} must be a string`);
        }
      }
      if (
        options.contextRounds !== undefined &&
        (!Number.isInteger(options.contextRounds) || options.contextRounds < 0)
      ) {
        throw new Error("contextRounds must be a non-negative integer");
      }
      if (
        options.optimizationInstructions !== undefined &&
        (typeof options.optimizationInstructions !== "string" ||
          Array.from(options.optimizationInstructions).length > 8000)
      ) {
        throw new Error(
          "optimizationInstructions must be a string of at most 8000 Unicode characters",
        );
      }
      const { signal, onChunk } = options;
      if (onChunk !== undefined && typeof onChunk !== "function") {
        throw new Error("onChunk must be a function");
      }
      if (signal?.aborted)
        throw new DOMException("Optimization cancelled", "AbortError");
      const streamId = crypto.randomUUID();
      let active = true;
      let rejectAbort: (error: Error) => void = () => undefined;
      const cancelled = new Promise<never>((_, reject) => {
        rejectAbort = reject;
      });
      const abort = (): void => {
        if (!active) return;
        active = false;
        // Separate stream ID and dedicated cancellation: never abort chat sessions.
        void backend.abortPromptOptimization!(streamId).catch(() => undefined);
        rejectAbort(new DOMException("Optimization cancelled", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const result = backend.optimizePrompt!(
          {
            streamId,
            draft: options.draft,
            conversationId: options.conversationId,
            apiProfile: options.apiProfile,
            model: options.model,
            contextRounds: options.contextRounds,
            includeContext: options.includeContext === true,
            optimizationInstructions: options.optimizationInstructions,
          },
          (delta) => {
            if (active && !signal?.aborted) onChunk?.(delta);
          },
        );
        return await Promise.race([result, cancelled]);
      } finally {
        active = false;
        signal?.removeEventListener("abort", abort);
      }
    },
  };
};
