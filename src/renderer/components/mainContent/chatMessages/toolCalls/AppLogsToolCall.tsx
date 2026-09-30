import { Activity, AlertCircle, Bug, Clock3 } from "lucide-react";
import { useMemo } from "react";
import { useI18n } from "../../../../i18n";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";

type LogRecord = Record<string, unknown>;
type Props = { toolCall: ToolCallInfo };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string =>
  typeof value === "string" ? value : value == null ? "" : String(value);
const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const parseResult = (result?: string): Record<string, unknown> | null => {
  if (!result) return null;
  try {
    const parsed: unknown = JSON.parse(result);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const Severity = ({ level }: { level: string }): React.JSX.Element => (
  <span
    className={`tool-call-log-level tool-call-log-level-${level.toLowerCase()}`}
  >
    {level || "—"}
  </span>
);

const LogText = ({
  label,
  value,
}: {
  label: string;
  value: unknown;
}): React.JSX.Element | null => {
  const content = text(value);
  if (!content) return null;
  return (
    <details className="tool-call-log-field">
      <summary>{label}</summary>
      <pre className="tool-call-log-pre">{content}</pre>
    </details>
  );
};

export const AppLogsToolCall = ({ toolCall }: Props): React.JSX.Element => {
  const { t } = useI18n();
  const data = useMemo(() => parseResult(toolCall.result), [toolCall.result]);
  const items = Array.isArray(data?.items)
    ? (data.items.filter(isRecord) as LogRecord[])
    : [];
  const summary = isRecord(data?.systemSummary) ? data.systemSummary : {};
  const byLevel = isRecord(summary.byLevel) ? summary.byLevel : {};
  const total = number(data?.total);
  const returned = items.length;
  const scope = text(data?.detailScope);
  const args = useMemo(() => {
    try {
      const parsed: unknown = JSON.parse(toolCall.arguments);
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }, [toolCall.arguments]);
  const failure = typeof data?.error === "string" ? data.error : "";

  return (
    <ToolCallNode
      toolName={toolCall.name}
      displayName={t("toolCall.logs.title")}
      displayNameTitle={toolCall.arguments}
      status={failure ? "error" : toolCall.status}
      meta={
        <span className="tool-call-dbx-meta tool-call-dbx-meta-ok">
          <Activity size={10} aria-hidden="true" />
          {t("toolCall.logs.rows", {
            values: { count: returned.toLocaleString() },
          })}
        </span>
      }
      className="tool-call-app-logs"
    >
      <div className="tool-call-body tool-call-app-logs-body">
        {failure ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{failure}</span>
          </div>
        ) : null}

        <div className="tool-call-logs-breakdown-label">
          {t("toolCall.logs.appSummary")}
        </div>
        <div className="tool-call-logs-summary">
          <div className="tool-call-logs-total">
            <Activity size={15} aria-hidden="true" />
            <strong>{total.toLocaleString()}</strong>
            <span>{t("toolCall.logs.total")}</span>
          </div>
          {(["ERROR", "WARN", "INFO", "DEBUG"] as const).map((level) => (
            <div
              className={`tool-call-logs-stat tool-call-logs-stat-${level.toLowerCase()}`}
              key={level}
            >
              <Severity level={level} />
              <strong>{number(byLevel[level]).toLocaleString()}</strong>
            </div>
          ))}
        </div>

        <div className="tool-call-logs-meta">
          <span>
            {scope === "all_application_logs"
              ? t("toolCall.logs.scopeAll")
              : t("toolCall.logs.scopeCurrent")}
          </span>
          {typeof data?.offset === "number" ? (
            <span>
              {t("toolCall.logs.page", {
                values: {
                  from: returned ? number(data.offset) + 1 : 0,
                  to: number(data.offset) + returned,
                  total: number(data.total),
                },
              })}
            </span>
          ) : null}
          {data?.hasMore === true ? (
            <span>{t("toolCall.logs.more")}</span>
          ) : null}
          {args.level && args.level !== "" ? (
            <span>
              {t("toolCall.logs.filterLevel", {
                values: { level: text(args.level) },
              })}
            </span>
          ) : null}
          {args.module ? (
            <span>
              {t("toolCall.logs.filterModule", {
                values: { module: text(args.module) },
              })}
            </span>
          ) : null}
        </div>

        {items.length === 0 ? (
          <div className="tool-call-logs-empty">
            <Bug size={14} aria-hidden="true" />
            {t("toolCall.logs.empty")}
          </div>
        ) : (
          <div className="tool-call-logs-list">
            {items.map((item, index) => {
              const id = text(item.id) || `${text(item.createdAt)}-${index}`;
              const error = text(item.error);
              return (
                <article
                  className={`tool-call-log-entry tool-call-log-entry-${text(item.level).toLowerCase()}`}
                  key={id}
                >
                  <header className="tool-call-log-head">
                    <Severity level={text(item.level)} />
                    <span className="tool-call-log-module">
                      {text(item.module) || t("toolCall.logs.unknownModule")}
                    </span>
                    <span className="tool-call-log-message">
                      {text(item.message) ||
                        error ||
                        t("toolCall.logs.noMessage")}
                    </span>
                  </header>
                  <div className="tool-call-log-subline">
                    <time>
                      <Clock3 size={11} aria-hidden="true" />
                      {text(item.createdAt)}
                    </time>
                    {item.function ? (
                      <code>
                        {text(item.function)}
                        {item.line ? `:${text(item.line)}` : ""}
                      </code>
                    ) : null}
                    {item.duration ? (
                      <span>
                        {t("toolCall.logs.duration", {
                          values: { duration: text(item.duration) },
                        })}
                      </span>
                    ) : null}
                    {item.source ? <span>{text(item.source)}</span> : null}
                  </div>
                  {error && error !== text(item.message) ? (
                    <div className="tool-call-log-error">
                      <AlertCircle size={12} aria-hidden="true" />
                      {error}
                    </div>
                  ) : null}
                  <div className="tool-call-log-trace">
                    {item.conversationId ? (
                      <span>
                        {t("toolCall.logs.trace")}:{" "}
                        <code>
                          {text(item.traceKey || item.conversationId)}
                        </code>
                      </span>
                    ) : null}
                    {item.conversationId ? (
                      <code>{text(item.conversationId)}</code>
                    ) : null}
                  </div>
                  <div className="tool-call-log-fields">
                    <LogText
                      label={t("toolCall.logs.context")}
                      value={item.context}
                    />
                    <LogText
                      label={
                        item.module === "api_request"
                          ? t("toolCall.logs.request")
                          : t("toolCall.logs.input")
                      }
                      value={item.input || item.requestBody}
                    />
                    <LogText
                      label={
                        item.module === "api_response"
                          ? t("toolCall.logs.response")
                          : t("toolCall.logs.output")
                      }
                      value={item.output || item.responseBody}
                    />
                  </div>
                </article>
              );
            })}
          </div>
        )}
        <p className="tool-call-logs-hint">{t("toolCall.logs.traceHint")}</p>
      </div>
    </ToolCallNode>
  );
};
