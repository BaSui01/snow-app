import { ChevronDown, ChevronUp, TriangleAlert } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { useI18n } from "../../../../i18n";
import { HoverCopyButton } from "../../../common/HoverCopyButton";
import { parseErrorNotice } from "../utils/errorNotice";

export type AiErrorNoticeProps = {
  message: string;
};

export const AiErrorNotice = memo(
  ({ message }: AiErrorNoticeProps): React.JSX.Element => {
    const { t } = useI18n();
    const [showDetail, setShowDetail] = useState(false);
    const parsed = useMemo(() => parseErrorNotice(message), [message]);

    return (
      <div className="ai-error-notice" role="alert">
        <div className="ai-error-notice-header">
          <TriangleAlert
            aria-hidden="true"
            className="ai-error-notice-icon"
            size={16}
            strokeWidth={1.8}
          />
          <strong className="ai-error-notice-title">
            {t("chat.error.title")}
          </strong>
          {parsed.statusLabel ? (
            <span className="ai-error-notice-status">{parsed.statusLabel}</span>
          ) : null}
        </div>
        {parsed.summary ? (
          <p className="ai-error-notice-summary">{parsed.summary}</p>
        ) : null}
        {parsed.detail ? (
          <>
            <button
              type="button"
              className="ai-error-notice-toggle"
              onClick={() => setShowDetail((previous) => !previous)}
            >
              {showDetail ? (
                <ChevronUp aria-hidden="true" size={12} />
              ) : (
                <ChevronDown aria-hidden="true" size={12} />
              )}
              <span>
                {showDetail
                  ? t("chat.error.hideDetail")
                  : t("chat.error.showDetail")}
              </span>
            </button>
            {showDetail ? (
              <div className="ai-error-notice-detail">
                <span className="ai-error-notice-detail-text">
                  {parsed.detail}
                </span>
                <HoverCopyButton
                  className="ai-error-notice-detail-copy"
                  label={t("chat.retryCopyDetails", {
                    defaultValue: "Copy error details",
                  })}
                  text={parsed.detail}
                />
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    );
  },
);

AiErrorNotice.displayName = "AiErrorNotice";
