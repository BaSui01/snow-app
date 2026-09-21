import { useId, type CSSProperties, type ReactNode } from "react";

type RangeSliderProps = {
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  /** 顶部左侧说明文字；省略时标题行只显示数值。 */
  label?: ReactNode;
  /** 标题行内、数值左侧的附加控件（如开关），用于把开关并入滑块标题行。 */
  headerAside?: ReactNode;
  /** 顶部右侧数值格式化函数（如 `(v) => `${v}%``）；省略时不显示数值。 */
  formatValue?: (value: number) => string;
  /** 无可见 label 时的无障碍名称。 */
  ariaLabel?: string;
  /** 追加到根节点的类名，用于按场景覆写 `--range-*` 变量（如强调色）。 */
  className?: string;
  /** 拖动过程中持续触发，取值为数字。 */
  onChange: (value: number) => void;
  /** 松开鼠标（pointerup）或按键（keyup）后触发一次，用于拖动结束统一提交。 */
  onCommit?: () => void;
};

/**
 * 全应用统一的 range 滑块控件。
 *
 * 结构：可选的标题行（说明文字 + 附加控件 + 数值）+ 轨道滑块。外观由 styles.css
 * 中的 `.range-slider` 一组 `--range-*` CSS 变量控制，主题预设只需覆写变量
 * （轨道高度/圆角/颜色、滑块尺寸/形状）即可适配，无需重写组件。
 */
export function RangeSlider({
  value,
  min,
  max,
  step,
  disabled,
  label,
  headerAside,
  formatValue,
  ariaLabel,
  className,
  onChange,
  onCommit,
}: RangeSliderProps): React.JSX.Element {
  const inputId = useId();
  const ratio =
    max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
  const progress = `${ratio * 100}%`;

  return (
    <div className={className ? `range-slider ${className}` : "range-slider"}>
      {(label != null || headerAside != null || formatValue != null) && (
        <div className="range-slider-head">
          {label != null && (
            <label className="range-slider-label" htmlFor={inputId}>
              {label}
            </label>
          )}
          {headerAside}
          {formatValue != null && (
            <span className="range-slider-value">{formatValue(value)}</span>
          )}
        </div>
      )}
      <input
        id={inputId}
        className="range-slider-input"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        style={{ "--range-progress": progress } as CSSProperties}
        onChange={(event) => onChange(Number.parseFloat(event.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
      />
    </div>
  );
}
