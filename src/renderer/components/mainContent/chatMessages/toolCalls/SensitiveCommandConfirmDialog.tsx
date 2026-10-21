import { AlertTriangle, ShieldAlert, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../../../i18n";
import { keyToDisplay } from "../../../../utils/shortcutUtils";
import type { ToolCallInfo } from "../utils/conversationTypes";

type SensitiveCommandMatch = {
  commandId: string;
  pattern: string;
  description: string;
};

type SensitiveCommandDecision = {
  allow: boolean;
  reason: string;
  confidence: number;
  modelName: string;
  /** 决策模型不可用 / 请求失败的原因（此时判定无效，已回退人工确认）。 */
  error?: string;
};

type SensitiveCommandConfirmDialogProps = {
  toolCalls: ToolCallInfo[];
  onApprove: (toolCall: ToolCallInfo) => void;
  onReject: (
    toolCall: ToolCallInfo,
    reason: string,
    userProvidedReason?: boolean,
  ) => void;
};
const COMMAND_TOOL_NAMES = new Set(["bash-terminal-execute"]);

const parseBashArgument = (
  toolCall: ToolCallInfo,
  key: "command" | "description",
): string | null => {
  if (!COMMAND_TOOL_NAMES.has(toolCall.name)) {
    return null;
  }

  try {
    const parsed = JSON.parse(toolCall.arguments || "{}") as Record<
      string,
      unknown
    >;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed[key] === "string"
    ) {
      return parsed[key] as string;
    }
  } catch {
    // fall through
  }

  return null;
};

