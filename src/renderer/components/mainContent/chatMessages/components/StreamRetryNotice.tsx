import { ChevronDown, ChevronUp, Loader2 } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../../../i18n";
import { HoverCopyButton } from "../../../common/HoverCopyButton";

export type StreamRetryNoticeProps = {
  attempt?: number;
  error?: string;
};

export const StreamRetryNotice = ({
  attempt,
  error,
}: StreamRetryNoticeProps): React.JSX.Element => {
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = useState(false);
  const errorText = error?.trim() ?? "";

  return (
    <div className="stream-retry-notice">
      <div className="stream-retry-notice-header">
        <Loader2
          aria-hidden="true"
          className="stream-retry-notice-icon spin"
          size={13}
        />
        <span className="stream-retry-notice-title">
          {t("chat.retrying", { defaultValue: "Retrying" })}
          {attempt != null ? (
            <span className="stream-retry-notice-attempt">({attempt})</span>
          ) : null}
        </span>
        {errorText ? (
          <>
            {isExpanded ? null : (
              <span className="stream-retry-notice-preview" title={errorText}>
                {errorText}
              </span>
            )}
            <button
              type="button"
              className="stream-retry-notice-toggle"
              aria-expanded={isExpanded}
              onClick={() => setIsExpanded((previous) => !previous)}
            >
              <span>
                {isExpanded
                  ? t("chat.retryDetailsHide", { defaultValue: "Hide details" })
                  : t("chat.retryDetailsShow", {
                      defaultValue: "Error details",
                    })}
              </span>
              {isExpanded ? (
                <ChevronUp aria-hidden="true" size={12} />
              ) : (
                <ChevronDown aria-hidden="true" size={12} />
              )}
            </button>
          </>
        ) : null}
      </div>
      {isExpanded && errorText ? (
        <div className="stream-retry-notice-error">
          <span className="stream-retry-notice-error-text">{errorText}</span>
          <HoverCopyButton
            className="stream-retry-notice-error-copy"
            label={t("chat.retryCopyDetails", {
              defaultValue: "Copy error details",
            })}
            text={errorText}
          />
        </div>
      ) : null}
    </div>
  );
};
