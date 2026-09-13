const SENSITIVE_KEY_PATTERN =
  "(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?(?:token|id)|client[_-]?secret|private[_-]?key|password|passwd|secret|token)";

const BEARER_TOKEN_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi;
const HEADER_VALUE_PATTERN =
  /\b(Authorization|Cookie|Set-Cookie)(\s*:\s*)[^\r\n]*/gi;
const QUOTED_SENSITIVE_VALUE_PATTERN = new RegExp(
  `(["']?${SENSITIVE_KEY_PATTERN}["']?\\s*[:=]\\s*)(["'])(.{8,}?)\\2`,
  "gi",
);
const UNQUOTED_SENSITIVE_VALUE_PATTERN = new RegExp(
  `(["']?${SENSITIVE_KEY_PATTERN}["']?\\s*[:=]\\s*)(?!(?:process|Deno)\\.env\\b|import\\.meta\\.env\\b)([A-Za-z0-9._~+/=-]{12,})\\b(?!\\s*\\()`,
  "gi",
);
const OPENAI_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{16,}\b/g;

/**
 * Remove credentials from tool arguments and output before they cross the
 * remote-control boundary. This is deliberately conservative for source
 * code: arbitrary identifiers and function calls are not treated as values.
 */
export const redactSensitiveToolText = (
  value: string | undefined,
): string | undefined => {
  if (value === undefined) return undefined;

  return value
    .replace(BEARER_TOKEN_PATTERN, "$1[REDACTED]")
    .replace(HEADER_VALUE_PATTERN, "$1$2[REDACTED]")
    .replace(
      QUOTED_SENSITIVE_VALUE_PATTERN,
      (_match: string, prefix: string, quote: string) =>
        `${prefix}${quote}[REDACTED]${quote}`,
    )
    .replace(UNQUOTED_SENSITIVE_VALUE_PATTERN, "$1[REDACTED]")
    .replace(OPENAI_KEY_PATTERN, "[REDACTED_API_KEY]");
};
