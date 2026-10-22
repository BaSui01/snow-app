import { CheckCircle2, Hourglass, Undo2 } from "lucide-react";
import { useI18n } from "../../../../i18n";
import { useSubAgentMessageRecord } from "../hooks/subAgentMessageStatus";

export const formatQueuedTime = (time: number): string =>
  new Date(time).toLocaleTimeString([], { hour12: false });

type SubAgentMessageDeliveryProps = {
  messageId?: string;
  queuedAt?: number;
};

/** 通信送达状态：pending / delivered / withdrawn；无记录时（重启后）仅显示已排队。 */
export const SubAgentMessageDelivery = ({
  messageId,
  queuedAt,
}: SubAgentMessageDeliveryProps): React.JSX.Element => {
  const { t } = useI18n();
  const record = useSubAgentMessageRecord(messageId);
  const status = record?.status;
  const time = queuedAt ?? record?.queuedAt;

  const icon =
    status === "pending" ? (
      <Hourglass size={12} aria-hidden="true" />
    ) : status === "withdrawn" ? (
      <Undo2 size={12} aria-hidden="true" />
    ) : (
      <CheckCircle2 size={12} aria-hidden="true" />
    );
  const label =
    status === "pending"
      ? t("toolCall.subAgentComms.pending")
      : status === "delivered"
        ? t("toolCall.subAgentComms.delivered")
        : status === "withdrawn"
          ? t("toolCall.subAgentComms.withdrawn")
          : t("toolCall.subAgent.queued");

  return (
    <div className={`tool-call-sub-agent-queued is-${status ?? "unknown"}`}>
      {icon}
      <span>{label}</span>
      {time ? (
        <span className="tool-call-sub-agent-queued-time">
          {t("toolCall.subAgentComms.queuedAt", {
            values: { time: formatQueuedTime(time) },
          })}
        </span>
      ) : null}
    </div>
  );
};
