import { Sparkles } from "lucide-react";
import { useCallback } from "react";

type PluginCreateBoxProps = {
  value: string;
  placeholder: string;
  submitLabel: string;
  autoFocus?: boolean;
  className?: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
};

export const PluginCreateBox = ({
  value,
  placeholder,
  submitLabel,
  autoFocus = false,
  className,
  onChange,
  onSubmit,
}: PluginCreateBoxProps): React.JSX.Element => {
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== "Enter" || event.shiftKey) {
        return;
      }
      const nativeEvent = event.nativeEvent as unknown as {
        isComposing?: boolean;
        keyCode?: number;
      };
      if (nativeEvent.isComposing || nativeEvent.keyCode === 229) {
        return;
      }
      event.preventDefault();
      onSubmit();
    },
    [onSubmit],
  );

  return (
    <div className={`plugins-create${className ? ` ${className}` : ""}`}>
      <textarea
        autoFocus={autoFocus}
        className="plugins-create-input"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="plugins-create-actions">
        <button
          className="plugins-toolbar-btn primary"
          disabled={value.trim().length === 0}
          type="button"
          onClick={onSubmit}
        >
          <Sparkles size={14} strokeWidth={1.8} />
          <span>{submitLabel}</span>
        </button>
      </div>
    </div>
  );
};
