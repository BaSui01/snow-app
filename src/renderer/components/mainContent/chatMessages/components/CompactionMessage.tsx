import { memo, useState } from "react";
import { ChevronDown, Loader2, Minimize2, Undo2 } from "lucide-react";
import { useI18n } from "../../../../i18n";
import { Tooltip } from "../../../common/Tooltip";
import { MarkdownBlock } from "./markdownRenderer";
import { MessageCopyButton } from "./MessageCopyButton";

type CompactionMessageProps = {
  content: string;
  isStreaming: boolean;
  canRollback?: boolean;
  isRollbackPreparing?: boolean;
  onRollback: () => void;
};

export const CompactionMessage = memo(
  ({
    content,
    isStreaming,
    canRollback = true,
    isRollbackPreparing,
    onRollback,
  }: CompactionMessageProps): React.JSX.Element => {
    const { t } = useI18n();
    const [isExpanded, setIsExpanded] = useState(false);
    const toggleLabel = isExpanded
      ? t("chat.compactionCollapse")
      : t("chat.compactionExpand");

    return (
      <article
        className={`context-compaction-message${
          isExpanded ? " is-expanded" : ""
        }`}
      >
        <div className="context-compaction-message-bar">
          <span
            className="context-compaction-message-rule"
            aria-hidden="true"
          />
          <div className="context-compaction-message-cluster">
            <Tooltip content={t("chat.contextCompacted")}>
              <button
                className="context-compaction-message-toggle"
                type="button"
                aria-expanded={isExpanded}
                aria-label={toggleLabel}
                onClick={() => setIsExpanded((current) => !current)}
              >
                <Minimize2 size={13} strokeWidth={1.8} aria-hidden="true" />
                <span className="context-compaction-message-label">
                  {t("chat.compactionSummary")}
                </span>
                <ChevronDown
                  className="context-compaction-message-chevron"
                  size={13}
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
              </button>
            </Tooltip>
            <div className="context-compaction-message-actions">
              <MessageCopyButton
                content={content}
                className="context-compaction-message-action-btn"
              />
              {canRollback && !isStreaming ? (
                <button
                  className="context-compaction-message-action-btn"
                  type="button"
                  aria-label={t("chat.rollbackMessage")}
                  title={t("chat.rollbackMessage")}
                  disabled={isRollbackPreparing}
                  onClick={onRollback}
                >
                  {isRollbackPreparing ? (
                    <Loader2 size={15} strokeWidth={1.8} className="spin" />
                  ) : (
                    <Undo2 size={15} strokeWidth={1.8} />
                  )}
                </button>
              ) : null}
            </div>
          </div>
          <span
            className="context-compaction-message-rule"
            aria-hidden="true"
          />
        </div>
        {isExpanded ? (
          <div className="context-compaction-message-body">
            <MarkdownBlock
              className="context-compaction-markdown"
              content={content}
              streaming={isStreaming}
            />
          </div>
        ) : null}
      </article>
    );
  },
);

CompactionMessage.displayName = "CompactionMessage";
