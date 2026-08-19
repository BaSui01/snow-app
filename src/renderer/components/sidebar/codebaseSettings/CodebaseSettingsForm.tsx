import { RotateCcw } from "lucide-react";
import { type ChangeEvent } from "react";
import { useI18n } from "../../../i18n";
import { CustomSelect } from "../../common/CustomSelect";
import { EMBEDDING_TYPE_OPTIONS } from "./codebaseSettingsConstants";
import { maskSecret } from "./codebaseSettingsUtils";
import type { CodebaseSettingsForm as CodebaseSettingsFormValue } from "./types";

type CodebaseSettingsFormProps = {
  form: CodebaseSettingsFormValue;
  isBusy: boolean;
  onUpdateField: (
    field: keyof CodebaseSettingsFormValue
  ) => (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;
  onSetValue: (field: keyof CodebaseSettingsFormValue, value: string) => void;
  onBlurSave: () => void;
  onReset: () => void;
};

export function CodebaseSettingsForm({
  form,
  isBusy,
  onUpdateField,
  onSetValue,
  onBlurSave,
  onReset,
}: CodebaseSettingsFormProps): React.JSX.Element {
  const { t } = useI18n();

  const renderTextInput = (
    field: keyof CodebaseSettingsFormValue,
    label: string,
    placeholder = "",
    type: "text" | "password" | "number" = "text",
    min?: number
  ) => (
    <label className="api-settings-field">
      <span>{label}</span>
      <input
        value={String(form[field])}
        onChange={onUpdateField(field)}
        onBlur={() => onBlurSave()}
        placeholder={placeholder}
        type={type}
        min={min}
        disabled={isBusy}
      />
    </label>
  );

  return (
    <div className="api-settings-manual-form">
      <div className="api-settings-manual-header">
        <strong>
          {t("settings.codebaseManualTitle", {
            defaultValue: "Manual configuration",
          })}
        </strong>
        <span>
          {t("settings.codebaseManualInfo", {
            defaultValue:
              "These values are saved in the local app database and can be synced from Snow CLI settings.json files.",
          })}
        </span>
      </div>

      <div className="api-settings-form-body">
        <div className="api-settings-form-section">
          <strong className="api-settings-form-section-title">
            {t("settings.codebaseEmbeddingSettings", {
              defaultValue: "Embedding settings",
            })}
          </strong>
          <div className="api-settings-form-grid">
            <label className="api-settings-field">
              <span>
                {t("settings.codebaseEmbeddingType", {
                  defaultValue: "Embedding type",
                })}
              </span>
              <CustomSelect
                value={form.embeddingType}
                options={EMBEDDING_TYPE_OPTIONS}
                onChange={(value) => {
                  onSetValue("embeddingType", value);
                  onBlurSave();
                }}
                disabled={isBusy}
              />
            </label>
            {renderTextInput(
              "embeddingModelName",
              t("settings.codebaseEmbeddingModelName", {
                defaultValue: "Embedding model name",
              }),
              "jina-embeddings-v3"
            )}
            {renderTextInput(
              "embeddingBaseUrl",
              t("settings.codebaseEmbeddingBaseUrl", {
                defaultValue: "Embedding base URL",
              }),
              "https://api.jina.ai/v1/embeddings"
            )}
            {renderTextInput(
              "embeddingDimensions",
              t("settings.codebaseEmbeddingDimensions", {
                defaultValue: "Embedding dimensions",
              }),
              "1536",
              "number",
              1
            )}
            {renderTextInput(
              "embeddingApiKey",
              t("settings.codebaseEmbeddingApiKey", {
                defaultValue: "Embedding API key",
              }),
              maskSecret(form.embeddingApiKey),
              "password"
            )}
            {renderTextInput(
              "modelContextLength",
              t("settings.codebaseModelContextLength", {
                defaultValue: "Model context length (tokens)",
              }),
              "8192",
              "number",
              1
            )}
          </div>
        </div>

        <div className="api-settings-form-section">
          <strong className="api-settings-form-section-title">
            {t("settings.codebaseRerankingSettings", {
              defaultValue: "Reranking settings",
            })}
          </strong>
          <div className="api-settings-form-grid">
            {renderTextInput(
              "rerankingModelName",
              t("settings.codebaseRerankingModelName", {
                defaultValue: "Reranking model name",
              }),
              "jina-reranker-v2-base-multilingual"
            )}
            {renderTextInput(
              "rerankingBaseUrl",
              t("settings.codebaseRerankingBaseUrl", {
                defaultValue: "Reranking base URL",
              }),
              "https://api.jina.ai/v1/rerank"
            )}
            {renderTextInput(
              "rerankingContextLength",
              t("settings.codebaseRerankingContextLength", {
                defaultValue: "Reranking context length",
              }),
              "4096",
              "number",
              1
            )}
            {renderTextInput(
              "rerankingTopN",
              t("settings.codebaseRerankingTopN", {
                defaultValue: "Reranking top N",
              }),
              "5",
              "number",
              1
            )}
            {renderTextInput(
              "rerankingApiKey",
              t("settings.codebaseRerankingApiKey", {
                defaultValue: "Reranking API key",
              }),
              maskSecret(form.rerankingApiKey),
              "password"
            )}
          </div>
        </div>

        <div className="api-settings-form-section">
          <strong className="api-settings-form-section-title">
            {t("settings.codebaseBatchChunkingSettings", {
              defaultValue: "Batch and chunking",
            })}
          </strong>
          <div className="api-settings-form-grid">
            {renderTextInput(
              "batchMaxLines",
              t("settings.codebaseBatchMaxLines", {
                defaultValue: "Batch max lines",
              }),
              "10",
              "number",
              1
            )}
            {renderTextInput(
              "batchConcurrency",
              t("settings.codebaseBatchConcurrency", {
                defaultValue: "Batch concurrency",
              }),
              "3",
              "number",
              1
            )}
            {renderTextInput(
              "chunkingMaxLinesPerChunk",
              t("settings.codebaseChunkingMaxLinesPerChunk", {
                defaultValue: "Max lines per chunk",
              }),
              "200",
              "number",
              1
            )}
            {renderTextInput(
              "chunkingMinLinesPerChunk",
              t("settings.codebaseChunkingMinLinesPerChunk", {
                defaultValue: "Min lines per chunk",
              }),
              "10",
              "number",
              1
            )}
            {renderTextInput(
              "chunkingMinCharsPerChunk",
              t("settings.codebaseChunkingMinCharsPerChunk", {
                defaultValue: "Min chars per chunk",
              }),
              "20",
              "number",
              1
            )}
            {renderTextInput(
              "chunkingOverlapLines",
              t("settings.codebaseChunkingOverlapLines", {
                defaultValue: "Overlap lines",
              }),
              "20",
              "number",
              0
            )}
          </div>
        </div>
      </div>

      <div className="api-settings-form-actions">
        <button
          className="api-settings-form-btn secondary"
          onClick={onReset}
          type="button"
          disabled={isBusy}
        >
          <RotateCcw size={15} strokeWidth={1.9} />
          <span>{t("settings.reset", { defaultValue: "Reset" })}</span>
        </button>
      </div>
    </div>
  );
}
