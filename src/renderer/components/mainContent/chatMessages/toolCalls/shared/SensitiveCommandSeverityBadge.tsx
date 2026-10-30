import { Gauge } from "lucide-react";
import { useI18n } from "../../../../../i18n";
import { Tooltip } from "../../../../common/Tooltip";

/** 与 Rust 端 SEVERITY_LEVELS 一致（低 -> 高）。 */
const SEVERITY_LEVELS = ["low", "medium", "high"] as const;

type SeverityLevel = (typeof SEVERITY_LEVELS)[number];

const isSeverityLevel = (value: string): value is SeverityLevel =>
  (SEVERITY_LEVELS as readonly string[]).includes(value);

/** 决策模型给出的风险等级徽标；等级为空或未知时不渲染。 */
export const SensitiveCommandSeverityBadge = ({
  severity,
  severityScore,
}: {
  severity?: string | null;
  severityScore?: number | null;
}): React.JSX.Element | null => {
  const { t } = useI18n();

  if (!severity || !isSeverityLevel(severity)) {
    return null;
  }

  const badge = (
    <span className={`sensitive-command-severity is-${severity}`}>
      <Gauge size={11} strokeWidth={2} aria-hidden="true" />
      {t("sensitiveCommand.severityBadge", {
        values: { level: t(`sensitiveCommand.severity.${severity}`) },
      })}
    </span>
  );

  if (typeof severityScore !== "number" || !Number.isFinite(severityScore)) {
    return badge;
  }

  return (
    <Tooltip
      placement="top"
      content={t("sensitiveCommand.severityScore", {
        values: {
          value: severityScore.toFixed(2),
          max: SEVERITY_LEVELS.length - 1,
        },
      })}
    >
      {badge}
    </Tooltip>
  );
};
