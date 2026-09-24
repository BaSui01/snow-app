import { Clock3 } from "lucide-react";
import { useMessageTimeVisible } from "../utils/messageTimeVisibility";
import { Tooltip } from "../../../common/Tooltip";

type MessageTimestampProps = {
  timestamp?: string;
  className?: string;
};

const CLOCK_PATTERN = /^\d{1,2}:\d{2}(:\d{2})?$/;

const pad2 = (value: number): string => String(value).padStart(2, "0");

const parseTimestamp = (
  value: string,
): { label: string; title: string } | null => {
  const text = value.trim();
  if (!text) {
    return null;
  }
  if (CLOCK_PATTERN.test(text)) {
    return { label: text, title: text };
  }
  const normalized = text.includes("T") ? text : text.replace(" ", "T");
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return { label: text, title: text };
  }
  return {
    label: `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(
      date.getSeconds(),
    )}`,
    title: date.toLocaleString(),
  };
};

export const MessageTimestamp = ({
  timestamp,
  className,
}: MessageTimestampProps): React.JSX.Element | null => {
  const visible = useMessageTimeVisible();
  if (!visible || !timestamp) {
    return null;
  }
  const parsed = parseTimestamp(timestamp);
  if (!parsed) {
    return null;
  }
  return (
    <Tooltip content={parsed.title}>
      <span className={`message-time${className ? ` ${className}` : ""}`}>
        <Clock3 size={11} strokeWidth={1.8} aria-hidden="true" />
        <span className="message-time-value">{parsed.label}</span>
      </span>
    </Tooltip>
  );
};
