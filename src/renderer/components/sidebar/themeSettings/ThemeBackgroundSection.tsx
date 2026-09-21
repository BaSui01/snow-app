import { ImageIcon, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../../../i18n";
import { RangeSlider } from "../../common/RangeSlider";
import type { ThemeBackground } from "./types";
import { MAX_BACKGROUND_OPACITY } from "./themeSettingsUtils";
import { themeBgUrl } from "../../../utils/themeBgUrl";

type ThemeBackgroundSectionProps = {
  background: ThemeBackground;
  disabled?: boolean;
  busy?: boolean;
  onChange: (background: ThemeBackground) => void;
  onSelectImage: () => Promise<void>;
  onRemoveImage: () => Promise<void>;
};

export function ThemeBackgroundSection({
  background,
  disabled,
  busy,
  onChange,
  onSelectImage,
  onRemoveImage,
}: ThemeBackgroundSectionProps): React.JSX.Element {
  const { t } = useI18n();
  const isBusy = disabled || busy;

  // 本地 state 用于滑块拖动期间的即时 UI 响应，拖动期间不触发父组件
  // setForm，避免预览 useEffect 全量重绘 + IPC 调用导致卡涩。
  // 仅在松开鼠标（onPointerUp）或松开按键（onKeyUp）时提交一次到父组件。
  const [localOpacity, setLocalOpacity] = useState(background.opacity);
  const [localBlur, setLocalBlur] = useState(background.blur);

  // ref 保存最新的 background 与本地滑块值，供 pointerup/keyup 回调构造提交值，
  // 避免闭包捕获旧值。range input 拖动时浏览器会自动 capture pointer 到该元素，
  // 因此即使鼠标移到 input 外松开，onPointerUp 仍会在该 input 上触发。
  const backgroundRef = useRef(background);
  const localOpacityRef = useRef(localOpacity);
  const localBlurRef = useRef(localBlur);
  backgroundRef.current = background;

  // 父组件 background 变化（如切换预设、删除图片、首次上传）时同步本地 state。
  useEffect(() => {
    setLocalOpacity(background.opacity);
    localOpacityRef.current = background.opacity;
  }, [background.opacity]);
  useEffect(() => {
    setLocalBlur(background.blur);
    localBlurRef.current = background.blur;
  }, [background.blur]);

  const updateField = <K extends keyof ThemeBackground>(
    field: K,
    value: ThemeBackground[K],
  ): void => {
    onChange({ ...background, [field]: value });
  };

  // 松开鼠标/按键时提交：同时带上两个滑块的最新本地值，避免连续拖动不同滑块时
  // 因 backgroundRef 尚未更新而把另一个滑块覆盖回旧值。
  const commitSliders = (): void => {
    onChange({
      ...backgroundRef.current,
      opacity: localOpacityRef.current,
      blur: localBlurRef.current,
    });
  };

  // 拖动期间直接更新对应 CSS 变量实现渐进预览，不走父组件 setForm → 预览 useEffect
  // 的完整链路（重绘整个 palette 几十个 CSS 变量 + IPC 调用），避免卡顿。
  // 松开时 commitSliders 提交到父组件，由其预览 useEffect 统一收尾。
  const previewOpacity = (value: number): void => {
    const root = document.documentElement;
    if (root.style.getPropertyValue("--theme-bg-image")) {
      root.style.setProperty("--theme-bg-opacity", String(value));
    }
  };

  const previewBlur = (value: number): void => {
    const root = document.documentElement;
    if (root.style.getPropertyValue("--theme-bg-image")) {
      root.style.setProperty("--theme-bg-blur", `${value}px`);
    }
  };

  const handleOpacityInput = (value: number): void => {
    setLocalOpacity(value);
    localOpacityRef.current = value;
    previewOpacity(value);
  };

  const handleBlurInput = (value: number): void => {
    setLocalBlur(value);
    localBlurRef.current = value;
    previewBlur(value);
  };

  return (
    <div className="api-settings-form-section">
      <div className="api-settings-form-section-header">
        <strong className="api-settings-form-section-title">
          {t("settings.themeBackgroundTitle", {
            defaultValue: "Background image",
          })}
        </strong>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={background.enabled}
            onChange={(event) => updateField("enabled", event.target.checked)}
            disabled={isBusy || !background.imagePath}
            hidden
          />
          <span className="toggle-slider" />
          <span>
            {background.enabled
              ? t("settings.enabled", { defaultValue: "Enabled" })
              : t("settings.disabled", { defaultValue: "Disabled" })}
          </span>
        </label>
      </div>
      <span className="settings-item-description">
        {t("settings.themeBackgroundInfo", {
          defaultValue:
            "Upload a custom background image and adjust its opacity and blur.",
        })}
      </span>
      <div className="api-settings-form-grid">
        <div className="theme-background-preview">
          {background.imagePath ? (
            <img
              src={themeBgUrl(background.imagePath)}
              alt=""
              className="theme-background-thumbnail"
            />
          ) : (
            <span className="theme-background-placeholder">
              <ImageIcon size={24} strokeWidth={1.6} />
            </span>
          )}
        </div>
        <div className="theme-background-actions">
          <button
            type="button"
            className="api-settings-form-btn secondary"
            onClick={() => void onSelectImage()}
            disabled={isBusy}
          >
            <ImageIcon size={15} strokeWidth={1.8} />
            <span>
              {t("settings.themeBackgroundSelect", {
                defaultValue: "Select image",
              })}
            </span>
          </button>
          {background.imagePath && (
            <button
              type="button"
              className="api-settings-form-btn secondary danger"
              onClick={() => void onRemoveImage()}
              disabled={isBusy}
            >
              <Trash2 size={15} strokeWidth={1.8} />
              <span>
                {t("settings.themeBackgroundRemove", {
                  defaultValue: "Remove",
                })}
              </span>
            </button>
          )}
        </div>
      </div>
      {background.imagePath && (
        <>
          <RangeSlider
            label={t("settings.themeBackgroundOpacity", {
              defaultValue: "Opacity",
            })}
            formatValue={(value) => `${Math.round(value * 100)}%`}
            value={localOpacity}
            min={0}
            max={MAX_BACKGROUND_OPACITY}
            step={0.01}
            disabled={isBusy}
            onChange={handleOpacityInput}
            onCommit={commitSliders}
          />
          <RangeSlider
            label={t("settings.themeBackgroundBlur", {
              defaultValue: "Blur",
            })}
            formatValue={(value) => `${Math.round(value)}px`}
            value={localBlur}
            min={0}
            max={100}
            step={1}
            disabled={isBusy}
            onChange={handleBlurInput}
            onCommit={commitSliders}
          />
        </>
      )}
    </div>
  );
}
