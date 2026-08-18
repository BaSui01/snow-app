export const TOOL_RESULT_LIMIT_MIN_PERCENT = 1;
export const TOOL_RESULT_LIMIT_MAX_PERCENT = 100;
export const TOOL_RESULT_LIMIT_STEP_PERCENT = 1;
export const DEFAULT_TOOL_RESULT_LIMIT_PERCENT = 30;

const parseInteger = (
  value: string | number | null | undefined
): number | null => {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : null;
  }

  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isNaN(parsed) ? null : parsed;
};

export const normalizeToolResultLimitPercent = (
  value: string | number | null | undefined
): number => {
  const parsed = parseInteger(value) ?? DEFAULT_TOOL_RESULT_LIMIT_PERCENT;

  return Math.min(
    TOOL_RESULT_LIMIT_MAX_PERCENT,
    Math.max(TOOL_RESULT_LIMIT_MIN_PERCENT, parsed)
  );
};
