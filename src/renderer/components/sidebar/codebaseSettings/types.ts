import type { CodebaseSettingsInput } from "../../../../preload";

export type CodebaseSettingsPanelProps = {
  onClose?: () => void;
};

export type CodebaseSettingsForm = {
  profileName: string;
  embeddingType: string;
  embeddingModelName: string;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  embeddingDimensions: string;
  batchMaxLines: string;
  batchConcurrency: string;
  chunkingMaxLinesPerChunk: string;
  chunkingMinLinesPerChunk: string;
  chunkingMinCharsPerChunk: string;
  chunkingOverlapLines: string;
  modelContextLength: string;
  rerankingModelName: string;
  rerankingBaseUrl: string;
  rerankingApiKey: string;
  rerankingContextLength: string;
  rerankingTopN: string;
  /** 代理审查选用的决策模型 id（空 = 使用基础 LLM 模型）。 */
  agentReviewModelId: string;
};

export type CodebaseSettings = CodebaseSettingsInput;
