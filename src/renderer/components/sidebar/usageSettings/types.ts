export type UsageDatePreset =
  | "today"
  | "yesterday"
  | "last7days"
  | "last30days"
  | "thisMonth"
  | "lastMonth"
  | "all"
  | "custom";

export type UsageDateFilterProps = {
  preset: UsageDatePreset;
  sinceDate: string;
  untilDate: string;
  onPresetChange: (preset: UsageDatePreset) => void;
  onSinceDateChange: (value: string) => void;
  onUntilDateChange: (value: string) => void;
};

export type UsageSettingsPanelProps = {
  onClose?: () => void;
};
