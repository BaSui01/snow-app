/**
 * 敏感命令的决策模型辅助配置。
 *
 * 真源是 system_settings 的 `sensitive_command_assist`，JSON 形如
 * `{ enabled, modelId, delegate }`。Rust 侧（native/src/api/jev.rs +
 * native/src/exports/api.rs）按同一份 JSON 解析，字段名必须保持 camelCase 一致。
 *
 * - enabled：总开关，默认关闭。关闭时不请求决策模型，敏感命令照常弹确认。
 * - modelId：参与判定的决策模型 id（「API 配置 → 决策模型」中已启用的条目）。
 * - delegate：托管，默认关闭。开启后判定直接生效（允许则放行、拒绝则拒绝）；
 *   关闭时判定只在敏感命令拦截提示中作为建议展示。
 */

export const SENSITIVE_COMMAND_ASSIST_SETTING_NAME =
  "Sensitive command decision assist";
export const SENSITIVE_COMMAND_ASSIST_SETTING_CODE = "sensitive_command_assist";

/** 单个敏感命令辅助配置。 */
export type SensitiveCommandAssistSettings = {
  enabled: boolean;
  modelId: string;
  delegate: boolean;
};

export const DEFAULT_SENSITIVE_COMMAND_ASSIST_SETTINGS: SensitiveCommandAssistSettings =
  {
    enabled: false,
    modelId: "",
    delegate: false,
  };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 读取系统设置里的辅助配置（未配置 / 解析失败返回默认值）。 */
export const readSensitiveCommandAssistSettings = (
  value: string | null,
): SensitiveCommandAssistSettings => {
  if (!value) {
    return { ...DEFAULT_SENSITIVE_COMMAND_ASSIST_SETTINGS };
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) {
      return { ...DEFAULT_SENSITIVE_COMMAND_ASSIST_SETTINGS };
    }

    return {
      // 缺省一律视为关闭：手写配置时无需显式写 false。
      enabled: parsed.enabled === true,
      modelId: typeof parsed.modelId === "string" ? parsed.modelId.trim() : "",
      delegate: parsed.delegate === true,
    };
  } catch {
    return { ...DEFAULT_SENSITIVE_COMMAND_ASSIST_SETTINGS };
  }
};

/** 序列化为系统设置存储格式（去除模型 id 首尾空白）。 */
export const toSensitiveCommandAssistJson = (
  settings: SensitiveCommandAssistSettings,
): string =>
  JSON.stringify({
    enabled: settings.enabled,
    modelId: settings.modelId.trim(),
    delegate: settings.delegate,
  });
