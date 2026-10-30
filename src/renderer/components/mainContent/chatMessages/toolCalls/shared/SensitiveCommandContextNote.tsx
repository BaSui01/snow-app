import { useI18n } from "../../../../../i18n";

type ContextUsage = {
  contextMessages?: number;
  contextTruncated?: boolean;
  contextEmpty?: boolean;
};

/** 判定所用的会话上下文说明；开关关闭（无字段）时不渲染。 */
export const SensitiveCommandContextNote = ({
  decision,
  className,
}: {
  decision: ContextUsage;
  className?: string;
}): React.JSX.Element | null => {
  const { t } = useI18n();

  const isEnabled =
    typeof decision.contextMessages === "number" ||
    decision.contextEmpty === true ||
    decision.contextTruncated === true;
  if (!isEnabled) {
    return null;
  }

  const count = decision.contextMessages ?? 0;
  const label = decision.contextEmpty
    ? decision.contextTruncated
      ? t("sensitiveCommand.decisionContextDropped")
      : t("sensitiveCommand.decisionContextEmpty")
    : decision.contextTruncated
      ? t("sensitiveCommand.decisionContextTruncated", { values: { count } })
      : t("sensitiveCommand.decisionContextUsed", { values: { count } });

  return <span className={className}>{label}</span>;
};
