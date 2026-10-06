export type PromptOptimizationRequest = {
  streamId: string;
  draft: string;
  conversationId?: string;
  apiProfile?: string;
  model?: string;
  contextRounds?: number;
  includeContext?: boolean;
  /** Optional rewriting rules; max 8000 Unicode code points, blank means omitted. */
  optimizationInstructions?: string;
};

export type PromptOptimizationResult = { content: string };
