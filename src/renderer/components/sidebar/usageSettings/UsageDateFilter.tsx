import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useI18n } from "../../../i18n";
import type { UsageDateFilterProps, UsageDatePreset } from "./types";

type PresetOption = {
  value: UsageDatePreset;
  labelKey: string;
  defaultValue: string;
};

const PRESET_OPTIONS: PresetOption[] = [
  { value: "today", labelKey: "settings.usagePresetToday", defaultValue: "Today" },
  { value: "yesterday", labelKey: "settings.usagePresetYesterday", defaultValue: "Yesterday" },
  { value: "last7days", labelKey: "settings.usagePresetLast7Days", defaultValue: "Last 7 days" },
  { value: "last30days", labelKey: "settings.usagePresetLast30Days", defaultValue: "Last 30 days" },
  { value: "thisMonth", labelKey: "settings.usagePresetThisMonth", defaultValue: "This month" },
  { value: "lastMonth", labelKey: "settings.usagePresetLastMonth", defaultValue: "Last month" },
  { value: "all", labelKey: "settings.usagePresetAll", defaultValue: "All time" },
  { value: "custom", labelKey: "settings.usagePresetCustom", defaultValue: "Custom" },
];

export function UsageDateFilter({
  preset,
  sinceDate,
  untilDate,
  onPresetChange,
  onSinceDateChange,
  onUntilDateChange,
}: UsageDateFilterProps): React.JSX.Element {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        containerRef.current?.contains(target) ||
        dropdownRef.current?.contains(target)
      ) {
        return;
      }
      setIsOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const options = useMemo(
    () =>
      PRESET_OPTIONS.map((opt) => ({
        value: opt.value,
        label: t(opt.labelKey, { defaultValue: opt.defaultValue }),
      })),
    [t]
  );

  const selectedOption = options.find((opt) => opt.value === preset);
  const displayLabel = selectedOption?.label ?? preset;

  const handleTriggerClick = useCallback(() => {
    setIsOpen((v) => !v);
  }, []);

  const handleSelect = useCallback(
    (value: UsageDatePreset) => {
      setIsOpen(false);
      onPresetChange(value);
    },
    [onPresetChange]
  );

  const handleSinceChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onSinceDateChange(e.target.value);
    },
    [onSinceDateChange]
  );

  const handleUntilChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      onUntilDateChange(e.target.value);
    },
    [onUntilDateChange]
  );

  return (
    <div className="usage-date-filter-bar">
      <span className="usage-date-filter-label">
        {t("settings.usageDateFilter", { defaultValue: "Date range" })}
      </span>
      <div className="usage-date-preset-select" ref={containerRef}>
        <button
          type="button"
          className="usage-date-preset-trigger"
          onClick={handleTriggerClick}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
        >
          <span className="usage-date-preset-label" title={displayLabel}>
            {displayLabel}
          </span>
          <ChevronDown size={14} />
        </button>
        {isOpen && (
          <div className="usage-date-preset-dropdown" ref={dropdownRef} role="listbox">
            {options.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`usage-date-preset-item${
                  opt.value === preset ? " selected" : ""
                }`}
                onClick={() => handleSelect(opt.value)}
                role="option"
                aria-selected={opt.value === preset}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <input
        type="date"
        value={sinceDate}
        onChange={handleSinceChange}
        disabled={preset === "all"}
        className="usage-date-input"
        aria-label={t("settings.usageSinceDate", { defaultValue: "Start date" })}
      />
      <span className="usage-date-separator">-</span>
      <input
        type="date"
        value={untilDate}
        onChange={handleUntilChange}
        disabled={preset === "all"}
        className="usage-date-input"
        aria-label={t("settings.usageUntilDate", { defaultValue: "End date" })}
      />
    </div>
  );
}
