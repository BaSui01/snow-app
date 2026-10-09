/**
 * 前端内部工具错误码的展示层本地化。
 *
 * 工具结果 JSON 里的 `error` / `message` 属于协议与审计字段：它们会写入会话
 * 历史并回传给模型，因此必须保持英文原文不变。本模块只把已知错误码翻译成
 * 用户可读的本地化说明，供工具卡片展示，不改动任何持久化数据。
 */

type ToolErrorTranslate = (
  key: string,
  options?: { defaultValue?: string; values?: Record<string, string | number> },
) => string;

/** 已知内部工具错误码 → 本地化文案 key。 */
export const TOOL_ERROR_CODE_MESSAGE_KEYS: Record<string, string> = {
  TOOLS_DISABLED_FOR_DUPLICATE_RECOVERY:
    "toolCall.duplicateReadonlyProtection.toolsDisabled",
  DUPLICATE_READONLY_TOOL_CALL:
    "toolCall.duplicateReadonlyProtection.duplicateCall",
};

/**
 * 把工具错误码/错误消息转换为本地化展示文案。
 * 未收录的错误码原样返回，保证任意错误信息都不会丢失。
 */
export const localizeToolError = (
  t: ToolErrorTranslate,
  message: string | null | undefined,
): string => {
  const raw = message?.trim();
  if (!raw) {
    return "";
  }

  const key = TOOL_ERROR_CODE_MESSAGE_KEYS[raw];
  if (key) {
    return t(key, { defaultValue: raw });
  }

  return message ?? "";
};
