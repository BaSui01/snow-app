import { useState } from "react";
import { Check, Copy, Loader2, Pencil, Undo2 } from "lucide-react";
import { writeBackToChatInput } from "../../chatInput/chatInputDraftBridge";
type UserMessageActionsProps = {
  content: string;
  isStreaming: boolean;
  canRollback?: boolean;
  isRollbackPreparing?: boolean;
  onRollback: () => void;
};

export const UserMessageActions = ({
  content,
  isStreaming,
  canRollback = true,
  isRollbackPreparing,
  onRollback,
}: UserMessageActionsProps): React.JSX.Element => {
  const [copied, setCopied] = useState(false);

  const [editWritten, setEditWritten] = useState(false);

  const handleCopy = (): void => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  };

  const handleEdit = (): void => {
    const written = writeBackToChatInput(content);
    if (written) {
      setEditWritten(true);
      window.setTimeout(() => setEditWritten(false), 2000);
    }
  };

  return (
    <div className="user-message-actions" aria-label="User message actions">
      <button
        className="user-message-action-btn"
        type="button"
        aria-label="Copy user message"
        onClick={handleCopy}
      >
        {copied ? (
          <Check size={15} strokeWidth={1.8} />
        ) : (
          <Copy size={15} strokeWidth={1.8} />
        )}
      </button>
      <button
        className="user-message-action-btn"
        type="button"
        aria-label="Edit message in input"
        title={editWritten ? "Written back to input" : "Edit in input box"}
        onClick={handleEdit}
      >
        {editWritten ? (
          <Check size={15} strokeWidth={1.8} />
        ) : (
          <Pencil size={15} strokeWidth={1.8} />
        )}
      </button>
      {canRollback && !isStreaming ? (
        <button
          className="user-message-action-btn"
          type="button"
          aria-label="Rollback to this message"
          title={
            isRollbackPreparing
              ? "Checking file changes…"
              : "Rollback to this message"
          }
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
  );
};
