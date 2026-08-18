import {
  AlertCircle,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Keyboard,
  Loader2,
  RefreshCw,
  Search,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { RefObject } from "react";
import { useI18n } from "../../../i18n";
import { ThinkingStrengthMenu } from "./ThinkingStrengthMenu";
import { useDropdownDirection } from "./useDropdownDirection";
import type { ChatInputActions, ChatInputState } from "./types";

type ModelSelectorProps = Pick<
  ChatInputState,
  | "apiConfigs"
  | "selectedApiProfile"
  | "modelMenuView"
  | "isSubAgentConversation"
  | "models"
  | "selectedModel"
  | "displayModel"
  | "isLoadingModels"
  | "modelError"
  | "isModelMenuOpen"
  | "isManualMode"
  | "manualValue"
  | "runtimeApiConfig"
  | "requestMethod"
  | "thinkingOptions"
  | "thinkingValue"
  | "thinkingLabel"
  | "ActiveThinkingIcon"
  | "isLoadingApiConfig"
  | "isSavingThinking"
  | "thinkingError"
  | "responsesFastModeEnabled"
  | "isSavingFastMode"
  | "fastModeError"
  | "labels"
  | "isStreaming"
> &
  Pick<
    ChatInputActions,
    | "setManualValue"
    | "setIsManualMode"
    | "setModelMenuView"
    | "handleSelectModel"
    | "handleOpenManualMode"
    | "handleConfirmManualModel"
    | "handleManualKeyDown"
    | "handleRetryFetchModels"
    | "handleToggleModelMenu"
    | "handleSelectApiProfile"
    | "handleSelectThinking"
    | "handleToggleResponsesFastMode"
  > & {
    dropdownRef: RefObject<HTMLDivElement | null>;
  };

export const ModelSelector = ({
  apiConfigs,
  selectedApiProfile,
  modelMenuView,
  isSubAgentConversation,
  models,
  selectedModel,
  displayModel,
  isLoadingModels,
  modelError,
  isModelMenuOpen,
  isManualMode,
  manualValue,
  runtimeApiConfig,
  requestMethod,
  thinkingOptions,
  thinkingValue,
  thinkingLabel,
  ActiveThinkingIcon,
  isLoadingApiConfig,
  isSavingThinking,
  thinkingError,
  responsesFastModeEnabled,
  isSavingFastMode,
  fastModeError,
  labels,
  isStreaming,
  dropdownRef,
  setManualValue,
  setIsManualMode,
  setModelMenuView,
  handleSelectModel,
  handleOpenManualMode,
  handleConfirmManualModel,
  handleManualKeyDown,
  handleRetryFetchModels,
  handleToggleModelMenu,
  handleSelectApiProfile,
  handleSelectThinking,
  handleToggleResponsesFastMode,
}: ModelSelectorProps): React.JSX.Element => {
  const { t } = useI18n();
  const [modelSearchQuery, setModelSearchQuery] = useState("");
  const [apiProfileSearchQuery, setApiProfileSearchQuery] = useState("");
  const modelDropdownDir = useDropdownDirection(dropdownRef, isModelMenuOpen);

  useEffect(() => {
    if (!isModelMenuOpen || modelMenuView !== "model") {
      setModelSearchQuery("");
    }
    if (!isModelMenuOpen || modelMenuView !== "apiProfile") {
      setApiProfileSearchQuery("");
    }
  }, [isModelMenuOpen, modelMenuView]);

  const filteredModels = useMemo(() => {
    const query = modelSearchQuery.trim().toLowerCase();
    if (!query) {
      return models;
    }
    return models.filter(
      (model) =>
        model.id.toLowerCase().includes(query) ||
        model.ownedBy.toLowerCase().includes(query)
    );
  }, [models, modelSearchQuery]);

  const filteredApiConfigs = useMemo(() => {
    const query = apiProfileSearchQuery.trim().toLowerCase();
    if (!query) {
      return apiConfigs;
    }
    return apiConfigs.filter(
      (config) =>
        config.displayName.toLowerCase().includes(query) ||
        config.profileName.toLowerCase().includes(query) ||
        (config.advancedModel || "").toLowerCase().includes(query) ||
        (config.basicModel || "").toLowerCase().includes(query)
    );
  }, [apiConfigs, apiProfileSearchQuery]);

  return (
    <div className="model-selector" ref={dropdownRef}>
      <button
        className={`toolbar-btn model ${modelError ? "model-error" : ""}${
          isStreaming || isSubAgentConversation ? " is-disabled" : ""
        }`}
        aria-label={labels.selectModel}
        aria-expanded={isModelMenuOpen}
        onClick={handleToggleModelMenu}
        disabled={
          isStreaming ||
          isSubAgentConversation ||
          apiConfigs.length === 0 ||
          !runtimeApiConfig
        }
        title={
          isSubAgentConversation
            ? t("chat.subAgentModelFixed")
            : apiConfigs.length === 0 || !runtimeApiConfig
              ? labels.noApiConfig
              : labels.selectModel
        }
        type="button"
      >
        {modelError ? (
          <AlertCircle size={14} className="model-icon" />
        ) : (
          <Bot size={14} className="model-icon" />
        )}
        <span className="model-name" title={displayModel}>
          {displayModel}
        </span>
        <span
          className="model-trigger-thinking"
          title={
            thinkingError ??
            (isLoadingApiConfig
              ? t("chat.loadingApiConfig")
              : t("chat.thinkingStrengthWithValue", {
                  values: { value: thinkingLabel },
                }))
          }
        >
          {isLoadingApiConfig || isSavingThinking ? (
            <Loader2 size={12} className="spin" />
          ) : thinkingError ? (
            <AlertCircle size={12} />
          ) : (
            <ActiveThinkingIcon size={12} />
          )}
          <span className="model-trigger-thinking-label">{thinkingLabel}</span>
        </span>
        {requestMethod === "responses" && responsesFastModeEnabled && (
          <span
            className="model-trigger-fast"
            title={fastModeError ?? t("chat.fastModeEnabled")}
          >
            {isSavingFastMode ? (
              <Loader2 size={12} className="spin" />
            ) : (
              <Zap size={12} />
            )}
            <span>Fast</span>
          </span>
        )}
        <ChevronDown size={12} />
      </button>
      {isModelMenuOpen && (
        <div className={`model-dropdown drop-${modelDropdownDir}`}>
          {modelMenuView === "root" && (
            <div className="model-dropdown-list">
              <button
                className="model-dropdown-item"
                onClick={() => setModelMenuView("model")}
                type="button"
              >
                <span className="model-dropdown-item-name">
                  {t("chat.model")}
                </span>
                <span className="model-menu-value">
                  <span
                    className="model-menu-value-text"
                    title={displayModel}
                  >
                    {displayModel}
                  </span>
                  <ChevronRight size={12} />
                </span>
              </button>
              <button
                className="model-dropdown-item"
                disabled={
                  !runtimeApiConfig || isLoadingApiConfig || isSavingThinking
                }
                onClick={() => setModelMenuView("thinking")}
                type="button"
              >
                <span className="model-dropdown-item-name">
                  {t("chat.thinkingStrength")}
                </span>
                <span className="model-menu-value">
                  {isSavingThinking ? (
                    <Loader2 size={12} className="spin" />
                  ) : (
                    <span className="model-menu-value-text">
                      {thinkingLabel}
                    </span>
                  )}
                  <ChevronRight size={12} />
                </span>
              </button>
              {requestMethod === "responses" && (
                <button
                  className={`model-dropdown-item model-fast-mode-toggle ${
                    responsesFastModeEnabled ? "active" : ""
                  }`}
                  role="switch"
                  aria-checked={responsesFastModeEnabled}
                  disabled={
                    !runtimeApiConfig ||
                    isLoadingApiConfig ||
                    isSavingFastMode ||
                    isStreaming ||
                    isSubAgentConversation
                  }
                  onClick={() => void handleToggleResponsesFastMode()}
                  type="button"
                  title={fastModeError ?? t("chat.fastModeHint")}
                >
                  <span className="model-dropdown-item-name with-icon">
                    <Zap size={14} className="thinking-option-icon" />
                    <span>{t("chat.fastMode")}</span>
                  </span>
                  <span className="model-menu-value">
                    {isSavingFastMode ? (
                      <Loader2 size={12} className="spin" />
                    ) : (
                      <span className="model-menu-value-text">
                        {t(
                          responsesFastModeEnabled
                            ? "chat.fastModeOn"
                            : "chat.fastModeOff"
                        )}
                      </span>
                    )}
                  </span>
                </button>
              )}
              {!isSubAgentConversation && apiConfigs.length > 0 && (
                <button
                  className="model-dropdown-item"
                  onClick={() => setModelMenuView("apiProfile")}
                  type="button"
                >
                  <span className="model-dropdown-item-name">
                    {labels.selectApiProfile}
                  </span>
                  <span className="model-menu-value">
                    <span
                      className="model-menu-value-text"
                      title={runtimeApiConfig?.displayName}
                    >
                      {runtimeApiConfig?.displayName || labels.selectApiProfile}
                    </span>
                    <ChevronRight size={12} />
                  </span>
                </button>
              )}
            </div>
          )}
          {modelMenuView === "apiProfile" && (
            <>
              <div className="model-menu-header">
                <button
                  aria-label={t("common.back")}
                  className="model-menu-back"
                  onClick={() => setModelMenuView("root")}
                  type="button"
                >
                  <ChevronLeft size={14} />
                </button>
                <span>{labels.selectApiProfile}</span>
              </div>
              <div className="model-dropdown-search">
                <Search size={13} className="model-dropdown-search-icon" />
                <input
                  autoFocus
                  className="model-dropdown-search-input"
                  type="text"
                  value={apiProfileSearchQuery}
                  onChange={(event) =>
                    setApiProfileSearchQuery(event.target.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setApiProfileSearchQuery("");
                    }
                  }}
                  placeholder={labels.searchApiProfiles}
                />
                {apiProfileSearchQuery && (
                  <button
                    className="model-dropdown-search-clear"
                    type="button"
                    aria-label={labels.searchApiProfiles}
                    onClick={() => setApiProfileSearchQuery("")}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
              <div className="model-dropdown-list">
                {apiConfigs.length > 0 && filteredApiConfigs.length === 0 && (
                  <div className="model-dropdown-empty">
                    {labels.noMatchingApiProfiles}
                  </div>
                )}
                {filteredApiConfigs.map((config) => (
                  <button
                    key={config.profileName}
                    className={`model-dropdown-item ${
                      config.profileName === selectedApiProfile ? "active" : ""
                    }`}
                    onClick={() => {
                      void handleSelectApiProfile(config.profileName);
                    }}
                    type="button"
                    title={config.displayName}
                  >
                    <span className="model-dropdown-item-name">
                      {config.displayName}
                    </span>
                    <span className="model-dropdown-item-model">
                      {config.advancedModel || config.basicModel || "-"}
                    </span>
                    {config.profileName === selectedApiProfile && (
                      <Check size={14} className="model-dropdown-check" />
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
          {modelMenuView === "model" &&
            (isManualMode ? (
              <>
                <div className="model-menu-header">
                  <button
                    aria-label={t("common.back")}
                    className="model-menu-back"
                    onClick={() => setModelMenuView("root")}
                    type="button"
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <span>{labels.manualModel}</span>
                </div>
                <div className="model-manual-input">
                  <input
                    autoFocus
                    value={manualValue}
                    onChange={(event) => setManualValue(event.target.value)}
                    onKeyDown={handleManualKeyDown}
                    placeholder={labels.manualModelPlaceholder}
                    className="model-manual-field"
                  />
                  <div className="model-manual-actions">
                    <button
                      className="model-manual-btn secondary"
                      onClick={() => setIsManualMode(false)}
                      type="button"
                    >
                      {labels.cancel}
                    </button>
                    <button
                      className="model-manual-btn primary"
                      onClick={() => void handleConfirmManualModel()}
                      disabled={!manualValue.trim()}
                      type="button"
                    >
                      {labels.confirm}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="model-menu-header">
                  <button
                    aria-label={t("common.back")}
                    className="model-menu-back"
                    onClick={() => setModelMenuView("root")}
                    type="button"
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <span>{labels.selectModel}</span>
                </div>
                {isLoadingModels && (
                  <div className="model-dropdown-status" aria-live="polite">
                    <Loader2 size={14} className="spin" />
                    <span>{labels.loadingModels}</span>
                  </div>
                )}
                {modelError && (
                  <div className="model-dropdown-error">
                    <AlertCircle size={14} />
                    <span>{modelError}</span>
                    <button
                      className="model-dropdown-retry"
                      onClick={() => void handleRetryFetchModels()}
                      disabled={isLoadingModels}
                      type="button"
                    >
                      {labels.retry}
                    </button>
                  </div>
                )}
                <div className="model-dropdown-search">
                  <Search size={13} className="model-dropdown-search-icon" />
                  <input
                    autoFocus
                    className="model-dropdown-search-input"
                    type="text"
                    value={modelSearchQuery}
                    onChange={(event) => setModelSearchQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        setModelSearchQuery("");
                      }
                    }}
                    placeholder={labels.searchModels}
                  />
                  {modelSearchQuery && (
                    <button
                      className="model-dropdown-search-clear"
                      type="button"
                      aria-label={labels.searchModels}
                      onClick={() => setModelSearchQuery("")}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
                <div className="model-dropdown-list">
                  {models.length === 0 &&
                    !modelError &&
                    !isLoadingModels && (
                      <div className="model-dropdown-empty">
                        {labels.noModelsFound}
                      </div>
                    )}
                  {models.length > 0 && filteredModels.length === 0 && (
                    <div className="model-dropdown-empty">
                      {labels.noMatchingModels}
                    </div>
                  )}
                  {filteredModels.map((model) => (
                    <button
                      key={model.id}
                      className={`model-dropdown-item ${
                        selectedModel === model.id ? "active" : ""
                      }`}
                      onClick={() => void handleSelectModel(model.id)}
                      type="button"
                      title={model.id}
                    >
                      <span className="model-dropdown-item-name">
                        {model.id}
                      </span>
                      {selectedModel === model.id && (
                        <Check size={14} className="model-dropdown-check" />
                      )}
                    </button>
                  ))}
                </div>
                <div className="model-dropdown-footer model-dropdown-footer-actions">
                  <button
                    className="model-dropdown-action"
                    onClick={() => void handleRetryFetchModels()}
                    disabled={isLoadingModels}
                    title={labels.refreshModels}
                    type="button"
                  >
                    <RefreshCw size={14} />
                    <span>{labels.refreshModels}</span>
                  </button>
                  <button
                    className="model-dropdown-action"
                    onClick={handleOpenManualMode}
                    type="button"
                  >
                    <Keyboard size={14} />
                    <span>{labels.manualModel}</span>
                  </button>
                </div>
              </>
            ))}
          {modelMenuView === "thinking" && (
            <ThinkingStrengthMenu
              open={isModelMenuOpen}
              value={thinkingValue}
              options={thinkingOptions}
              subtitle={requestMethod}
              showBack
              onBack={() => setModelMenuView("root")}
              onSelect={(value) => void handleSelectThinking(value)}
              saving={isSavingThinking}
            />
          )}
        </div>
      )}
    </div>
  );
};
