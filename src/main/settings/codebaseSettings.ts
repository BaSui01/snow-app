import type { CodebaseSettingsInput, NativeBridge } from "../native/types";
import {
  SNOW_CLI_GLOBAL_SETTINGS_FILE,
  SNOW_CLI_PROJECT_SETTINGS_FILE,
} from "../snowCli/paths";
import { readJsonFile } from "../utils/jsonFile";
import { isRecord, toPositiveInteger, toText } from "../utils/value";

const CODEBASE_SETTING_NAME = "Codebase settings";
const CODEBASE_SETTING_CODE = "codebase_settings";

const DEFAULT_CODEBASE_SETTINGS: CodebaseSettingsInput = {
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

const getCodebaseObject = (
  settings: Record<string, unknown> | null
): Record<string, unknown> => {
  const codebase = settings?.codebase;
  return isRecord(codebase) ? codebase : {};
};

export const normalizeCodebaseSettings = (
  value: unknown
): CodebaseSettingsInput => {
  const source = isRecord(value) ? value : {};
  const profileName = toText(
    source.profileName,
    DEFAULT_CODEBASE_SETTINGS.profileName
  ).trim();
  const embeddingType = toText(
    source.embeddingType,
    DEFAULT_CODEBASE_SETTINGS.embeddingType
  ).trim();
  const sourceLabel = toText(
    source.source,
    DEFAULT_CODEBASE_SETTINGS.source
  ).trim();

  return {
    profileName: profileName || DEFAULT_CODEBASE_SETTINGS.profileName,
    embeddingType: embeddingType || DEFAULT_CODEBASE_SETTINGS.embeddingType,
    embeddingModelName: toText(
      source.embeddingModelName,
      DEFAULT_CODEBASE_SETTINGS.embeddingModelName
    ).trim(),
    embeddingBaseUrl: toText(
      source.embeddingBaseUrl,
      DEFAULT_CODEBASE_SETTINGS.embeddingBaseUrl
    ).trim(),
    embeddingApiKey: toText(
      source.embeddingApiKey,
      DEFAULT_CODEBASE_SETTINGS.embeddingApiKey
    ),
    embeddingDimensions: toPositiveInteger(
      source.embeddingDimensions,
      DEFAULT_CODEBASE_SETTINGS.embeddingDimensions
    ),
    batchMaxLines: toPositiveInteger(
      source.batchMaxLines,
      DEFAULT_CODEBASE_SETTINGS.batchMaxLines
    ),
    batchConcurrency: toPositiveInteger(
      source.batchConcurrency,
      DEFAULT_CODEBASE_SETTINGS.batchConcurrency
    ),
    chunkingMaxLinesPerChunk: toPositiveInteger(
      source.chunkingMaxLinesPerChunk,
      DEFAULT_CODEBASE_SETTINGS.chunkingMaxLinesPerChunk
    ),
    chunkingMinLinesPerChunk: toPositiveInteger(
      source.chunkingMinLinesPerChunk,
      DEFAULT_CODEBASE_SETTINGS.chunkingMinLinesPerChunk
    ),
    chunkingMinCharsPerChunk: toPositiveInteger(
      source.chunkingMinCharsPerChunk,
      DEFAULT_CODEBASE_SETTINGS.chunkingMinCharsPerChunk
    ),
    chunkingOverlapLines: toPositiveInteger(
      source.chunkingOverlapLines,
      DEFAULT_CODEBASE_SETTINGS.chunkingOverlapLines
    ),
    modelContextLength: toPositiveInteger(
      source.modelContextLength,
      DEFAULT_CODEBASE_SETTINGS.modelContextLength
    ),
    rerankingModelName: toText(source.rerankingModelName).trim(),
    rerankingBaseUrl: toText(source.rerankingBaseUrl).trim(),
    rerankingApiKey: toText(source.rerankingApiKey),
    rerankingContextLength: toPositiveInteger(
      source.rerankingContextLength,
      DEFAULT_CODEBASE_SETTINGS.rerankingContextLength
    ),
    rerankingTopN: toPositiveInteger(
      source.rerankingTopN,
      DEFAULT_CODEBASE_SETTINGS.rerankingTopN
    ),
    configJson: toText(source.configJson, DEFAULT_CODEBASE_SETTINGS.configJson),
    source: sourceLabel || DEFAULT_CODEBASE_SETTINGS.source,
  };
};

export const persistCodebaseSettings = async (
  native: NativeBridge,
  settings: CodebaseSettingsInput
): Promise<CodebaseSettingsInput> => {
  const normalized = normalizeCodebaseSettings(settings);
  await native.setSystemSetting(
    CODEBASE_SETTING_NAME,
    CODEBASE_SETTING_CODE,
    JSON.stringify(normalized)
  );
  return normalized;
};

export const readSnowCliCodebaseSettings = async (
  native: NativeBridge
): Promise<CodebaseSettingsInput> => {
  const globalSettings = readJsonFile(SNOW_CLI_GLOBAL_SETTINGS_FILE);
  const projectSettings = readJsonFile(SNOW_CLI_PROJECT_SETTINGS_FILE);
  const globalCodebase = getCodebaseObject(globalSettings);
  const projectCodebase = getCodebaseObject(projectSettings);
  const embedding = isRecord(globalCodebase.embedding)
    ? globalCodebase.embedding
    : {};
  const reranking = isRecord(globalCodebase.reranking)
    ? globalCodebase.reranking
    : {};
  const batch = isRecord(projectCodebase.batch) ? projectCodebase.batch : {};
  const chunking = isRecord(projectCodebase.chunking)
    ? projectCodebase.chunking
    : {};
  const config = normalizeCodebaseSettings({
    profileName: "default",
    embeddingType: embedding.type,
    embeddingModelName: embedding.modelName,
    embeddingBaseUrl: embedding.baseUrl,
    embeddingApiKey: embedding.apiKey,
    embeddingDimensions: embedding.dimensions,
    batchMaxLines: batch.maxLines,
    batchConcurrency: batch.concurrency,
    chunkingMaxLinesPerChunk: chunking.maxLinesPerChunk,
    chunkingMinLinesPerChunk: chunking.minLinesPerChunk,
    chunkingMinCharsPerChunk: chunking.minCharsPerChunk,
    chunkingOverlapLines: chunking.overlapLines,
    modelContextLength: chunking.modelContextLength,
    rerankingModelName: reranking.modelName,
    rerankingBaseUrl: reranking.baseUrl,
    rerankingApiKey: reranking.apiKey,
    rerankingContextLength: reranking.contextLength,
    rerankingTopN: reranking.topN,
    configJson: JSON.stringify({
      global: globalSettings ?? {},
      project: projectSettings ?? {},
    }),
    source: "snow-cli",
  });
  return await persistCodebaseSettings(native, config);
};
