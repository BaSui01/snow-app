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
   * 3s→6s→12s→24s→30s 的指数退避或档案配置的固定间隔，用户只能盲等，
   * 不知道还要多久。
   */
  backoffMs?: number | null;
  /**
   * 本轮退避的起始时刻（epoch ms），由消息状态携带。切换会话会让重试提示重新
   * 挂载，以它为基准计算剩余时间，倒计时才不会从头重新开始。
   */
  backoffStartedAt?: number | null;
};

export const StreamRetryNotice = ({
  attempt,
  error,
  status = "retrying",
  backoffMs,
  backoffStartedAt,
}: StreamRetryNoticeProps): React.JSX.Element => {
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = useState(false);
  const errorText = error?.trim() ?? "";
  const isExhausted = status === "exhausted";

  // 倒计时基准：每轮重试由消息携带一个退避起始时刻（backoffStartedAt）。依赖
  // 必须同时含 attempt 与 backoffMs —— 固定间隔配置下每轮重试的 backoffMs
  // 完全相同，只依赖它会让倒计时在首轮归零后永远停在 0s；而同一轮重试内后端
  // 可能重发分片，此时这些值都不变，因此不会打断正在走的倒计时。
  const hasCountdown =
    !isExhausted && typeof backoffMs === "number" && backoffMs > 0;
  const [remainingSec, setRemainingSec] = useState<number | null>(null);

  useEffect(() => {
    if (!hasCountdown) {
      setRemainingSec(null);
      return;
    }
    const totalMs = backoffMs as number;
    // 以记录的起始时刻为基准：切换会话导致重试提示重新挂载时按剩余时间续算，
    // 而不是把整段退避重新数一遍。
    const startedAt =
      typeof backoffStartedAt === "number" ? backoffStartedAt : Date.now();
    const end = startedAt + totalMs;
    const initialLeft = end - Date.now();
    setRemainingSec(initialLeft > 0 ? Math.ceil(initialLeft / 1000) : 0);
    if (initialLeft <= 0) {
      return;
    }
    // 200ms 刷新；归零后进入等待响应阶段，停止空转的倒计时。
    const timer = window.setInterval(() => {
      const left = end - Date.now();
      setRemainingSec(left > 0 ? Math.ceil(left / 1000) : 0);
      if (left <= 0) {
        window.clearInterval(timer);
      }
    }, 200);
    return () => window.clearInterval(timer);
  }, [hasCountdown, backoffMs, attempt, backoffStartedAt]);

  const isWaiting = hasCountdown && remainingSec !== null && remainingSec > 0;
  const isUrgent = isWaiting && remainingSec <= 3;

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
        <span className="stream-retry-notice-title" role="status">
          {isExhausted
            ? t("chat.retryExhausted", { defaultValue: "Retries exhausted" })
            : isWaiting
              ? t("chat.retryWaiting", { defaultValue: "Waiting to retry" })
              : t("chat.retrying", { defaultValue: "Retrying" })}
          {attempt != null ? (
            <span className="stream-retry-notice-attempt">({attempt})</span>
          ) : null}
        </span>
        {!isExhausted ? (
          <span
            className={`stream-retry-notice-countdown${
              isUrgent ? " stream-retry-notice-countdown-urgent" : ""
            }`}
            title={
              isWaiting
                ? t("chat.retryCountdownHint", {
                    defaultValue: "Waiting before the next attempt",
                  })
                : t("chat.retryAwaitingResponseHint", {
                    defaultValue:
                      "Retry in progress, waiting for the upstream response",
                  })
            }
          >
            {isWaiting
              ? t("chat.retryCountdown", {
                  defaultValue: "in {{seconds}}s",
                  values: { seconds: remainingSec },
                })
              : t("chat.retryAwaitingResponse", {
                  defaultValue: "Awaiting response",
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
