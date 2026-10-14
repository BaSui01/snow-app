/**
 * 生图模型的尺寸控件族（设置面板专用）。
 *
 * 从 `ImageGenSettingsPanel.tsx` 抽出：宽高比图示、尺寸预设选项与
 * Gemini / OpenAI 两套尺寸组合控件（比例 × 档位 × 自定义输入）。
 * 这些组件不持有面板状态，只通过 props 回调上抛尺寸字符串，
 * 因此可独立成模块，让设置面板专注于渠道/模型的增删改逻辑。
 */

import type { CustomSelectOption } from "../../common/CustomSelect";
import { CustomSelect } from "../../common/CustomSelect";
import {
  GEMINI_ASPECT_RATIOS,
  OPENAI_SIZE_PRESETS,
  OPENAI_SIZE_TIERS,
  buildGeminiSize,
  getGeminiSizePresets,
  matchGeminiSizePreset,
  matchOpenAISizePreset,
} from "./constants";

/** 宽高比下拉选项：小矩形图示 + 比例文本。 */
const RatioDiagram = ({ ratio }: { ratio: string }): React.JSX.Element => {
  const [width, height] = ratio.split(":").map(Number);
  const scale = 6;
  const isPortrait = height > width;
  return (
    <span className="imagegen-ratio-option">
      <span
        className={`imagegen-ratio-box${isPortrait ? " portrait" : ""}`}
        style={{
          width: `${Math.max(width * scale, 10)}px`,
          height: `${Math.max(height * scale, 10)}px`,
        }}
      />
      <span className="imagegen-ratio-option-label">{ratio}</span>
    </span>
  );
};

/** 尺寸预设下拉选项（CustomSelect 用）。 */
/**
 * 尺寸预设下拉选项（CustomSelect 用）。面板内的固定尺寸预设选择器与
 * Gemini 档位下拉共用，故对外导出。
 */
export const sizePresetOptions = (
  presets: string[],
): CustomSelectOption[] =>
  presets.map((preset) => ({ value: preset, label: preset }));

type SizeControlsProps = {
  model: string;
  defaultSize: string;
  onUpdateSize: (newSize: string) => void;
  disabled: boolean;
  t: (key: string, options?: { defaultValue?: string }) => string;
};

/** Gemini 尺寸：自定义输入 + 档位下拉 + 宽高比下拉（组合为 "16:9@2K"）。 */
export const GeminiSizeControls = ({
  model,
  defaultSize,
  onUpdateSize,
  disabled,
  t,
}: SizeControlsProps): React.JSX.Element => {
  const parsed = matchGeminiSizePreset(defaultSize);
  const supportedSizes = getGeminiSizePresets(model);

  return (
    <div className="imagegen-editor-size-row">
      <input
        className="imagegen-size-input"
        type="text"
        value={defaultSize}
        onChange={(event) => onUpdateSize(event.target.value)}
        placeholder="1K / 16:9 / 16:9@2K"
        disabled={disabled}
        spellCheck={false}
      />
      <CustomSelect
        value={parsed.imageSize}
        options={[
          {
            value: "",
            label: t("settings.imagegenSizeTier", {
              defaultValue: "Size tier",
            }),
          },
          ...sizePresetOptions(supportedSizes),
        ]}
        onChange={(value) => onUpdateSize(buildGeminiSize(parsed.ratio, value))}
        disabled={disabled}
        portal
      />
      <CustomSelect
        value={parsed.ratio}
        options={[
          {
            value: "",
            label: t("settings.imagegenAspectRatio", {
              defaultValue: "Aspect ratio",
            }),
          },
          ...GEMINI_ASPECT_RATIOS.map((ratio) => ({
            value: ratio,
            label: ratio,
          })),
        ]}
        onChange={(value) =>
          onUpdateSize(buildGeminiSize(value, parsed.imageSize))
        }
        disabled={disabled}
        portal
        renderOption={(option) =>
          option.value ? <RatioDiagram ratio={option.value} /> : option.label
        }
      />
    </div>
  );
};

/** gpt-image-2 尺寸：自定义输入 + 比例下拉 + 档位下拉（推荐分辨率表）。 */
export const GptImage2SizeControls = ({
  defaultSize,
  onUpdateSize,
  disabled,
  t,
}: SizeControlsProps): React.JSX.Element => {
  const parsed = matchOpenAISizePreset(defaultSize);
  const ratioOptions = Object.keys(OPENAI_SIZE_PRESETS).map((ratio) => ({
    value: ratio,
    label: ratio,
  }));

  const pickSize = (ratio: string, tier: string): string => {
    const normalizedRatio =
      ratio && OPENAI_SIZE_PRESETS[ratio] ? ratio : "16:9";
    const normalizedTier =
      tier && (OPENAI_SIZE_TIERS as readonly string[]).includes(tier)
        ? (tier as keyof (typeof OPENAI_SIZE_PRESETS)[string])
        : "1K";
    return OPENAI_SIZE_PRESETS[normalizedRatio][normalizedTier];
  };

  return (
    <div className="imagegen-editor-size-row">
      <input
        className="imagegen-size-input"
        type="text"
        value={defaultSize}
        onChange={(event) => onUpdateSize(event.target.value)}
        placeholder="auto / 1792x1008"
        disabled={disabled}
        spellCheck={false}
      />
      <CustomSelect
        value={parsed?.ratio ?? ""}
        options={[
          {
            value: "",
            label: t("settings.imagegenAspectRatio", {
              defaultValue: "Aspect ratio",
            }),
          },
          ...ratioOptions,
        ]}
        onChange={(value) =>
          onUpdateSize(pickSize(value, parsed?.tier ?? "1K"))
        }
        disabled={disabled}
        portal
        renderOption={(option) =>
          option.value ? <RatioDiagram ratio={option.value} /> : option.label
        }
      />
      <CustomSelect
        value={parsed?.tier ?? ""}
        options={[
          {
            value: "",
            label: t("settings.imagegenSizeTier", {
              defaultValue: "Size tier",
            }),
          },
          ...sizePresetOptions([...OPENAI_SIZE_TIERS]),
        ]}
        onChange={(value) =>
          onUpdateSize(pickSize(parsed?.ratio ?? "16:9", value))
        }
        disabled={disabled}
        portal
      />
    </div>
  );
};
