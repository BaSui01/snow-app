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
  configJson: "{}",
  source: "manual",
};

export const EMBEDDING_TYPE_OPTIONS = [
  { value: "jina", label: "Jina & OpenAI" },
  { value: "ollama", label: "Ollama" },
  { value: "gemini", label: "Gemini" },
  { value: "mistral", label: "Mistral" },
];
