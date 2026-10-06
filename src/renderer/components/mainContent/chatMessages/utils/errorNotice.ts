const NAPI_PREFIX =
  /^(?:Error:\s*)?(?:GenericFailure|InvalidArg|Unknown|Cancelled),\s*/;

const SUMMARY_MAX_LENGTH = 220;

const EXTRACTION_DEPTH = 3;

export type ErrorNotice = {
  statusLabel: string | null;
  summary: string;
  detail: string | null;
};

const extractBalancedJson = (text: string, start: number): string | null => {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return null;
};

const readMessageField = (value: unknown): string | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const nested = record.error;
  const candidates: unknown[] = [
    record.message,
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>).message
      : undefined,
    nested,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }
  return null;
};

const unwrapMessage = (text: string): string => {
  let current = text;
  for (let depth = 0; depth < EXTRACTION_DEPTH; depth += 1) {
    const start = current.indexOf("{");
    if (start < 0) {
      break;
    }
    const jsonText = extractBalancedJson(current, start);
    if (!jsonText) {
      break;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      break;
    }
    const message = readMessageField(parsed);
    if (!message) {
      break;
    }
    const next = message.trim();
    if (!next || next === current.trim()) {
      break;
    }
    current = next;
  }
  return current;
};

const readStatusLabel = (text: string): string | null => {
  const match = text.match(
    /request failed:\s*(\d{3})\s*([A-Za-z][A-Za-z ]*?)\s*(?=\{|\n|$)/,
  );
  if (!match) {
    return null;
  }
  const code = match[1];
  const statusText = match[2].trim();
  return statusText ? `${code} ${statusText}` : code;
};

const buildSummary = (text: string): string => {
  const normalized = text.trim();
  if (!normalized) {
    return "";
  }
  const firstLine = normalized.split("\n")[0].trim();
  const hasMoreLines = normalized.length > firstLine.length;
  const clipped =
    firstLine.length > SUMMARY_MAX_LENGTH
      ? `${firstLine.slice(0, SUMMARY_MAX_LENGTH)}…`
      : firstLine;
  return hasMoreLines && !clipped.endsWith("…") ? `${clipped}…` : clipped;
};

export const parseErrorNotice = (raw: string): ErrorNotice => {
  const detail = raw.replace(NAPI_PREFIX, "").trim();
  if (!detail) {
    return { statusLabel: null, summary: "", detail: null };
  }
  const statusLabel = readStatusLabel(detail);
  const summary = buildSummary(unwrapMessage(detail));
  return {
    statusLabel,
    summary,
    detail:
      summary && summary !== detail && detail.length > summary.length
        ? detail
        : null,
  };
};
