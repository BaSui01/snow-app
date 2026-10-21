import { CheckCircle2, Loader2, PlugZap, XCircle } from "lucide-react";
import { getActiveLocale, useI18n } from "../../../i18n";
import type { ModelConnectionTestResult } from "../../../../preload";

/**
 * 决策 / 嵌入 / 重排模型的连接自检展示（API 配置 → 决策模型、代码库设置共用）。
 *
 * 检测由 Rust 发出最小请求并持久化结果，这里只负责展示「最近一次检测」：
 * 成功 / 失败、HTTP 状态、耗时、请求地址、模型，以及嵌入模型的返回维度。
 */

const formatTestedAt = (value: number): string =>
  value > 0
    ? new Date(value).toLocaleString(getActiveLocale(), {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "";

type ModelTestButtonProps = {
  testing: boolean;
  disabled?: boolean;
  onClick: () => void;
  /** 只显示图标（表格操作列）。 */
  iconOnly?: boolean;
};

/** 「测试连接」按钮：检测中显示加载图标。 */
export function ModelTestButton({
  testing,
  disabled,
  onClick,
  iconOnly,
}: ModelTestButtonProps): React.JSX.Element {
  const { t } = useI18n();
  const label = testing ? t("modelHealth.testing") : t("modelHealth.test");
  const icon = testing ? (
    <Loader2 size={iconOnly ? 13 : 15} className="spin" />
  ) : (
    <PlugZap size={iconOnly ? 13 : 15} strokeWidth={1.9} />
  );

  if (iconOnly) {
    return (
      <button
        type="button"
        className="icon-btn ghost"
        onClick={onClick}
        disabled={disabled || testing}
        title={label}
        aria-label={label}
      >
        {icon}
      </button>
    );
  }

  return (
    <button
      type="button"
      className="api-settings-form-btn secondary"
      onClick={onClick}
      disabled={disabled || testing}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

type ModelConnectionStatusProps = {
  result?: ModelConnectionTestResult | null;
  /** 紧凑模式：表格单元格里的一行状态，明细放在悬停提示里。 */
  compact?: boolean;
};

export function ModelConnectionStatus({
  result,
  compact,
}: ModelConnectionStatusProps): React.JSX.Element {
  const { t } = useI18n();

  if (!result) {
    return (
      <span className="model-health-status is-untested">
        {t("modelHealth.untested")}
      </span>
    );
  }

  const testedAt = formatTestedAt(result.testedAt);
  const httpStatus =
    typeof result.httpStatus === "number" ? String(result.httpStatus) : "-";
  const latency = t("modelHealth.latencyValue", {
    values: { value: Math.round(result.latencyMs) },
  });
  const dimension =
    typeof result.dimension === "number"
      ? typeof result.expectedDimension === "number"
        ? t("modelHealth.dimensionValue", {
            values: {
              actual: result.dimension,
              expected: result.expectedDimension,
            },
          })
        : t("modelHealth.dimensionActual", {
            values: { actual: result.dimension },
          })
      : "";

  if (compact) {
    const summary = result.ok
      ? t("modelHealth.compactOk", { values: { latency } })
      : typeof result.httpStatus === "number"
        ? t("modelHealth.compactFailedStatus", {
            values: { status: result.httpStatus },
          })
        : t("modelHealth.failed");
    const detail = [
      testedAt ? t("modelHealth.testedAt", { values: { time: testedAt } }) : "",
      result.error ?? "",
    ]
      .filter(Boolean)
      .join("\n");

    return (
      <span
        className={`model-health-status ${result.ok ? "is-ok" : "is-failed"}`}
        title={detail || undefined}
      >
        {result.ok ? (
          <CheckCircle2 size={12} aria-hidden="true" />
        ) : (
          <XCircle size={12} aria-hidden="true" />
        )}
        <span>{summary}</span>
      </span>
    );
  }

  return (
    <div className={`model-health-result ${result.ok ? "is-ok" : "is-failed"}`}>
      <div className="model-health-result-head">
        {result.ok ? (
          <CheckCircle2 size={14} aria-hidden="true" />
        ) : (
          <XCircle size={14} aria-hidden="true" />
        )}
        <strong>
          {result.ok ? t("modelHealth.ok") : t("modelHealth.failed")}
        </strong>
        {testedAt ? (
          <span className="model-health-result-time">
            {t("modelHealth.testedAt", { values: { time: testedAt } })}
          </span>
        ) : null}
      </div>
      <dl className="model-health-result-grid">
        <dt>{t("modelHealth.httpStatus")}</dt>
        <dd>{httpStatus}</dd>
        <dt>{t("modelHealth.latency")}</dt>
        <dd>{latency}</dd>
        <dt>{t("modelHealth.endpoint")}</dt>
        <dd title={result.endpoint}>{result.endpoint || "-"}</dd>
        <dt>{t("modelHealth.model")}</dt>
        <dd>{result.model || "-"}</dd>
        {dimension ? (
          <>
            <dt>{t("modelHealth.dimension")}</dt>
            <dd>{dimension}</dd>
          </>
        ) : null}
      </dl>
      {result.error ? (
        <p className="model-health-result-error">{result.error}</p>
      ) : null}
    </div>
  );
}