const SensitiveCommandItem = ({
  toolCall,
  matches,
  decision,
  isSubmitting,
  onApprove,
  onReject,
}: {
  toolCall: ToolCallInfo;
  matches: SensitiveCommandMatch[];
  decision?: SensitiveCommandDecision;
  isSubmitting: boolean;
  onApprove: (toolCall: ToolCallInfo) => void;
  onReject: (
    toolCall: ToolCallInfo,
    reason: string,
    userProvidedReason?: boolean,
  ) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const [rejectionReason, setRejectionReason] = useState("");
  const command =
    parseBashArgument(toolCall, "command") ?? toolCall.arguments ?? "";
  const description = parseBashArgument(toolCall, "description");
  const trimmedReason = rejectionReason.trim();

  /** 拒绝：理由为空时回落到默认理由（与「拒绝」按钮一致）。 */
  const handleReject = (): void => {
    if (isSubmitting) {
      return;
    }
    onReject(
      toolCall,
      trimmedReason || t("toolAuthorization.defaultRejectionReason"),
      trimmedReason.length > 0,
    );
  };

  /**
   * 拒绝理由输入框的 Ctrl/Cmd + Enter：填写了理由才生效，等同「拒绝」按钮，
   * 免去移动鼠标。
   */
  const handleReasonKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    if (
      event.key !== "Enter" ||
      !(event.ctrlKey || event.metaKey) ||
      event.nativeEvent.isComposing ||
      !trimmedReason
    ) {
      return;
    }
    event.preventDefault();
    handleReject();
  };

  return (
    <article className="tool-authorization-prompt-item sensitive-command-item">
      <div className="tool-authorization-tool-row">
        <span className="tool-authorization-tool-label">
          {t("toolAuthorization.toolName")}
        </span>
        <code className="tool-authorization-tool-name">{toolCall.name}</code>
      </div>

      <div className="tool-authorization-args">
        {description ? (
          <div className="sensitive-command-description">
            <span className="tool-authorization-tool-label">
              {t("sensitiveCommand.description")}
            </span>
            <p>{description}</p>
          </div>
        ) : null}

        <span className="tool-authorization-tool-label">
          {t("sensitiveCommand.command")}
        </span>
        <pre className="sensitive-command-command-pre">
          <span className="tool-call-bash-prompt" aria-hidden="true">
            $
          </span>
          <code>{command}</code>
        </pre>
      </div>

      <div className="sensitive-command-matches">
        <span className="tool-authorization-tool-label">
          {t("sensitiveCommand.matchedRules")}
        </span>
        <ul className="sensitive-command-match-list">
          {matches.map((match) => (
            <li key={match.commandId} className="sensitive-command-match-entry">
              <code className="sensitive-command-match-pattern">
                {match.pattern}
              </code>
              {match.description ? (
                <span className="sensitive-command-match-desc">
                  {match.description}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      {decision?.error ? (
        <div className="sensitive-command-decision is-unavailable">
          <span className="tool-authorization-tool-label">
            {t("sensitiveCommand.decisionLabel")}
          </span>
          <div className="sensitive-command-decision-body">
            <span className="sensitive-command-decision-verdict">
              <AlertTriangle size={13} strokeWidth={2} aria-hidden="true" />
              <strong>{t("sensitiveCommand.decisionUnavailable")}</strong>
            </span>
            <span className="sensitive-command-decision-reason">
              {decision.error}
            </span>
            {decision.modelName ? (
              <span className="sensitive-command-decision-model">
                {t("sensitiveCommand.decisionModel", {
                  values: { name: decision.modelName },
                })}
              </span>
            ) : null}
          </div>
        </div>
      ) : decision ? (
        <div
          className={`sensitive-command-decision ${
            decision.allow ? "is-allow" : "is-confirm"
          }`}
        >
          <span className="tool-authorization-tool-label">
            {t("sensitiveCommand.decisionLabel")}
          </span>
          <div className="sensitive-command-decision-body">
            <span className="sensitive-command-decision-verdict">
              {decision.allow ? (
                <ShieldCheck size={13} strokeWidth={2} aria-hidden="true" />
              ) : (
                <ShieldAlert size={13} strokeWidth={2} aria-hidden="true" />
              )}
              <strong>
                {decision.allow
                  ? t("sensitiveCommand.decisionAllow")
                  : t("sensitiveCommand.decisionConfirm")}
              </strong>
              {decision.confidence > 0 ? (
                <small>
                  {t("sensitiveCommand.decisionConfidence", {
                    values: { value: Math.round(decision.confidence * 100) },
                  })}
                </small>
              ) : null}
            </span>
            <span className="sensitive-command-decision-reason">
              {t(`sensitiveCommand.decision.reason.${decision.reason}`, {
                defaultValue: decision.reason,
              })}
            </span>
            {decision.modelName ? (
              <span className="sensitive-command-decision-model">
                {t("sensitiveCommand.decisionModel", {
                  values: { name: decision.modelName },
                })}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      <label className="tool-authorization-rejection-reason">
        <span className="tool-authorization-tool-label">
          {t("toolAuthorization.rejectionReason")}
        </span>
        <textarea
          disabled={isSubmitting}
          onChange={(event) => setRejectionReason(event.target.value)}
          onKeyDown={handleReasonKeyDown}
          placeholder={t("toolAuthorization.rejectionReasonPlaceholder")}
          rows={2}
          value={rejectionReason}
        />
        <span className="tool-authorization-rejection-hint">
          {t("toolAuthorization.rejectionShortcutHint", {
            values: { keys: keyToDisplay("mod+enter") },
          })}
        </span>
      </label>

      <div className="tool-authorization-actions">
        <button
          className="tool-authorization-action tool-authorization-reject"
          disabled={isSubmitting}
          onClick={handleReject}
          type="button"
        >
          {t("toolAuthorization.reject")}
        </button>
        <button
          className="tool-authorization-action tool-authorization-approve"
          disabled={isSubmitting}
          onClick={() => onApprove(toolCall)}
          type="button"
        >
          {t("sensitiveCommand.confirmExecution")}
        </button>
      </div>
    </article>
  );
};

export const SensitiveCommandConfirmDialog = ({
  toolCalls,
  onApprove,
  onReject,
}: SensitiveCommandConfirmDialogProps): React.JSX.Element | null => {
  const { t } = useI18n();
  const [submittingId, setSubmittingId] = useState<string | null>(null);

  if (toolCalls.length === 0) {
    return null;
  }

  return (
    <section
      className="tool-authorization-prompt sensitive-command-prompt"
      aria-label={t("sensitiveCommand.title")}
    >
      <div className="tool-authorization-prompt-heading">
        <span className="tool-authorization-prompt-icon" aria-hidden="true">
          <ShieldAlert size={14} />
        </span>
        <div className="tool-authorization-prompt-copy">
          <strong>{t("sensitiveCommand.title")}</strong>
          <p>{t("sensitiveCommand.message")}</p>
        </div>
      </div>
      <div className="tool-authorization-prompt-list">
        {toolCalls.map((toolCall) => {
          const id =
            toolCall.authorizationId ??
            `${toolCall.name}-${toolCall.callId ?? toolCall.arguments}`;
          const matches: SensitiveCommandMatch[] = (
            toolCall.sensitiveCommandMatches ?? []
          ).map((match) => ({
            commandId: match.commandId,
            pattern: match.pattern,
            description: match.description,
          }));
          // 决策模型辅助的判定（未启用辅助 / 请求失败时为空，只显示规则命中）。
          const decision: SensitiveCommandDecision | undefined =
            toolCall.sensitiveCommandDecision;

          return (
            <SensitiveCommandItem
              key={id}
              toolCall={toolCall}
              matches={matches}
              decision={decision}
              isSubmitting={submittingId === id}
              onApprove={(item) => {
                setSubmittingId(id);
                onApprove(item);
              }}
              onReject={(item, reason, userProvidedReason) => {
                setSubmittingId(id);
                onReject(item, reason, userProvidedReason);
              }}
            />
          );
        })}
      </div>
    </section>
  );
};
