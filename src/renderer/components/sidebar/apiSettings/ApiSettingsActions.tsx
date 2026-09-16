import { Download, Loader2, Plus, X } from "lucide-react";
import { useI18n } from "../../../i18n";

type ApiSettingsActionsProps = {
  isBusy: boolean;
  isLoading: boolean;
  isImporting: boolean;
  showAddForm: boolean;
  onImport: () => void;
  onImportFile: () => void;
  onToggleAddForm: () => void;
};

export function ApiSettingsActions({
  isBusy,
  isLoading,
  isImporting,
  showAddForm,
  onImport,
  onImportFile,
  onToggleAddForm,
}: ApiSettingsActionsProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="api-settings-actions api-settings-actions-trio">
      <button
        className="api-settings-action-btn primary"
        onClick={onImport}
        type="button"
        disabled={isBusy}
      >
        {isLoading ? (
          <Loader2 size={15} className="spin" />
        ) : (
          <Download size={15} />
        )}
        <span>
          {t("settings.importFromSnowCli", {
            defaultValue: "Sync Snow CLI API config",
          })}
        </span>
      </button>
      <button
        className="api-settings-action-btn secondary"
        onClick={onToggleAddForm}
        type="button"
        disabled={isBusy}
      >
        {showAddForm ? <X size={15} /> : <Plus size={15} />}
        <span>
          {showAddForm
            ? t("settings.cancelManualApiConfig", {
                defaultValue: "Cancel manual add",
              })
            : t("settings.addManualApiConfig", {
                defaultValue: "Add manually",
              })}
        </span>
      </button>
      <button
        className="api-settings-action-btn secondary"
        onClick={onImportFile}
        type="button"
        disabled={isBusy}
        title={t("settings.apiImportFile", { defaultValue: "Import config" })}
      >
        {isImporting ? (
          <Loader2 size={15} className="spin" />
        ) : (
          <Download size={15} />
        )}
        <span>
          {t("settings.apiImportFile", { defaultValue: "Import config" })}
        </span>
      </button>
    </div>
  );
}
