import { ArrowUp, Loader2, Square } from "lucide-react";
import type { ChatInputViewProps } from "./types";

type ChatInputActionButtonsProps = Pick<
  ChatInputViewProps,
  | "value"
  | "isStreaming"
  | "isAborting"
  | "isCompacting"
  | "apiConfigs"
  | "runtimeApiConfig"
  | "handleAbort"
  | "handleSend"
>;

export const ChatInputActionButtons = ({
  value,
  isStreaming,
  isAborting,
  isCompacting,
  apiConfigs,
  runtimeApiConfig,
  handleAbort,
  handleSend,
}: ChatInputActionButtonsProps): React.JSX.Element => (
  <div className="input-action-buttons">
    {(isStreaming || isAborting) && (
      <button
        className={`abort-btn ${isAborting ? "is-aborting" : ""}`}
        aria-label={isAborting ? "Stopping generation" : "Stop generating"}
        title={isAborting ? "Stopping generation" : "Stop generating"}
        onClick={handleAbort}
        disabled={isAborting}
        type="button"
      >
        {isAborting ? (
          <Loader2 size={14} className="spin" />
        ) : (
          <Square size={14} fill="currentColor" />
        )}
      </button>
    )}
    <button
      className="send-btn"
      aria-label="Send"
      title="Send"
      onClick={handleSend}
      disabled={
        !value.trim() ||
        isCompacting ||
        apiConfigs.length === 0 ||
        !runtimeApiConfig
      }
      type="button"
    >
      <ArrowUp size={16} />
    </button>
  </div>
);
