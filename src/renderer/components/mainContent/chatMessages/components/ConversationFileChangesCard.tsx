import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, FileText, Files } from "lucide-react";
import { useI18n } from "../../../../i18n";
import { useChatConversationContext } from "./ChatConversationContext";
import {
  collectConversationFileChanges,
  countFileChangeLines,
} from "../hooks/fileChangeTracking";
import type { FileChangeRecord } from "../utils/conversationTypes";
import "./ConversationFileChangesCard.css";

/** Display relative paths only within the actual tracking root, not the UI workspace. */
const displayPath = (record: FileChangeRecord): string => {
  if (!record.root) return record.filePath;
  const path = record.filePath.replaceAll("\\", "/");
  const root = record.root.replaceAll("\\", "/").replace(/\/+$/, "");
  const prefix = `${root}/`;
  const windows = /^[A-Za-z]:\//.test(path) || path.startsWith("//");
  const contained = windows
    ? path.toLowerCase().startsWith(prefix.toLowerCase())
    : path.startsWith(prefix);
  const relative = path.slice(prefix.length);
  return contained &&
    relative &&
    !relative.split("/").some((part) => part === ".." || part === ".")
    ? relative
    : record.filePath;
};

/** Conversation evidence, intentionally independent from the rollback/checkpoint list. */
export const ConversationFileChangesCard = ({
  conversationId,
  messageId,
}: {
  conversationId: string;
  messageId: string;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const conversation = useChatConversationContext();
  const [expanded, setExpanded] = useState(false);
  const files = useMemo(
    () =>
      collectConversationFileChanges(
        conversation.fileChangeStats,
        conversationId,
      ),
    [conversation.fileChangeStats, conversationId],
  );
  const coverage = conversation.fileChangeCoverage[conversationId] ?? [];
  const known = files.filter(
    (file) => Boolean(file.diff?.patch) && !file.diff?.isBinary,
  );
  const lineStats = countFileChangeLines(known);
  const hasLegacy = files.some((file) => !file.fileKey || !file.source);
  const limited = coverage.some((record) => record.coverage !== "scoped");
  const lastMessage = [...conversation.messages]
    .reverse()
    .find((message) => message.role !== "tool");

  // Both identity and run-state guards are required: an old reply must not
  // flash its card while the next user message or another session is active.
  if (
    conversation.activeConversationId !== conversationId ||
    conversation.isStreaming ||
    conversation.isAborting ||
    conversation.isPaused ||
    lastMessage?.role !== "assistant" ||
    lastMessage.id !== messageId ||
    lastMessage.status === "sending" ||
    (!files.length && !coverage.length)
  )
    return null;

  const rows = expanded ? files : files.slice(0, 4);
  return (
    <section
      className="conversation-files-card"
      aria-label={t("chat.fileCard.title")}
    >
      <div className="conversation-files-card-heading">
        <Files size={16} aria-hidden="true" />
        <strong>
          {files.length
            ? t("chat.fileCard.recorded", { values: { count: files.length } })
            : t("chat.fileCard.empty")}
        </strong>
      </div>
      <div className="conversation-files-card-subtitle">
        {t("chat.fileCard.cumulative")}
      </div>
      {known.length > 0 ? (
        <div className="conversation-files-card-lines">
          <span className="conversation-files-additions">
            +{lineStats.additions} {t("chat.fileCard.added")}
          </span>
          <span className="conversation-files-deletions">
            −{lineStats.deletions} {t("chat.fileCard.deleted")}
          </span>
          <span className="conversation-files-muted">
            {t("chat.fileCard.knownLines")}
          </span>
        </div>
      ) : files.length > 0 ? (
        <div className="conversation-files-card-subtitle">
          {t("chat.fileCard.linesUnavailable")}
        </div>
      ) : null}
      <ul className="conversation-files-card-list">
        {rows.map((file) => {
          const hasDiff = Boolean(file.diff?.patch) && !file.diff?.isBinary;
          const stats = hasDiff ? countFileChangeLines([file]) : null;
          return (
            <li key={file.fileKey ?? file.filePath}>
              <FileText size={13} aria-hidden="true" />
              <span
                className="conversation-files-card-path"
                title={file.filePath}
              >
                {displayPath(file)}
              </span>
              {stats ? (
                <span className="conversation-files-card-row-lines">
                  <span className="conversation-files-additions">
                    +{stats.additions}
                  </span>
                  <span className="conversation-files-deletions">
                    −{stats.deletions}
                  </span>
                </span>
              ) : (
                <span className="conversation-files-muted">
                  {t("chat.fileCard.linesUnavailable")}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {files.length > 0 ? (
        <button
          className="conversation-files-card-toggle"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {t(expanded ? "chat.fileCard.collapse" : "chat.fileCard.allFiles", {
            values: { count: files.length },
          })}
          {expanded ? (
            <ChevronUp size={14} aria-hidden="true" />
          ) : (
            <ChevronDown size={14} aria-hidden="true" />
          )}
        </button>
      ) : null}
      {coverage.length > 0 ? (
        <details className="conversation-files-card-coverage">
          <summary>
            {t(limited ? "chat.fileCard.partial" : "chat.fileCard.scoped")}
          </summary>
          <ul>
            {coverage.map((record, index) => (
              <li key={`${record.timestamp}-${index}`}>
                <span>
                  {record.source} · {record.coverage} ·{" "}
                  {record.subAgentName ?? record.agent}
                </span>
                {record.reasons.length ? (
                  <span> · {record.reasons.join(", ")}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {hasLegacy ? (
        <div className="conversation-files-card-subtitle">
          {t("chat.fileCard.legacy")}
        </div>
      ) : null}
    </section>
  );
};
