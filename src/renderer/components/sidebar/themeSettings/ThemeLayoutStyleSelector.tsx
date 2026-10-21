import { useI18n } from "../../../i18n";
import type { ThemeLayoutStyle } from "./types";

type ThemeLayoutStyleSelectorProps = {
  layoutStyle: ThemeLayoutStyle;
  disabled?: boolean;
  onChange: (style: ThemeLayoutStyle) => void;
};

const STYLE_OPTIONS: {
  value: ThemeLayoutStyle;
  labelKey: string;
  defaultLabel: string;
}[] = [
  {
    value: "island",
    labelKey: "settings.themeLayoutStyleIsland",
    defaultLabel: "Island",
  },
  {
    value: "layered",
    labelKey: "settings.themeLayoutStyleLayered",
    defaultLabel: "Layered",
  },
  {
    value: "flush",
    labelKey: "settings.themeLayoutStyleFlush",
    defaultLabel: "Flush",
  },
];

/** 孤岛：三段独立卡片，之间留出背景间隙。 */
function IslandThumbnail(): React.JSX.Element {
  return (
    <svg
      width="48"
      height="32"
      viewBox="0 0 48 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect
        x="0.5"
        y="0.5"
        width="47"
        height="31"
        rx="3.5"
        fill="var(--app-bg)"
        stroke="var(--border-color)"
      />
      <rect
        x="4"
        y="6"
        width="9"
        height="20"
        rx="2"
        fill="var(--bg-secondary)"
        stroke="var(--border-color)"
        strokeWidth="0.5"
      />
      <rect
        x="16.5"
        y="6"
        width="18"
        height="20"
        rx="2"
        fill="var(--bg-primary)"
        stroke="var(--border-color)"
        strokeWidth="0.5"
      />
      <rect
        x="37.5"
        y="6"
        width="6"
        height="20"
        rx="2"
        fill="var(--bg-secondary)"
        stroke="var(--border-color)"
        strokeWidth="0.5"
      />
    </svg>
  );
}

/** 层叠：侧栏融入背景，主区覆盖侧栏，右面板再覆盖主区。 */
function LayeredThumbnail(): React.JSX.Element {
  return (
    <svg
      width="48"
      height="32"
      viewBox="0 0 48 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect
        x="0.5"
        y="0.5"
        width="47"
        height="31"
        rx="3.5"
        fill="var(--app-bg)"
        stroke="var(--border-color)"
      />
      <rect
        x="5"
        y="5"
        width="26"
        height="22"
        rx="3"
        fill="var(--bg-primary)"
        stroke="var(--border-color)"
        strokeWidth="0.5"
      />
      <rect
        x="27"
        y="5"
        width="16"
        height="22"
        rx="3"
        fill="var(--bg-secondary)"
        stroke="var(--border-color)"
        strokeWidth="0.5"
      />
    </svg>
  );
}

/** 平铺：贴边铺满，仅用细线分隔。 */
function FlushThumbnail(): React.JSX.Element {
  return (
    <svg
      width="48"
      height="32"
      viewBox="0 0 48 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <rect
        x="0.5"
        y="0.5"
        width="47"
        height="31"
        rx="3.5"
        fill="var(--bg-primary)"
        stroke="var(--border-color)"
      />
      <path d="M1 6.5H47" stroke="var(--border-color)" strokeWidth="0.5" />
      <path d="M1 7H12V31H4A3 3 0 0 1 1 28Z" fill="var(--bg-secondary)" />
      <path d="M36 7H47V28A3 3 0 0 1 44 31H36Z" fill="var(--bg-secondary)" />
      <path d="M12 6.5V31" stroke="var(--border-color)" strokeWidth="0.5" />
      <path d="M36 6.5V31" stroke="var(--border-color)" strokeWidth="0.5" />
    </svg>
  );
}

const THUMBNAILS: Record<ThemeLayoutStyle, () => React.JSX.Element> = {
  island: IslandThumbnail,
  layered: LayeredThumbnail,
  flush: FlushThumbnail,
};

export function ThemeLayoutStyleSelector({
  layoutStyle,
  disabled,
  onChange,
}: ThemeLayoutStyleSelectorProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="theme-mode-selector" role="radiogroup">
      {STYLE_OPTIONS.map((option) => {
        const isActive = layoutStyle === option.value;
        const Thumbnail = THUMBNAILS[option.value];
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            className={`theme-mode-option ${isActive ? "active" : ""}`}
            onClick={() => onChange(option.value)}
            disabled={disabled}
          >
            <Thumbnail />
            <span>
              {t(option.labelKey, { defaultValue: option.defaultLabel })}
            </span>
          </button>
        );
      })}
    </div>
  );
}
