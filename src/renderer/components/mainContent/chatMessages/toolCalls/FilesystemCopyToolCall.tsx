import { useCallback, useMemo } from "react";
import { useI18n } from "../../../../i18n";
import { getCompareDiffStats } from "../../../../utils/generateComparePatch";
import { getFileTypeIcon } from "../../../../utils/fileIcons";
import {
  rightPanelEvents,
  type OpenFileDiffPreviewPayload,
} from "../../../rightPanel/rightPanelEvents";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { getFileName, pathsReferToSameFile } from "./shared/formatters";
import { MiniDiffViewer } from "./shared/MiniDiffViewer";
import { ToolCallNode } from "./shared/ToolCallNode";

type FilesystemCopyToolCallProps = {
  toolCall: ToolCallInfo;
};

type CopyMode = "insert" | "replace";
type InsertPosition = "before" | "after";

type ParsedCopyArgs = {
  /** 目标文件（粘贴目的地）。 */
  filePath: string;
  sourceFilePath: string;
  sourceStartLine?: number;
  sourceEndLine?: number;
  targetLine?: number;
  targetEndLine?: number;
  mode: CopyMode;
  position: InsertPosition;
  /** true 表示剪切/移动：粘贴后源区间从源文件删除。 */
  deleteSource: boolean;
};

type ParsedCopyResult =
  | {
      type: "success";
      sourceFilePath: string;
      sourceLineStart?: number;
      sourceLineEnd?: number;
      copiedLines?: number;
      targetFilePath: string;
      mode: CopyMode;
      position?: InsertPosition;
      deleteSource: boolean;
      matchedLineStart?: number;
      matchedLineEnd?: number;
      totalLines?: number;
      replacedContent: string;
      pastedContent: string;
      /** 仅跨文件剪切返回：源文件被删掉的行。 */
      removedContent: string;
      omittedLines: number;
    }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const readString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const readLine = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const readMode = (value: unknown): CopyMode | undefined =>
  value === "insert" || value === "replace" ? value : undefined;

const readPosition = (value: unknown): InsertPosition | undefined =>
  value === "before" || value === "after" ? value : undefined;

const parseArgs = (args: string): ParsedCopyArgs | null => {
  try {
    const parsed = JSON.parse(args);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const filePath = readString(parsed.filePath);
    if (!filePath) {
      return null;
    }
    return {
      filePath,
      sourceFilePath: readString(parsed.sourceFilePath),
      sourceStartLine: readLine(parsed.sourceStartLine),
      sourceEndLine: readLine(parsed.sourceEndLine),
      targetLine: readLine(parsed.targetLine),
      targetEndLine: readLine(parsed.targetEndLine),
      mode: readMode(parsed.mode) ?? "insert",
      position: readPosition(parsed.position) ?? "before",
      deleteSource: parsed.deleteSource === true,
    };
  } catch {
    return null;
  }
};

const parseResult = (result: string | undefined): ParsedCopyResult => {
  if (!result) {
    return { type: "empty" };
  }

  try {
    const parsed = JSON.parse(result);

    if (typeof parsed === "object" && parsed !== null) {
      if (typeof parsed.error === "string") {
        return { type: "error", message: parsed.error };
      }

      if (parsed.success === true) {
        return {
          type: "success",
          sourceFilePath: readString(parsed.sourceFilePath),
          sourceLineStart: readLine(parsed.sourceLineStart),
          sourceLineEnd: readLine(parsed.sourceLineEnd),
          copiedLines: readLine(parsed.copiedLines),
          targetFilePath: readString(parsed.targetFilePath),
          mode: readMode(parsed.mode) ?? "insert",
          position: readPosition(parsed.position),
          deleteSource: parsed.deleteSource === true,
          matchedLineStart: readLine(parsed.matchedLineStart),
          matchedLineEnd: readLine(parsed.matchedLineEnd),
          totalLines: readLine(parsed.totalLines),
          replacedContent: readString(parsed.replacedContent),
          pastedContent: readString(parsed.pastedContent),
          removedContent: readString(parsed.removedContent),
          omittedLines: readLine(parsed.omittedLines) ?? 0,
        };
      }
    }

    return { type: "raw", text: result };
  } catch {
    return { type: "raw", text: result };
  }
};

