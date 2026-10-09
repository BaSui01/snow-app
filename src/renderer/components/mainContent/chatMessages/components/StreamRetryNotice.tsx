import { ChevronDown, ChevronUp, Loader2, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../../../../i18n";
import { HoverCopyButton } from "../../../common/HoverCopyButton";

export type StreamRetryNoticeProps = {
  attempt?: number;
  error?: string;
  /**
   * 提示形态：`retrying` = 重试进行中（转圈 + 「重试中 (N)」）；
   * `exhausted` = 重试预算已耗尽（静态告警图标 + 「重试已耗尽」）。
   *
   * 终态复用同一条 UI（样式/错误详情/复制按钮完全一致），让「上游连续返回空响应」
   * 这类结果与重试过程共享同一处可观测提示，而不是各写一套。
   */
  status?: "retrying" | "exhausted";
};

export const StreamRetryNotice = ({
  attempt,
  error,
  status = "retrying",
}: StreamRetryNoticeProps): React.JSX.Element => {
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = useState(false);
  const errorText = error?.trim() ?? "";
  const isExhausted = status === "exhausted";

  return (
    <div className="stream-retry-notice">
      <div className="stream-retry-notice-header">
        {isExhausted ? (
          <TriangleAlert
            aria-hidden="true"
            className="stream-retry-notice-icon"
            size={13}
          />
        ) : (
          <Loader2
            aria-hidden="true"
            className="stream-retry-notice-icon spin"
            size={13}
          />
        )}
        <span className="stream-retry-notice-title">
          {isExhausted
            ? t("chat.retryExhausted", { defaultValue: "Retries exhausted" })
            : t("chat.retrying", { defaultValue: "Retrying" })}
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
