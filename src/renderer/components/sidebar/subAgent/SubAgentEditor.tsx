import { AlertCircle, Loader2, Save, Wrench, X } from "lucide-react";
import type { ApiConfigRecord, Model } from "../../../../preload";
import { CustomSelect } from "../../common/CustomSelect";
import { useI18n } from "../../../i18n";
import { usesAllTools } from "./subAgentUtils";
import type { SubAgentDraft, SubAgentToolOption } from "./types";

type SubAgentEditorProps = {
  apiConfigs: ApiConfigRecord[];
  draft: SubAgentDraft;
  isBusy: boolean;
  isSaving: boolean;
  isToolCatalogLoading: boolean;
  isModelCatalogLoading: boolean;
  modelCatalogError: string;
  modelOptions: Model[];
  /** 全局 Tab 的工具候选与项目无关；项目 Tab 仅列出当前项目已启用的工具。 */
  isGlobalScope: boolean;
  toolCatalogError: string;
  toolOptions: SubAgentToolOption[];
  onDraftChange: (patch: Partial<SubAgentDraft>) => void;
  onCancel: () => void;
  onSave: () => void;
};

export function SubAgentEditor({
  apiConfigs,
  draft,
  isBusy,
  isSaving,
  isToolCatalogLoading,
  isModelCatalogLoading,
  modelCatalogError,
  modelOptions,
  isGlobalScope,
  toolCatalogError,
  toolOptions,
  onDraftChange,
  onCancel,
  onSave,
}: SubAgentEditorProps): React.JSX.Element {
  const { t } = useI18n();
  const allToolsEnabled = usesAllTools(draft.toolNames);
  const unavailableToolNames = allToolsEnabled
    ? []
    : draft.toolNames.filter(
        (toolName) => !toolOptions.some((tool) => tool.name === toolName),
      );
  const apiProfileOptions = [
    {
      value: "",
      label: t("settings.subAgentFollowActiveApiProfile", {
        defaultValue: "Follow the parent conversation (recommended)",
      }),
    },
    ...(draft.configProfile &&
    !apiConfigs.some((config) => config.profileName === draft.configProfile)
      ? [
          {
            value: draft.configProfile,
            label: `${draft.configProfile} · ${t(
              "settings.subAgentApiProfileUnavailable",
              { defaultValue: "No longer available" },
            )}`,
          },
        ]
      : []),
    ...apiConfigs.map((config) => ({
      value: config.profileName,
      label: `${config.displayName || config.profileName} · ${
        config.advancedModel
      }`,
    })),
  ];

  const selectedApiConfig = apiConfigs.find(
    (config) => config.profileName === draft.configProfile,
  );
  const availableModelIds = Array.from(
    new Set(
      [
        selectedApiConfig?.advancedModel,
        draft.model,
        ...modelOptions.map((model) => model.id),
      ].filter((modelId): modelId is string => Boolean(modelId?.trim())),
    ),
  );
  const fixedModelOptions = [
    {
      value: "",
      label: t("settings.subAgentUseProfileAdvancedModel", {
        defaultValue: "Use the API profile's advanced model",
      }),
    },
    ...availableModelIds.map((modelId) => ({
      value: modelId,
      label: modelId,
    })),
  ];

  const toggleTool = (toolName: string): void => {
    const selected = new Set(
      allToolsEnabled ? toolOptions.map((tool) => tool.name) : draft.toolNames,
    );
    if (selected.has(toolName)) {
      selected.delete(toolName);
    } else {
      selected.add(toolName);
    }
    onDraftChange({ toolNames: Array.from(selected) });
  };

  return (
    <form
      id="sub-agent-editor-form"
      className="api-settings-form-section sub-agent-editor-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <div className="api-settings-form-grid">
        <label className="api-settings-field">
          <span>{t("settings.subAgentName", { defaultValue: "Name" })}</span>
          <input
            value={draft.name}
            maxLength={100}
            onChange={(event) => onDraftChange({ name: event.target.value })}
            placeholder={t("settings.subAgentNamePlaceholder", {
              defaultValue: "e.g. Code reviewer",
            })}
            disabled={isBusy}
          />
        </label>
        <label className="api-settings-field">
          <span>
            {t("settings.subAgentConfigProfile", {
              defaultValue: "API and model",
            })}
          </span>
          <CustomSelect
            value={draft.configProfile}
            options={apiProfileOptions}
            onChange={(value) =>
              onDraftChange({ configProfile: value, model: "" })
            }
            disabled={isBusy}
          />
          {apiConfigs.length === 0 ? (
            <small className="sub-agent-field-hint">
              {t("settings.subAgentApiProfileEmpty", {
                defaultValue:
                  "No API profiles are configured. Configure one before starting a sub-agent.",
              })}
            </small>
          ) : null}
          <small className="sub-agent-field-hint">
            {t("settings.subAgentApiProfileHint", {
              defaultValue:
                "By default, the sub-agent inherits the parent conversation's API profile and model. Selecting a profile pins the API connection and lets you optionally pin a model.",
            })}
          </small>
        </label>
        {draft.configProfile ? (
          <label className="api-settings-field">
            <span>
              {t("settings.subAgentModel", { defaultValue: "Model" })}
            </span>
            <CustomSelect
              value={draft.model}
              options={fixedModelOptions}
              onChange={(value) => onDraftChange({ model: value })}
              disabled={isBusy || isModelCatalogLoading}
            />
            {isModelCatalogLoading ? (
              <small className="sub-agent-field-hint">
                {t("settings.subAgentModelsLoading", {
                  defaultValue: "Loading models...",
                })}
              </small>
            ) : null}
            {modelCatalogError ? (
              <small className="sub-agent-field-hint">
                {t("settings.subAgentModelsLoadFallback", {
                  defaultValue:
                    "Model loading failed. The saved model and the profile's advanced model remain available.",
                })}
              </small>
            ) : null}
            <small className="sub-agent-field-hint">
              {t("settings.subAgentModelHint", {
                defaultValue:
                  "Leave this unset to use the selected profile's advanced model.",
              })}
            </small>
          </label>
        ) : null}
        <label className="api-settings-field wide">
          <span>
            {t("settings.subAgentDescription", { defaultValue: "Description" })}
          </span>
          <textarea
            className="system-prompt-textarea sub-agent-description-textarea"
            value={draft.description}
            maxLength={500}
            onChange={(event) =>
              onDraftChange({ description: event.target.value })
            }
            placeholder={t("settings.subAgentDescriptionPlaceholder", {
              defaultValue: "Describe when this sub-agent should be used.",
            })}
            disabled={isBusy}
          />
        </label>
        <label className="api-settings-field wide">
          <span>
            {t("settings.subAgentSystemPrompt", {
              defaultValue: "Sub-agent system prompt",
            })}
          </span>
          <textarea
            className="system-prompt-textarea sub-agent-prompt-textarea"
            value={draft.systemPrompt}
            onChange={(event) =>
              onDraftChange({ systemPrompt: event.target.value })
            }
            placeholder={t("settings.subAgentSystemPromptPlaceholder", {
              defaultValue: "Define this sub-agent's role and execution rules.",
            })}
            disabled={isBusy}
          />
        </label>
        <div className="api-settings-field wide sub-agent-tools-field">
          <span>
            {t("settings.subAgentTools", { defaultValue: "MCP tools" })}
          </span>
          {isToolCatalogLoading ? (
            <div className="sub-agent-tool-state">
              <Loader2 className="spin" size={15} />
              <span>
                {t("settings.subAgentToolsLoading", {
                  defaultValue: "Loading MCP tools...",
                })}
              </span>
            </div>
          ) : toolCatalogError ? (
            <div className="sub-agent-tool-state is-error">
              <AlertCircle size={15} />
              <span>{toolCatalogError}</span>
            </div>
          ) : toolOptions.length === 0 ? (
            <div className="sub-agent-tool-state">
              <span>
                {t("settings.subAgentToolsEmpty", {
                  defaultValue: "No enabled MCP tools are available.",
                })}
              </span>
            </div>
          ) : (
            <div className="sub-agent-tool-options">
              {toolOptions.map((tool) => (
                <label
                  className="sub-agent-tool-option toggle-switch"
                  key={tool.name}
                >
                  <input
                    type="checkbox"
                    checked={
                      allToolsEnabled || draft.toolNames.includes(tool.name)
                    }
                    disabled={isBusy}
                    onChange={() => toggleTool(tool.name)}
                  />
                  <span className="toggle-slider" />
                  <Wrench size={14} />
                  <span className="sub-agent-tool-option-content">
                    <strong>{tool.name}</strong>
                    <small>
                      {tool.serverName}
                      {tool.description ? ` · ${tool.description}` : ""}
                    </small>
                  </span>
                </label>
              ))}
            </div>
          )}
          {!isToolCatalogLoading && unavailableToolNames.length > 0 ? (
            <div className="sub-agent-tool-state is-error">
              <AlertCircle size={15} />
              <span>
                {t("settings.subAgentToolsUnavailable", {
                  defaultValue: "Some saved MCP tools are unavailable.",
                })}{" "}
                {unavailableToolNames.join(", ")}
              </span>
            </div>
          ) : null}
          <small className="sub-agent-field-hint">
            {isGlobalScope
              ? t("settings.subAgentToolsGlobalHint", {
                  defaultValue:
                    "Lists only system and global MCP server tools, independent of projects. When run in a project that disables a server, its tools are skipped.",
                })
              : t("settings.subAgentToolsHint", {
                  defaultValue:
                    "Only tools enabled for the current project are available. You may select multiple tools.",
                })}
          </small>
        </div>
      </div>
    </form>
  );
}

type SubAgentEditorActionsProps = {
  isBusy: boolean;
  isSaving: boolean;
  onCancel: () => void;
};

export function SubAgentEditorActions({
  isBusy,
  isSaving,
  onCancel,
}: SubAgentEditorActionsProps): React.JSX.Element {
  const { t } = useI18n();
  return (
    <>
      <button
        className="api-settings-form-btn secondary"
        onClick={onCancel}
        type="button"
        disabled={isBusy}
      >
        <X size={14} />
        <span>{t("settings.cancel", { defaultValue: "Cancel" })}</span>
      </button>
      <button
        className="api-settings-form-btn primary"
        type="submit"
        form="sub-agent-editor-form"
        disabled={isBusy}
      >
        {isSaving ? <Loader2 size={14} className="spin" /> : <Save size={14} />}
        <span>{t("settings.save", { defaultValue: "Save" })}</span>
      </button>
    </>
  );
}
