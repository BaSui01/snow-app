import { useEffect, useState } from "react";
import type { SubAgentExecutionMode } from "../../../../shared/subAgentRuns";
import { useI18n } from "../../../i18n";
import { CustomSelect } from "../../common/CustomSelect";
import {
  loadSubAgentExecutionMode,
  saveSubAgentExecutionMode,
} from "../../mainContent/chatMessages/hooks/subAgentExecutionMode";

type Props = {
  onStatus: (message: string) => void;
  onError: (message: string) => void;
};

export function SubAgentExecutionModeControl({
  onStatus,
  onError,
}: Props): React.JSX.Element {
  const { t } = useI18n();
  const [mode, setMode] = useState<SubAgentExecutionMode>("sync");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void loadSubAgentExecutionMode()
      .then((value) => {
        if (active) setMode(value);
      })
      .catch(() => {
        if (active) onError(t("settings.subAgentExecutionModeLoadError"));
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [onError, t]);

  const save = async (value: string): Promise<void> => {
    if (value !== "sync" && value !== "async") return;
    setIsSaving(true);
    onError("");
    onStatus("");
    try {
      await saveSubAgentExecutionMode(value);
      setMode(value);
      onStatus(t("settings.subAgentExecutionModeSaved"));
    } catch {
      onError(t("settings.subAgentExecutionModeSaveError"));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="api-settings-field">
      <span>{t("settings.subAgentExecutionModeLabel")}</span>
      <CustomSelect
        value={mode}
        options={[
          { value: "sync", label: t("settings.subAgentExecutionModeSync") },
          { value: "async", label: t("settings.subAgentExecutionModeAsync") },
        ]}
        ariaLabel={t("settings.subAgentExecutionModeLabel")}
        title={t("settings.subAgentExecutionModeHint")}
        disabled={isLoading || isSaving}
        onChange={(value) => void save(value)}
      />
    </div>
  );
}
