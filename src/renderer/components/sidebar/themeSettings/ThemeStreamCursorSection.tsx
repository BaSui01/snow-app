import { FileUp, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import { CustomSelect } from "../../common/CustomSelect";
import { RangeSlider } from "../../common/RangeSlider";
import { STREAM_CURSOR_LUCIDE_ICONS } from "./streamCursorIcons";
import type { ThemeStreamCursor } from "./types";
import { themeBgUrl } from "../../../utils/themeBgUrl";

type ThemeStreamCursorSectionProps = {
  cursor: ThemeStreamCursor;
  disabled?: boolean;
  busy?: boolean;
  onChange: (cursor: ThemeStreamCursor) => void;
  onSelectSvg: () => Promise<void>;
  onRemoveSvg: () => Promise<void>;
};

export function ThemeStreamCursorSection({
  cursor,
  disabled,
  busy,
  onChange,
  onSelectSvg,
  onRemoveSvg,
}: ThemeStreamCursorSectionProps): React.JSX.Element {
  const { t } = useI18n();
  const isBusy = disabled || busy;

  // 本地 state 用于滑块拖动期间的即时 UI 响应，与 ThemeBackgroundSection 模式一致。
  const [localSize, setLocalSize] = useState(cursor.iconSize);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  useEffect(() => {
    setLocalSize(cursor.iconSize);
  }, [cursor.iconSize]);

  const commitSize = (): void => {
    const c = cursorRef.current;
    onChange({ ...c, iconSize: localSize });
  };

  const handleTypeChange = (iconType: string): void => {
    const resolved: ThemeStreamCursor["iconType"] =
      iconType === "lucide" || iconType === "custom" ? iconType : "dot";
    if (resolved === "dot") {
      onChange({
        iconType: "dot",
        lucideName: "",
        svgPath: "",
        iconSize: cursor.iconSize,
      });
    } else if (resolved === "lucide") {
      onChange({
        iconType: "lucide",
        lucideName: cursor.lucideName || STREAM_CURSOR_LUCIDE_ICONS[0].name,
        svgPath: "",
        iconSize: cursor.iconSize,
      });
    } else {
      onChange({
        iconType: "custom",
        lucideName: "",
        svgPath: cursor.svgPath,
        iconSize: cursor.iconSize,
      });
    }
  };

  const handleLucideSelect = (name: string): void => {
    onChange({
      iconType: "lucide",
      lucideName: name,
      svgPath: "",
      iconSize: cursor.iconSize,
    });
  };

  return (
    <div className="api-settings-form-section">
      <div className="api-settings-form-section-header">
        <strong className="api-settings-form-section-title">
          {t("settings.themeStreamCursorTitle", {
            defaultValue: "Streaming indicator",
          })}
        </strong>
      </div>
      <span className="settings-item-description">
        {t("settings.themeStreamCursorInfo", {
          defaultValue:
            "Customize the indicator shown while the AI is generating a response.",
        })}
      </span>

      <div className="theme-stream-cursor-type-select">
        <CustomSelect
          value={cursor.iconType}
          onChange={handleTypeChange}
          disabled={isBusy}
          options={[
            {
              value: "dot",
              label: t("settings.themeStreamCursorTypeDot", {
                defaultValue: "Pulsing dot",
              }),
            },
            {
              value: "lucide",
              label: t("settings.themeStreamCursorTypeLucide", {
                defaultValue: "Built-in icon",
              }),
            },
            {
              value: "custom",
              label: t("settings.themeStreamCursorTypeCustom", {
                defaultValue: "Custom SVG",
              }),
            },
          ]}
        />
      </div>

      {cursor.iconType === "lucide" && (
        <div className="theme-stream-cursor-icon-grid">
          {STREAM_CURSOR_LUCIDE_ICONS.map(({ name, Icon }) => (
            <button
              key={name}
              type="button"
              className={
                "theme-stream-cursor-icon-btn" +
                (cursor.lucideName === name ? " selected" : "")
              }
              onClick={() => handleLucideSelect(name)}
              disabled={isBusy}
              title={name}
            >
              <Icon size={18} strokeWidth={2} />
            </button>
          ))}
        </div>
      )}

      {cursor.iconType === "custom" && (
        <div className="api-settings-form-grid">
          <div className="theme-stream-cursor-preview">
            {cursor.svgPath ? (
              <img
                src={themeBgUrl(cursor.svgPath)}
                alt=""
                className="theme-stream-cursor-thumbnail"
              />
            ) : (
              <span className="theme-background-placeholder">
                <FileUp size={24} strokeWidth={1.6} />
              </span>
            )}
          </div>
          <div className="theme-background-actions">
            <button
              type="button"
              className="api-settings-form-btn secondary"
              onClick={() => void onSelectSvg()}
              disabled={isBusy}
            >
              <FileUp size={15} strokeWidth={1.8} />
              <span>
                {t("settings.themeStreamCursorSelectSvg", {
                  defaultValue: "Select SVG",
                })}
              </span>
            </button>
            {cursor.svgPath && (
              <button
                type="button"
                className="api-settings-form-btn secondary danger"
                onClick={() => void onRemoveSvg()}
                disabled={isBusy}
              >
                <Trash2 size={15} strokeWidth={1.8} />
                <span>
                  {t("settings.themeStreamCursorRemoveSvg", {
                    defaultValue: "Remove",
                  })}
                </span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* 尺寸滑块 + 实时预览 */}
      {cursor.iconType !== "dot" && (
        <>
          <div className="theme-stream-cursor-live-preview">
            {cursor.iconType === "lucide" &&
              (() => {
                const Icon = STREAM_CURSOR_LUCIDE_ICONS.find(
                  (i) => i.name === cursor.lucideName,
                )?.Icon;
                return Icon ? (
                  <Icon
                    size={localSize}
                    strokeWidth={2}
                    className="stream-cursor-lucide-icon"
                  />
                ) : null;
              })()}
            {cursor.iconType === "custom" && cursor.svgPath && (
              <span
                className="stream-cursor-custom-icon"
                style={{
                  width: `${localSize}px`,
                  height: `${localSize}px`,
                  backgroundImage: `url("${themeBgUrl(cursor.svgPath)}")`,
                }}
              />
            )}
          </div>
          <RangeSlider
            label={t("settings.themeStreamCursorSize", {
              defaultValue: "Icon size",
            })}
            formatValue={(value) => `${Math.round(value)}px`}
            value={localSize}
            min={8}
            max={48}
            step={1}
            disabled={isBusy}
            onChange={(value) => setLocalSize(value)}
            onCommit={commitSize}
          />
        </>
      )}
    </div>
  );
}