const formatLineRange = (start?: number, end?: number): string => {
  if (start === undefined) {
    return "";
  }
  if (end === undefined || end === start) {
    return `${start}`;
  }
  return `${start}-${end}`;
};

export const FilesystemCopyToolCall = ({
  toolCall,
}: FilesystemCopyToolCallProps): React.JSX.Element => {
  const parsedArgs = useMemo(
    () => parseArgs(toolCall.arguments),
    [toolCall.arguments],
  );
  const parsedResult = useMemo(
    () => parseResult(toolCall.result),
    [toolCall.result],
  );

  const hasError = parsedResult.type === "error";
  const success = parsedResult.type === "success" ? parsedResult : null;
  const args = parsedArgs;

  const isCut = success?.deleteSource ?? args?.deleteSource ?? false;
  const mode = success?.mode ?? args?.mode ?? "insert";
  const position = success?.position ?? args?.position ?? "before";

  const filePath = args?.filePath ?? success?.targetFilePath ?? "copy";
  const fileName = getFileName(filePath);
  const sourceFilePath = success?.sourceFilePath || args?.sourceFilePath || "";
  const sourceFileName = sourceFilePath ? getFileName(sourceFilePath) : "";
  const sourceRange = formatLineRange(
    success?.sourceLineStart ?? args?.sourceStartLine,
    success?.sourceLineEnd ?? args?.sourceEndLine ?? args?.sourceStartLine,
  );
  // 源文件与目标文件是否同一个文件（同文件剪切只写一次，也不渲染第二个 diff）。
  const sameFile = pathsReferToSameFile(sourceFilePath, filePath);

  const replacement = success?.replacedContent ?? "";
  const pasted = success?.pastedContent ?? "";
  const showDiff = !hasError && Boolean(pasted) && success !== null;
  const showSourceDiff =
    !hasError && isCut && !sameFile && Boolean(success?.removedContent);

  const stats = useMemo(() => {
    if (!showDiff && !showSourceDiff) {
      return null;
    }
    if (showDiff) {
      return getCompareDiffStats(replacement, pasted);
    }
    return getCompareDiffStats(success?.removedContent ?? "", "");
  }, [showDiff, showSourceDiff, replacement, pasted, success]);

  const placementLabel = useMemo(() => {
    if (mode === "replace") {
      const range = formatLineRange(
        args?.targetLine,
        args?.targetEndLine && args.targetEndLine > (args.targetLine ?? 0)
          ? args.targetEndLine
          : args?.targetLine,
      );
      return range ? `replaced lines ${range}` : "replaced range";
    }
    if (args?.targetLine === undefined) {
      return "appended at end of file";
    }
    return position === "after"
      ? `inserted after line ${args.targetLine}`
      : `inserted before line ${args.targetLine}`;
  }, [mode, position, args]);

  const landedLabel = success
    ? (() => {
        const range = formatLineRange(
          success.matchedLineStart,
          success.matchedLineEnd,
        );
        const lines =
          success.copiedLines !== undefined
            ? ` (${success.copiedLines} lines)`
            : "";
        if (!range) {
          return isCut ? `cut${lines}` : `pasted${lines}`;
        }
        return isCut
          ? `cut to lines ${range}${lines}`
          : `pasted at lines ${range}${lines}`;
      })()
    : "";

  const sourceNote = useMemo(() => {
    if (!isCut || !success) {
      return "";
    }
    if (sameFile) {
      return sourceRange
        ? `source lines ${sourceRange} removed from the same file`
        : "source lines removed from the same file";
    }
    const removed = formatLineRange(
      success.sourceLineStart,
      success.sourceLineEnd,
    );
    return removed
      ? `removed lines ${removed} from ${sourceFileName}`
      : `removed the source lines from ${sourceFileName}`;
  }, [isCut, success, sameFile, sourceRange, sourceFileName]);

  const { t } = useI18n();

  const handleOpenTargetInTab = useCallback(() => {
    if (!success) {
      return;
    }
    const payload: OpenFileDiffPreviewPayload = {
      fileName,
      filePath,
      oldContent: replacement,
      newContent: pasted,
      oldStartLine: success.matchedLineStart,
      newStartLine: success.matchedLineStart,
      changeType: mode === "replace" ? "modified" : "added",
    };
    rightPanelEvents.emit("open-file-diff-preview", payload);
  }, [success, fileName, filePath, replacement, pasted, mode]);

  const handleOpenSourceInTab = useCallback(() => {
    if (!success || !sourceFilePath) {
      return;
    }
    const payload: OpenFileDiffPreviewPayload = {
      fileName: sourceFileName,
      filePath: sourceFilePath,
      oldContent: success.removedContent,
      newContent: "",
      oldStartLine: success.sourceLineStart,
      changeType: "modified",
    };
    rightPanelEvents.emit("open-file-diff-preview", payload);
  }, [success, sourceFilePath, sourceFileName]);

  const effectiveStatus = hasError ? "error" : toolCall.status;

  return (
    <ToolCallNode
      toolName={toolCall.name}
      category="copy"
      displayName={
        <>
          {getFileTypeIcon(fileName, false, false, {
            size: 13,
            "aria-hidden": true,
          })}
          {fileName}
        </>
      }
      displayNameTitle={filePath}
      displayNameDataPath={filePath}
      status={effectiveStatus}
      meta={
        stats ? (
          <span className="tool-call-diff-stats">
            <span className="tool-call-diff-add">+{stats.additions}</span>
            <span className="tool-call-diff-del">-{stats.deletions}</span>
          </span>
        ) : null
      }
      className="tool-call-filesystem-copy"
      lazyBody
    >
      <div className="tool-call-body">
        <div className="tool-call-file-path" data-path={filePath}>
          {filePath}
        </div>
        {hasError ? (
          <div className="tool-call-error">
            <span>{parsedResult.message}</span>
          </div>
        ) : null}

        {sourceFilePath ? (
          <div className="tool-call-meta-row">
            <span className="tool-call-meta-label">
              {isCut ? "cut from" : "copy from"}
            </span>
            <span
              className="tool-call-meta-value"
              data-path={sourceFilePath}
              title={sourceFilePath}
            >
              {sourceRange
                ? `${sourceFileName}:${sourceRange}`
                : sourceFileName}
            </span>
          </div>
        ) : null}

        {args ? (
          <div className="tool-call-meta-row">
            <span className="tool-call-meta-label">
              {mode === "replace" ? "replace" : "insert"}
            </span>
            <span className="tool-call-meta-value">{placementLabel}</span>
          </div>
        ) : null}

        {success ? (
          <div className="tool-call-success-row">
            {landedLabel}
            {sourceNote ? ` — ${sourceNote}` : ""}
          </div>
        ) : null}

        {success && success.omittedLines > 0 ? (
          <div className="tool-call-meta-row">
            <span className="tool-call-meta-label">elided</span>
            <span className="tool-call-meta-value">
              {success.omittedLines} lines
            </span>
          </div>
        ) : null}

        {showDiff && success ? (
          <MiniDiffViewer
            fileName={fileName}
            oldContent={replacement}
            newContent={pasted}
            startLine={success.matchedLineStart}
            onOpenInTab={handleOpenTargetInTab}
            openInTabLabel={t("rightPanel.openInNewTab")}
          />
        ) : null}

        {showSourceDiff && success ? (
          <div className="tool-call-meta-row">
            <span className="tool-call-meta-label">removed</span>
            <span
              className="tool-call-meta-value"
              data-path={sourceFilePath}
              title={sourceFilePath}
            >
              {sourceFileName}
            </span>
          </div>
        ) : null}
        {showSourceDiff && success ? (
          <MiniDiffViewer
            fileName={sourceFileName}
            oldContent={success.removedContent}
            newContent=""
            startLine={success.sourceLineStart}
            onOpenInTab={handleOpenSourceInTab}
            openInTabLabel={t("rightPanel.openInNewTab")}
          />
        ) : null}

        {parsedResult.type === "raw" ? (
          <pre className="tool-call-section-pre">{parsedResult.text}</pre>
        ) : null}

        {parsedResult.type === "empty" && !hasError ? (
          <div className="tool-call-pending">
            {parsedArgs ? (
              <pre className="tool-call-section-pre">
                {JSON.stringify(parsedArgs, null, 2)}
              </pre>
            ) : (
              <span className="tool-call-section-label">No arguments</span>
            )}
          </div>
        ) : null}
      </div>
    </ToolCallNode>
  );
};
