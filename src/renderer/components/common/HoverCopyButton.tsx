import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";

type HoverCopyButtonProps = {
  text: string;
  className?: string;
};

export const HoverCopyButton = ({
  text,
  className,
}: HoverCopyButtonProps): React.JSX.Element => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    },
    [],
  );

  const handleCopy = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation();
    navigator.clipboard
      .writeText(text)
      .then(() => {
        if (timerRef.current) {
          clearTimeout(timerRef.current);
        }
        setCopied(true);
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          setCopied(false);
        }, 1600);
      })
      .catch(() => undefined);
  };

  const label = copied
    ? t("common.copied", { defaultValue: "已复制" })
    : t("common.copyReviewPrompt", { defaultValue: "复制审查提示词" });

  return (
    <button
      type="button"
      className={`hover-copy-button${copied ? " copied" : ""}${
        className ? ` ${className}` : ""
      }`}
      onClick={handleCopy}
      title={label}
      aria-label={label}
    >
      {copied ? (
        <Check size={13} strokeWidth={1.8} />
      ) : (
        <Copy size={13} strokeWidth={1.8} />
      )}
    </button>
  );
};