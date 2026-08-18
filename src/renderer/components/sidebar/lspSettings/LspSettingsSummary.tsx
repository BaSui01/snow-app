import { Braces } from "lucide-react";
import { useI18n } from "../../../i18n";

type LspSettingsSummaryProps = {
  totalCount: number;
  enabledCount: number;
};

export function LspSettingsSummary({
  totalCount,
  enabledCount,
}: LspSettingsSummaryProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="api-settings-summary-grid lsp-settings-summary-grid">
      <div className="api-settings-summary-card wide">
        <Braces size={15} strokeWidth={1.8} />
        <span>{totalCount}</span>
        <small>
          {t("settings.lspLanguageCount", { defaultValue: "Languages" })}
        </small>
      </div>
      <div className="api-settings-summary-card wide">
        <Braces size={15} strokeWidth={1.8} />
        <span>{enabledCount}</span>
        <small>
          {t("settings.lspEnabledCount", { defaultValue: "Enabled servers" })}
        </small>
      </div>
    </div>
  );
}
