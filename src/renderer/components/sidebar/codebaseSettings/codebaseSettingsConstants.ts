import type { CodebaseSettingsInput } from "../../../../preload";

export const CODEBASE_SETTING_NAME = "Codebase settings";
export const CODEBASE_SETTING_CODE = "codebase_settings";

export const DEFAULT_CODEBASE_SETTINGS: CodebaseSettingsInput = {
  profileName: "default",
  embeddingType: "jina",
  embeddingModelName: "text-embedding-3-small",
  embeddingBaseUrl: "https://api.openai.com/v1",
  embeddingApiKey: "",
  embeddingDimensions: 1536,
  batchMaxLines: 10,
  batchConcurrency: 3,
  chunkingMaxLinesPerChunk: 200,
  chunkingMinLinesPerChunk: 10,
  chunkingMinCharsPerChunk: 20,
  chunkingOverlapLines: 20,
  modelContextLength: 8192,
  rerankingModelName: "",
  rerankingBaseUrl: "",
  rerankingApiKey: "",
  rerankingContextLength: 4096,
  rerankingTopN: 5,
  // 空 = 代理审查使用 LLM 基础模型；决策模型本身在「API 配置 → 决策模型」中维护。
  agentReviewModelId: "",
  // null = 决策模型沿用 choice 二分类判定；0-1 时改用概率判定并按阈值过滤。
  agentReviewRelevanceThreshold: null,
  configJson: "{}",
  source: "manual",
};

export const EMBEDDING_TYPE_OPTIONS = [
  { value: "jina", label: "Jina & OpenAI" },
  { value: "ollama", label: "Ollama" },
  { value: "gemini", label: "Gemini" },
  { value: "mistral", label: "Mistral" },
];
