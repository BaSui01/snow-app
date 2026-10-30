import { useMemo } from "react";
import { AlertCircle, Image as ImageIcon, Loader2, Scale } from "lucide-react";
import { useI18n } from "../../../../i18n";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { isRecord } from "./imagegenUtils";
import { ToolCallNode } from "./shared/ToolCallNode";
import { localizeToolError } from "./shared/toolErrorDisplay";

type DecisionToolCallProps = {
  toolCall: ToolCallInfo;
};

type DecisionAnswer = {
  name: string;
  type: string;
  probability?: number;
  choice?: string;
  confidence?: number;
  score?: number;
  level?: string;
  refused?: boolean;
  error?: string;
};

type DecisionImage = {
  path: string;
  sentWidth?: number;
  sentHeight?: number;
};

type ParsedDecisionResult =
  | {
      type: "success";
      modelName: string;
      answers: DecisionAnswer[];
      images: DecisionImage[];
    }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const toNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const toText = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const parseAnswer = (value: unknown): DecisionAnswer | null => {
  if (!isRecord(value) || typeof value.name !== "string") {
    return null;
  }
  return {
    name: value.name,
    type: typeof value.type === "string" ? value.type : "",
    probability: toNumber(value.probability),
    choice:
      typeof value.choice === "string"
        ? value.choice
        : typeof value.choice === "boolean"
          ? String(value.choice)
          : undefined,
    confidence: toNumber(value.confidence),
    score: toNumber(value.score),
    level: toText(value.level),
    refused: value.refused === true,
    error: toText(value.error),
  };
};

const parseResult = (result: string | undefined): ParsedDecisionResult => {
  if (!result) {
    return { type: "empty" };
  }
  try {
    const parsed: unknown = JSON.parse(result);
    if (!isRecord(parsed)) {
      return { type: "raw", text: result };
    }
    if (Array.isArray(parsed.answers)) {
      const model: Record<string, unknown> = isRecord(parsed.decisionModel)
        ? parsed.decisionModel
        : {};
      return {
        type: "success",
        modelName: toText(model.name) ?? toText(model.model) ?? "",
        answers: parsed.answers
          .map(parseAnswer)
          .filter((item): item is DecisionAnswer => item !== null),
        images: Array.isArray(parsed.images)
          ? parsed.images.filter(isRecord).map((item) => ({
              path: typeof item.path === "string" ? item.path : "",
              sentWidth: toNumber(item.sentWidth),
              sentHeight: toNumber(item.sentHeight),
            }))
          : [],
      };
    }
    const message = toText(parsed.message) ?? toText(parsed.error);
    return message ? { type: "error", message } : { type: "raw", text: result };
  } catch {
    return { type: "raw", text: result };
  }
};

type ParsedQuestions = {
  count: number;
  /** name -> instructions，结果里只有 name，问题正文需回查入参。 */
  instructions: Map<string, string>;
};

const parseQuestions = (args: string): ParsedQuestions => {
  const instructions = new Map<string, string>();
  let count = 0;
  try {
    const parsed: unknown = JSON.parse(args);
    if (isRecord(parsed) && Array.isArray(parsed.questions)) {
      count = parsed.questions.length;
      for (const item of parsed.questions) {
        if (!isRecord(item) || typeof item.name !== "string") {
          continue;
        }
        const text = toText(item.instructions);
        if (text) {
          instructions.set(item.name, text);
        }
      }
    }
  } catch {
    return { count: 0, instructions };
  }
  return { count, instructions };
};

const percent = (value: number): string => `${Math.round(value * 100)}%`;

const fileNameOf = (path: string): string =>
  path.split(/[\\/]/).filter(Boolean).pop() ?? path;

