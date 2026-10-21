import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  CircleSlash2,
  Drill,
  Lightbulb,
} from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../../../i18n";
import type {
  ToolCorrectionAttempt,
  ToolCorrectionState,
} from "../utils/conversationTypes";

type ToolCorrectionTreeProps = {
  correction: ToolCorrectionState;
};

const MAX_PREVIEW_CHARS = 4_000;

const previewText = (value: string, max = MAX_PREVIEW_CHARS): string =>
  value.length > max ? `${value.slice(0, max)}\n...` : value;

const prettyArguments = (raw: string): string => {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
};

const attemptIcon = (attempt: ToolCorrectionAttempt): React.JSX.Element => {
  if (attempt.status === "running") {
    return <CircleDot size={12} aria-hidden="true" />;
  }
  if (attempt.status === "succeeded") {
    return <CheckCircle2 size={12} aria-hidden="true" />;
  }
  if (attempt.status === "rejected") {
    return <CircleSlash2 size={12} aria-hidden="true" />;
  }
  return <AlertCircle size={12} aria-hidden="true" />;
};

export const ToolCorrectionTree = ({
  correction,
}: ToolCorrectionTreeProps): React.JSX.Element => {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const succeededAttempt = correction.attempts.find(
    (attempt) => attempt.status === "succeeded",
  );

  const statusLabel = t(`toolCall.correction.status.${correction.status}`, {
    defaultValue: correction.status,
  });

  return (
    <div
      className={`tct tct--${correction.status}${isOpen ? " tct--open" : ""}`}
    >
      <button
        type="button"
        className="tct-header"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
      >
        <Drill size={13} className="tct-root-icon" aria-hidden="true" />
        <span className="tct-title">
          {t("toolCall.correction.title", { defaultValue: "纠错 Agent" })}
        </span>
        <span className="tct-subtitle">
          {t("toolCall.correction.subtitle", { defaultValue: "基础模型" })}
        </span>
        <span className={`tct-status tct-status--${correction.status}`}>
          {statusLabel}
        </span>
        {correction.attempts.length > 0 ? (
          <span className="tct-count">
            {t("toolCall.correction.attemptCount", {
              values: { count: correction.attempts.length },
              defaultValue: `${correction.attempts.length} 次纠错`,
            })}
          </span>
        ) : null}
        <ChevronRight size={12} className="tct-chevron" aria-hidden="true" />
      </button>

      <div className="tct-body-wrap">
        <div className="tct-body">
          <details className="tct-attempt-detail tct-original-detail">
            <summary>
              {t("toolCall.correction.originalArguments", {
                defaultValue: "原始参数",
              })}
            </summary>
            <pre className="tct-pre">
              {prettyArguments(correction.originalArguments)}
            </pre>
          </details>

          {correction.attempts.length > 0 ? (
            <ul className="tct-tree">
              {correction.attempts.map((attempt) => (
                <li
                  key={attempt.index}
                  className={`tct-node tct-node--${attempt.status}`}
                >
                  <div className="tct-node-head">
                    {attemptIcon(attempt)}
                    <span className="tct-node-title">
                      {t("toolCall.correction.attempt", {
                        values: { index: attempt.index },
                        defaultValue: `第 ${attempt.index} 次纠错`,
                      })}
                    </span>
                    <span
                      className={`tct-attempt-status tct-attempt-status--${attempt.status}`}
                    >
                      {t(
                        `toolCall.correction.attemptStatus.${attempt.status}`,
                        {
                          defaultValue: attempt.status,
                        },
                      )}
                    </span>
                    {attempt.finishedAt !== undefined ? (
                      <span className="tct-node-time">
                        {attempt.finishedAt - attempt.startedAt} ms
                      </span>
                    ) : null}
                  </div>

                  {attempt.reasoning ? (
                    <div className="tct-reasoning">
                      <Lightbulb size={11} aria-hidden="true" />
                      <span>{attempt.reasoning}</span>
                    </div>
                  ) : null}

                  {attempt.error ? (
                    <pre className="tct-pre tct-pre--error">
                      {previewText(attempt.error, 1_200)}
                    </pre>
                  ) : null}

                  <details className="tct-attempt-detail">
                    <summary>
                      {t("toolCall.correction.details", {
                        defaultValue: "查看参数与结果",
                      })}
                    </summary>
                    <div className="tct-detail-block">
                      <span className="tct-k">
                        {t("toolCall.correction.arguments", {
                          defaultValue: "修正参数",
                        })}
                      </span>
                      <pre className="tct-pre">
                        {prettyArguments(attempt.arguments)}
                      </pre>
                    </div>
                    {attempt.result !== undefined ? (
                      <div className="tct-detail-block">
                        <span className="tct-k">
                          {t("toolCall.correction.result", {
                            defaultValue: "执行结果",
                          })}
                        </span>
                        <pre className="tct-pre">
                          {previewText(attempt.result)}
                        </pre>
                      </div>
                    ) : null}
                  </details>
                </li>
              ))}
            </ul>
          ) : null}

          {correction.failureCode ? (
            <div className="tct-failure">
              {t(`toolCall.correction.failure.${correction.failureCode}`, {
                defaultValue: correction.failureCode,
              })}
            </div>
          ) : null}

          {correction.failureDetail ? (
            <pre className="tct-pre tct-pre--muted">
              {previewText(correction.failureDetail, 1_200)}
            </pre>
          ) : null}

          {succeededAttempt ? (
            <div className="tct-replaced">
              <CheckCircle2 size={12} aria-hidden="true" />
              <span>
                {t("toolCall.correction.replaced", {
                  defaultValue: "已用修正后的调用与结果替换主流程",
                })}
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};
