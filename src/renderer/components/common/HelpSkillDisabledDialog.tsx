import { APP_CONTROL_OPEN_SETTINGS_EVENT } from "../../hooks/useAppControl";
import { useI18n } from "../../i18n";
import { ConfirmDialog } from "./ConfirmDialog";

type HelpSkillDisabledDialogProps = {
  open: boolean;
  onClose: () => void;
};

/** 使用指南依赖的 snow-app-docs 技能未开启时的提示框。 */
export const HelpSkillDisabledDialog = ({
  open,
  onClose,
}: HelpSkillDisabledDialogProps): React.JSX.Element => {
  const { t } = useI18n();

  const handleOpenSkillsSettings = (): void => {
    onClose();
    window.dispatchEvent(
      new CustomEvent(APP_CONTROL_OPEN_SETTINGS_EVENT, {
        detail: { view: "skills-settings" },
      }),
    );
  };

  return (
    <ConfirmDialog
      open={open}
      title={t("chatCommand.helpSkillDisabledTitle", {
        defaultValue: "Turn on the snow-app-docs skill",
      })}
      message={t("chatCommand.helpSkillDisabledMessage", {
        defaultValue:
          "The usage guide relies on the built-in snow-app-docs skill to read the docs. Turn it on in Skills settings first.",
      })}
      confirmLabel={t("chatCommand.helpSkillDisabledOpen", {
        defaultValue: "Open Skills settings",
      })}
      cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
      variant="warning"
      onConfirm={handleOpenSkillsSettings}
      onCancel={onClose}
    />
  );
};
