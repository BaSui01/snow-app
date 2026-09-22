import { X } from "lucide-react";
import type { WorkspaceDirectoryRecord } from "../../../preload";
import { useI18n } from "../../i18n";
import { CustomCommandsManager } from "./customCommands/CustomCommandsManager";

type CustomCommandsSettingsPanelProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
  onClose?: () => void;
};

export function CustomCommandsSettingsPanel({
  activeDirectory,
  onClose,
}: CustomCommandsSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="api-settings-page" role="region">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>
            {t("settings.customCommandsTitle", {
              defaultValue: "Custom commands",
            })}
          </strong>
          <span className="settings-item-description">
            {t("settings.customCommandsSettingsInfo", {
              defaultValue:
                "Define slash commands that send a prompt to the AI or run a shell command.",
            })}
          </span>
        </div>
        {onClose && (
          <button
            aria-label={t("settings.closeCustomCommandsSettings", {
              defaultValue: "Close custom commands settings",
            })}
            className="icon-btn ghost"
            onClick={onClose}
            title={t("settings.closeCustomCommandsSettings", {
              defaultValue: "Close custom commands settings",
            })}
            type="button"
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        )}
      </div>

      <CustomCommandsManager
        projectId={activeDirectory?.directoryId}
        projectName={activeDirectory?.name}
      />
    </div>
  );
}
