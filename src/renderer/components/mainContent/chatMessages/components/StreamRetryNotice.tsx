import { ChevronDown, ChevronUp, Loader2, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
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
  /**
   * 本次重试前的退避时长（毫秒）。由后端随重试分片下发，与 `wait_before_retry`
   * 的实际等待时间同源。给出时渲染「N 秒后重试」实时倒计时——否则面对
   * 3s→6s→12s→24s→30s 的指数退避，用户只能盲等，不知道还要多久。
   */
  backoffMs?: number | null;
};

export const StreamRetryNotice = ({
  attempt,
  error,
  status = "retrying",
  backoffMs,
}: StreamRetryNoticeProps): React.JSX.Element => {
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = useState(false);
  const errorText = error?.trim() ?? "";
  const isExhausted = status === "exhausted";

  // 倒计时基准：每次拿到新的退避时长就重设一次。后端可能在同一次退避期间
  // 重发分片，这里用 backoffMs 本身作为依赖，重复值不会打断倒计时节奏。
  const hasCountdown =
    !isExhausted && typeof backoffMs === "number" && backoffMs > 0;
  const [remainingSec, setRemainingSec] = useState<number | null>(null);

  useEffect(() => {
    if (!hasCountdown) {
      setRemainingSec(null);
      return;
    }
    const totalMs = backoffMs as number;
    const end = Date.now() + totalMs;
    setRemainingSec(Math.ceil(totalMs / 1000));
    // 200ms 刷新：与 Bash/Terminal 工具卡片的倒计时节奏保持一致。
    const timer = window.setInterval(() => {
      const left = end - Date.now();
      setRemainingSec(left > 0 ? Math.ceil(left / 1000) : 0);
    }, 200);
    return () => window.clearInterval(timer);
  }, [hasCountdown, backoffMs]);

  const isUrgent = remainingSec !== null && remainingSec <= 3;

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
        {remainingSec !== null ? (
          <span
            className={`stream-retry-notice-countdown${
              isUrgent ? " stream-retry-notice-countdown-urgent" : ""
            }`}
            title={t("chat.retryCountdownHint", {
              defaultValue: "Waiting before the next attempt",
            })}
          >
            {t("chat.retryCountdown", {
              defaultValue: "in {{seconds}}s",
              values: { seconds: remainingSec },
            })}
          </span>
        ) : null}
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