export const DecisionToolCall = ({
  toolCall,
}: DecisionToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const parsed = useMemo(() => parseResult(toolCall.result), [toolCall.result]);
  const questions = useMemo(
    () => parseQuestions(toolCall.arguments),
    [toolCall.arguments],
  );
  const questionCount = questions.count;

  const isRunning = toolCall.status === "running";
  const isFailed = toolCall.status === "error";
  const effectiveStatus =
    isFailed || parsed.type === "error" ? "error" : toolCall.status;

  const errorMessage =
    parsed.type === "error"
      ? localizeToolError(t, parsed.message)
      : isFailed && parsed.type === "raw"
        ? parsed.text
        : "";

  const typeLabel = (type: string): string =>
    type === "predicate" || type === "choice" || type === "score"
      ? t(`toolCall.decision.type.${type}`)
      : type;

  /** 每题的主结论与补充信息。 */
  const describeAnswer = (
    answer: DecisionAnswer,
  ): { value: string; extra?: string; muted?: boolean } => {
    if (answer.refused) {
      return { value: t("toolCall.decision.refused"), muted: true };
    }
    if (answer.error) {
      return { value: t("toolCall.decision.noAnswer"), muted: true };
    }
    const confidence =
      answer.confidence !== undefined
        ? t("toolCall.decision.confidence", {
            values: { value: percent(answer.confidence) },
          })
        : undefined;
    if (answer.type === "predicate" && answer.probability !== undefined) {
      return { value: percent(answer.probability) };
    }
    if (answer.type === "choice" && answer.choice !== undefined) {
      return { value: answer.choice, extra: confidence };
    }
    if (answer.type === "score" && answer.score !== undefined) {
      const score = t("toolCall.decision.score", {
        values: { value: answer.score.toFixed(2) },
      });
      return {
        value: answer.level ?? answer.score.toFixed(2),
        extra: [answer.level ? score : undefined, confidence]
          .filter(Boolean)
          .join(" · "),
      };
    }
    return { value: t("toolCall.decision.noAnswer"), muted: true };
  };

  return (
    <ToolCallNode
      toolName={toolCall.name}
      badgeName={t("toolCall.decision.name")}
      category="decision"
      displayName={
        parsed.type === "success" && parsed.modelName
          ? parsed.modelName
          : undefined
      }
      status={effectiveStatus}
      meta={
        questionCount > 0 ? (
          <span className="decision-tool-meta">
            {t("toolCall.decision.questions", {
              values: { count: questionCount },
            })}
          </span>
        ) : null
      }
      className="decision-tool-call"
    >
      <div className="tool-call-body decision-tool-body">
        {errorMessage ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{errorMessage}</span>
          </div>
        ) : null}

        {parsed.type === "success" ? (
          <>
            <div className="decision-tool-answers">
              {parsed.answers.map((answer) => {
                const summary = describeAnswer(answer);
                const question = questions.instructions.get(answer.name);
                return (
                  <div className="decision-tool-answer" key={answer.name}>
                    <code
                      className={`decision-tool-answer-name${
                        question ? " is-tag" : ""
                      }`}
                      title={question ? answer.name : undefined}
                    >
                      {answer.name}
                    </code>
                    {question ? (
                      <span className="decision-tool-answer-question">
                        {question}
                      </span>
                    ) : null}
                    <span className="decision-tool-answer-type">
                      {typeLabel(answer.type)}
                    </span>
                    <span
                      className={`decision-tool-answer-value${
                        summary.muted ? " is-muted" : ""
                      }`}
                    >
                      {summary.value}
                    </span>
                    {summary.extra ? (
                      <span className="decision-tool-answer-extra">
                        {summary.extra}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {parsed.images.length > 0 ? (
              <div className="decision-tool-images">
                <span className="decision-tool-images-label">
                  <ImageIcon size={11} aria-hidden="true" />
                  {t("toolCall.decision.images")}
                </span>
                {parsed.images.map((image) => (
                  <code
                    className="decision-tool-image"
                    key={image.path}
                    title={image.path}
                    data-path={image.path}
                  >
                    {fileNameOf(image.path)}
                    {image.sentWidth && image.sentHeight
                      ? ` ${image.sentWidth}x${image.sentHeight}`
                      : ""}
                  </code>
                ))}
              </div>
            ) : null}
          </>
        ) : null}

        {parsed.type === "raw" && !isFailed ? (
          <section className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.decision.result")}
            </span>
            <pre className="tool-call-section-pre">{parsed.text}</pre>
          </section>
        ) : null}

        {parsed.type === "empty" ? (
          <div className="decision-tool-pending">
            {isRunning ? (
              <Loader2
                className="tool-call-icon-spinning"
                size={14}
                aria-hidden="true"
              />
            ) : (
              <Scale size={14} aria-hidden="true" />
            )}
            <span>
              {isRunning
                ? t("toolCall.decision.running")
                : t("toolCall.decision.waiting")}
            </span>
          </div>
        ) : null}
      </div>
    </ToolCallNode>
  );
};
