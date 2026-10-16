import { useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import {
  getCodeLanguageFromPath,
  highlightCodeHtml,
} from "../../../../../utils/syntaxHighlight";
import { splitHighlightedHtmlLines } from "../../../../rightPanel/fileViewer/codeText";
import { getFileTypeIcon } from "../../../../../utils/fileIcons";
import { useI18n } from "../../../../../i18n";

type CodeHighlightViewProps = {
  code: string;
  filePath?: string;
  startLine?: number;
  totalLines?: number;
  maxHeight?: number | string;
  className?: string;
};

export const CodeHighlightView = ({
  code,
  filePath = "",
  startLine = 1,
  totalLines,
  maxHeight,
  className = "",
}: CodeHighlightViewProps): React.JSX.Element => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const MAX_INITIAL_LINES = 300;

  const fileName = useMemo(
    () => filePath.split(/[\\/]/).filter(Boolean).pop() || filePath,
    [filePath],
  );

  const language = useMemo(
    () => (filePath ? getCodeLanguageFromPath(filePath) : ""),
    [filePath],
  );

  // 切分代码行与语法高亮
  const highlightedLines = useMemo(
    () =>
      splitHighlightedHtmlLines(
        highlightCodeHtml(code, language).replace(/\r\n/g, "\n"),
      ),
    [code, language],
  );

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const isLarge = highlightedLines.length > MAX_INITIAL_LINES;
  const displayedLines = showAll
    ? highlightedLines
    : highlightedLines.slice(0, MAX_INITIAL_LINES);

  return (
    <div className={`tool-call-code-highlight-wrap ${className}`}>
      {filePath && (
        <div className="tool-call-code-highlight-header">
          <div className="tool-call-code-file-badge">
            {getFileTypeIcon(fileName, false, false, {
              size: 13,
              "aria-hidden": true,
            })}
            <span className="tool-call-code-filename">{fileName}</span>
            {language && (
              <span className="tool-call-code-lang-tag">{language}</span>
            )}
            {totalLines !== undefined && (
              <span className="tool-call-code-lines-tag">
                {startLine !== undefined
                  ? `L${startLine}-L${startLine + highlightedLines.length - 1} / ${totalLines}`
                  : t("toolCall.common.lineCount", {
                      values: { count: totalLines },
                    })}
              </span>
            )}
          </div>

          <button
            type="button"
            className="tool-call-code-copy-btn"
            onClick={handleCopy}
            title={t("toolCall.common.copyCode")}
          >
            {copied ? (
              <Check size={11} aria-hidden="true" />
            ) : (
              <Copy size={11} aria-hidden="true" />
            )}
            <span>{copied ? t("common.copied") : t("common.copy")}</span>
          </button>
        </div>
      )}

      <div
        className="tool-call-code-scroll-area"
        style={maxHeight ? { maxHeight } : undefined}
      >
        <div className="tool-call-code-table">
          {displayedLines.map((lineHtml, idx) => {
            const lineNum = startLine + idx;
            return (
              <div key={idx} className="tool-call-code-row">
                <span className="tool-call-code-lineno" aria-hidden="true">
                  {lineNum}
                </span>
                <span
                  className="tool-call-code-content hljs"
                  dangerouslySetInnerHTML={{
                    __html: lineHtml || "&nbsp;",
                  }}
                />
              </div>
            );
          })}
        </div>
      </div>

      {isLarge && (
        <div className="tool-call-code-expand-bar">
          <span>
            {showAll
              ? t("toolCall.common.linesShownAll", {
                  values: { count: highlightedLines.length },
                })
              : t("toolCall.common.linesShownPartial", {
                  values: {
                    limit: MAX_INITIAL_LINES,
                    total: highlightedLines.length,
                  },
                })}
          </span>
          <button
            type="button"
            className="tool-call-code-expand-btn"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll
              ? t("toolCall.common.collapse")
              : t("toolCall.common.showAllHighlights")}
          </button>
        </div>
      )}
    </div>
  );
};
