import type { CodebaseSettingsInput } from "../../../../preload";
import { DEFAULT_CODEBASE_SETTINGS } from "./codebaseSettingsConstants";
import type { CodebaseSettingsForm } from "./types";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toText = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const toBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

const toPositiveInteger = (value: unknown, fallback: number): number => {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value ?? ""), 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const toNonNegativeInteger = (value: unknown, fallback: number): number => {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value ?? ""), 10);

  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

export const readCodebaseSettingsJson = (
  value: string | null
): CodebaseSettingsInput => {
  if (!value) {
    return normalizeCodebaseSettings(null);
  }

  try {
    return normalizeCodebaseSettings(JSON.parse(value));
  } catch {
    return normalizeCodebaseSettings(null);
  }
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
    chunkingOverlapLines: toNonNegativeInteger(
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

export const toCodebaseForm = (
  settings: CodebaseSettingsInput
): CodebaseSettingsForm => ({
  profileName: settings.profileName,
  embeddingType: settings.embeddingType,
  embeddingModelName: settings.embeddingModelName,
  embeddingBaseUrl: settings.embeddingBaseUrl,
  embeddingApiKey: settings.embeddingApiKey,
  embeddingDimensions: String(settings.embeddingDimensions),
  batchMaxLines: String(settings.batchMaxLines),
  batchConcurrency: String(settings.batchConcurrency),
  chunkingMaxLinesPerChunk: String(settings.chunkingMaxLinesPerChunk),
  chunkingMinLinesPerChunk: String(settings.chunkingMinLinesPerChunk),
  chunkingMinCharsPerChunk: String(settings.chunkingMinCharsPerChunk),
  chunkingOverlapLines: String(settings.chunkingOverlapLines),
  modelContextLength: String(settings.modelContextLength),
  rerankingModelName: settings.rerankingModelName,
  rerankingBaseUrl: settings.rerankingBaseUrl,
  rerankingApiKey: settings.rerankingApiKey,
  rerankingContextLength: String(settings.rerankingContextLength),
  rerankingTopN: String(settings.rerankingTopN),
});

export const toSnowCliCodebaseConfigJson = (
  settings: CodebaseSettingsInput
): string =>
  JSON.stringify({
    codebase: {
      embedding: {
        type: settings.embeddingType,
        modelName: settings.embeddingModelName,
        baseUrl: settings.embeddingBaseUrl,
        apiKey: settings.embeddingApiKey,
        dimensions: settings.embeddingDimensions,
      },
      batch: {
        maxLines: settings.batchMaxLines,
        concurrency: settings.batchConcurrency,
      },
      chunking: {
        maxLinesPerChunk: settings.chunkingMaxLinesPerChunk,
        minLinesPerChunk: settings.chunkingMinLinesPerChunk,
        minCharsPerChunk: settings.chunkingMinCharsPerChunk,
        overlapLines: settings.chunkingOverlapLines,
        modelContextLength: settings.modelContextLength,
      },
      reranking: {
        modelName: settings.rerankingModelName,
        baseUrl: settings.rerankingBaseUrl,
        apiKey: settings.rerankingApiKey,
        contextLength: settings.rerankingContextLength,
        topN: settings.rerankingTopN,
      },
    },
  });

export const toCodebaseSettings = (
  form: CodebaseSettingsForm
): CodebaseSettingsInput => {
  const settings = normalizeCodebaseSettings({
    ...form,
    source: "manual",
  });

  return {
    ...settings,
    configJson: toSnowCliCodebaseConfigJson(settings),
  };
};

export const maskSecret = (value: string): string => (value ? "********" : "-");
