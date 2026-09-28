import { X } from "lucide-react";
import { useI18n } from "../../i18n";
import type { MainContentView } from "../mainContent/types";
import { useSettingsPageActions } from "./settingsPageActionsStore";

type SettingsPageTopBarActionsProps = {
  view: MainContentView;
  onClose: () => void;
};

export const SettingsPageTopBarActions = ({
  view,
  onClose,
}: SettingsPageTopBarActionsProps): React.JSX.Element => {
  const { t } = useI18n();
  const actions = useSettingsPageActions(view);
  const closeLabel = t("common.close", { defaultValue: "Close" });

  return (
    <>
      {actions.length > 0 && (
        <div className="top-bar-settings-actions">
          {actions.map((action) => {
            const Icon = action.icon;

            if (action.text) {
              return (
                <button
                  key={action.id}
                  className={`top-bar-settings-action${
                    action.danger ? " danger" : ""
                  }`}
                  type="button"
                  disabled={action.disabled}
                  aria-label={action.label}
                  title={action.label}
                  onClick={action.onClick}
                >
                  <Icon size={14} strokeWidth={1.8} />
                  <span>{action.text}</span>
                </button>
              );
            }

            return (
              <button
                key={action.id}
                className="icon-btn ghost"
                type="button"
                disabled={action.disabled}
                aria-label={action.label}
                title={action.label}
                onClick={action.onClick}
              >
                <Icon
                  className={action.spinning ? "spin" : undefined}
                  size={15}
                  strokeWidth={1.8}
                />
              </button>
            );
          })}
        </div>
      )}
      <button
        className="icon-btn ghost feature-page-close-btn"
        type="button"
        aria-label={closeLabel}
        title={closeLabel}
        onClick={onClose}
      >
        <X size={16} strokeWidth={1.8} />
      </button>
    </>
  );
};
