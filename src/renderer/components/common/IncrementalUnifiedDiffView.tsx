import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  DiffLineType,
  getPlainDiffTemplate,
  getPlainLineTemplate,
  getSyntaxDiffTemplate,
  getSyntaxLineTemplate,
} from "@git-diff-view/file";
import type { DiffFile, UnifiedLineItem } from "@git-diff-view/file";

/** 每批挂载的行数；滚动接近末尾时自动追加下一批，内容不截断 */
const RENDER_BATCH = 200;
/** 距容器底部多少像素内触发追加 */
const APPEND_THRESHOLD = 600;

type IncrementalUnifiedDiffViewProps = {
  diffFile: DiffFile;
  fontSize: number;
};

type LineTemplate = {
  key: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  isAdd: boolean;
  isDelete: boolean;
  html: string;
};

const buildLineTemplate = (
  diffFile: DiffFile,
  line: UnifiedLineItem,
  index: number,
): LineTemplate => {
  const diffLine = line.diff;
  const isAdd = diffLine?.type === DiffLineType.Add;
  const isDelete = diffLine?.type === DiffLineType.Delete;
  const rawLine = line.value ?? "";
  const operator = isAdd ? "add" : "del";

  let html: string | null = null;
  if (diffLine?.changes?.hasLineChange) {
    const syntaxLine = line.newLineNumber
      ? diffFile.getNewSyntaxLine(line.newLineNumber)
      : line.oldLineNumber
        ? diffFile.getOldSyntaxLine(line.oldLineNumber)
        : undefined;
    if (syntaxLine && (syntaxLine.nodeList?.length ?? 0) <= 150) {
      getSyntaxDiffTemplate({ diffFile, diffLine, syntaxLine, operator });
      html = diffLine.syntaxTemplate ?? null;
    }
    if (!html) {
      getPlainDiffTemplate({ diffLine, rawLine, operator });
      html = diffLine.plainTemplate ?? null;
    }
  }
  if (!html) {
    const plainLine = line.newLineNumber
      ? diffFile.getNewPlainLine(line.newLineNumber)
      : line.oldLineNumber
        ? diffFile.getOldPlainLine(line.oldLineNumber)
        : undefined;
    if (plainLine) {
      if (!plainLine.template) {
        plainLine.template = getPlainLineTemplate(plainLine.value);
      }
      html = plainLine.template || null;
    }
  }
  if (!html) {
    const syntaxLine = line.newLineNumber
      ? diffFile.getNewSyntaxLine(line.newLineNumber)
      : line.oldLineNumber
        ? diffFile.getOldSyntaxLine(line.oldLineNumber)
        : undefined;
    if (syntaxLine) {
      if (!syntaxLine.template) {
        syntaxLine.template = getSyntaxLineTemplate(syntaxLine);
      }
      html = syntaxLine.template || null;
    }
  }

  return {
    key: `${index}-${line.oldLineNumber ?? 0}-${line.newLineNumber ?? 0}`,
    oldLineNumber: line.oldLineNumber,
    newLineNumber: line.newLineNumber,
    isAdd,
    isDelete,
    html: html ?? "",
  };
};

/**
 * 单列 diff 的增量渲染视图。
 * 库自带 DiffView 会一次性挂载全部行，大文件时 DOM 数量爆炸；
 * 这里按批挂载，滚动接近末尾时自动追加，数据完整不截断。
 */
export const IncrementalUnifiedDiffView = memo(
  ({
    diffFile,
    fontSize,
  }: IncrementalUnifiedDiffViewProps): React.JSX.Element => {
    const [visibleCount, setVisibleCount] = useState(RENDER_BATCH);
    const rootRef = useRef<HTMLDivElement | null>(null);

    const total = diffFile.unifiedLineLength;

    useEffect(() => {
      setVisibleCount(RENDER_BATCH);
    }, [diffFile, total]);

    useEffect(() => {
      if (visibleCount >= total) {
        return;
      }
      const root = rootRef.current;
      const scroller = root?.closest(".tool-call-diff-content");
      if (!root || !scroller) {
        return;
      }
      const maybeAppend = (): void => {
        const remaining =
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
        if (remaining < APPEND_THRESHOLD) {
          setVisibleCount((count) => Math.min(count + RENDER_BATCH, total));
        }
      };
      const raf = requestAnimationFrame(maybeAppend);
      scroller.addEventListener("scroll", maybeAppend, { passive: true });
      return () => {
        cancelAnimationFrame(raf);
        scroller.removeEventListener("scroll", maybeAppend);
      };
    }, [diffFile, visibleCount, total]);

    const lines = useMemo(() => {
      const count = Math.min(visibleCount, total);
      const result: LineTemplate[] = [];
      for (let index = 0; index < count; index++) {
        const line = diffFile.getUnifiedLine(index);
        if (!line || line.isHidden) {
          continue;
        }
        result.push(buildLineTemplate(diffFile, line, index));
      }
      return result;
    }, [diffFile, visibleCount, total]);

    return (
      <div
        ref={rootRef}
        className="diff-tailwindcss-wrapper incremental-diff-wrapper"
        data-component="git-diff-view"
        data-theme={diffFile._getTheme() || "light"}
        data-highlighter={diffFile._getHighlighterName()}
      >
        <div
          className="diff-style-root"
          style={
            { "--diff-font-size--": `${fontSize}px` } as React.CSSProperties
          }
        >
          <div className="incremental-diff-body">
            {lines.map((line) => (
              <div
                key={line.key}
                data-state={line.isAdd || line.isDelete ? "diff" : "plain"}
                className="incremental-diff-line"
                style={{
                  backgroundColor: line.isAdd
                    ? "var(--diff-add-content--)"
                    : line.isDelete
                      ? "var(--diff-del-content--)"
                      : "var(--diff-plain-content--)",
                }}
              >
                <span
                  className="incremental-diff-num"
                  style={{
                    backgroundColor: line.isAdd
                      ? "var(--diff-add-lineNumber--)"
                      : line.isDelete
                        ? "var(--diff-del-lineNumber--)"
                        : "var(--diff-plain-lineNumber--)",
                  }}
                >
                  <span>{line.oldLineNumber ?? ""}</span>
                  <span>{line.newLineNumber ?? ""}</span>
                </span>
                <span
                  className="incremental-diff-content diff-line-syntax-raw"
                  dangerouslySetInnerHTML={{ __html: line.html }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  },
);

IncrementalUnifiedDiffView.displayName = "IncrementalUnifiedDiffView";
