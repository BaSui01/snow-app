import type { CodebaseSettingsInput } from "../../../../preload";

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
  /** 相关性阈值（0-1 的字符串；空 = 二分类判定）。 */
  agentReviewRelevanceThreshold: string;
};

export type CodebaseSettings = CodebaseSettingsInput;

/** 代码库设置页可「测试连接」的模型类别。 */
export type ModelTestKind = "embedding" | "reranking";
