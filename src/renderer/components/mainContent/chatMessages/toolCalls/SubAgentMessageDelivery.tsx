import { Hourglass } from "lucide-react";
import { useI18n } from "../../../../i18n";

export const formatQueuedTime = (time: number): string =>
  new Date(time).toLocaleTimeString([], { hour12: false });

type SubAgentMessageDeliveryProps = {
  messageId?: string;
  queuedAt?: number;
};

/** The durable receipt proves queuing only, never delivery or understanding. */
export const SubAgentMessageDelivery = ({
  messageId,
  queuedAt,
}: SubAgentMessageDeliveryProps): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <div className="tool-call-sub-agent-queued is-pending" title={messageId}>
      <Hourglass size={12} aria-hidden="true" />
      <span>{t("toolCall.subAgent.queued")}</span>
      {queuedAt ? (
        <span className="tool-call-sub-agent-queued-time">
          {t("toolCall.subAgentComms.queuedAt", {
            values: { time: formatQueuedTime(queuedAt) },
          })}
        </span>
      ) : null}
    </div>
  );
};
