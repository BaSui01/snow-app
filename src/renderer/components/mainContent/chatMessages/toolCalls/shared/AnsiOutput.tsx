import { useMemo, useState, type ReactNode } from "react";
import { AlertCircle, Copy, Check, Filter } from "lucide-react";
import { useI18n } from "../../../../../i18n";

type AnsiOutputProps = {
  text: string;
  className?: string;
  defaultFilterErrors?: boolean;
};

// ANSI 颜色映射表 (标准终端 16 色)
const ANSI_COLOR_MAP: Record<number, string> = {
  30: "var(--text-muted, #6e7681)", // Black / Muted
  31: "#f85149", // Red
  32: "#3fb950", // Green
  33: "#d29922", // Yellow
  34: "#58a6ff", // Blue
  35: "#bc8cff", // Magenta
  36: "#39c5cf", // Cyan
  37: "var(--text-primary, #e6edf3)", // White
  90: "#8b949e", // Bright Black (Gray)
  91: "#ff7b72", // Bright Red
  92: "#56d364", // Bright Green
  93: "#e3b341", // Bright Yellow
  94: "#79c0ff", // Bright Blue
  95: "#d2a8ff", // Bright Magenta
  96: "#56d4dd", // Bright Cyan
  97: "#ffffff", // Bright White
};

type StyledSpan = {
  text: string;
  color?: string;
  bold?: boolean;
  underline?: boolean;
};

/**
 * 轻量高性能 ANSI 转义码解析器
 */
const parseAnsiLine = (line: string): StyledSpan[] => {
  // 匹配 \u001b[...m 序列
  const regex = /\u001b\[([0-9;]*)m/g;
  const spans: StyledSpan[] = [];
  let lastIndex = 0;
  let currentColor: string | undefined;
  let isBold = false;
  let isUnderline = false;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      spans.push({
        text: line.slice(lastIndex, match.index),
        color: currentColor,
        bold: isBold,
        underline: isUnderline,
      });
    }

    const codes = match[1]
      ? match[1].split(";").map((c) => parseInt(c, 10))
      : [0];

    for (const code of codes) {
      if (code === 0) {
        currentColor = undefined;
        isBold = false;
        isUnderline = false;
      } else if (code === 1) {
        isBold = true;
      } else if (code === 4) {
        isUnderline = true;
      } else if (code === 22) {
        isBold = false;
      } else if (code === 24) {
        isUnderline = false;
      } else if (ANSI_COLOR_MAP[code]) {
        currentColor = ANSI_COLOR_MAP[code];
      }
    }

    lastIndex = regex.lastIndex;
  }

  if (lastIndex < line.length) {
    spans.push({
      text: line.slice(lastIndex),
      color: currentColor,
      bold: isBold,
      underline: isUnderline,
    });
  }

  return spans.length > 0 ? spans : [{ text: line }];
};

const isErrorLine = (line: string): boolean => {
  const lower = line.toLowerCase();
  return (
    lower.includes("error") ||
    lower.includes("fail") ||
    lower.includes("fatal") ||
    lower.includes("exception") ||
    lower.includes("panic") ||
    lower.includes("err:")
  );
};

export const AnsiOutput = ({
  text,
  className = "",
  defaultFilterErrors = false,
}: AnsiOutputProps): React.JSX.Element => {
  const { t } = useI18n();
  const [filterMode, setFilterMode] = useState<"all" | "errors">(
    defaultFilterErrors ? "errors" : "all",
  );
  const [copied, setCopied] = useState(false);

  const lines = useMemo(() => text.split(/\r?\n/), [text]);

  const hasErrors = useMemo(
    () => lines.some((line) => isErrorLine(line)),
    [lines],
  );

  const displayedLines = useMemo(() => {
    if (filterMode === "errors") {
      const filtered = lines.filter((line) => isErrorLine(line));
      return filtered.length > 0 ? filtered : lines;
    }
    return lines;
  }, [lines, filterMode]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    // 拷贝时剥离 ANSI 控制码
    const plainText = text.replace(/\u001b\[[0-9;]*m/g, "");
    navigator.clipboard.writeText(plainText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={`tool-call-ansi-container ${className}`}>
      {hasErrors && (
        <div className="tool-call-ansi-toolbar">
          <div className="tool-call-ansi-filter-tabs">
            <button
              type="button"
              className={`tool-call-ansi-filter-btn ${
                filterMode === "all" ? "active" : ""
              }`}
              onClick={(e) => {
                e.stopPropagation();
                setFilterMode("all");
              }}
            >
              {t("toolCall.common.filterAll", {
                values: { count: lines.length },
              })}
            </button>
            <button
              type="button"
              className={`tool-call-ansi-filter-btn tool-call-ansi-filter-err ${
                filterMode === "errors" ? "active" : ""
              }`}
              onClick={(e) => {
                e.stopPropagation();
                setFilterMode("errors");
              }}
            >
              <AlertCircle size={10} aria-hidden="true" />
              {t("toolCall.common.filterErrorsOnly")}
            </button>
          </div>
        </div>
      )}

      <div className="tool-call-ansi-output">
        <pre className="tool-call-section-pre tool-call-bash-output-pre tool-call-ansi-pre">
          {displayedLines.map((line, lineIdx) => {
            const spans = parseAnsiLine(line);
            const isErr = isErrorLine(line);
            return (
              <div
                key={lineIdx}
                className={`tool-call-ansi-line ${isErr ? "is-error-line" : ""}`}
              >
                {spans.map((span, spanIdx) => (
                  <span
                    key={spanIdx}
                    style={{
                      color: span.color,
                      fontWeight: span.bold ? "bold" : "normal",
                      textDecoration: span.underline ? "underline" : "none",
                    }}
                  >
                    {span.text}
                  </span>
                ))}
              </div>
            );
          })}
        </pre>
        <button
          type="button"
          className="tool-call-ansi-copy-btn"
          onClick={handleCopy}
          title={t("toolCall.common.copyOutput")}
        >
          {copied ? (
            <Check size={11} aria-hidden="true" />
          ) : (
            <Copy size={11} aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
};
