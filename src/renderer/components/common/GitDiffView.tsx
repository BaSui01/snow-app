import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DiffModeEnum,
  DiffView,
  SplitSide,
  getLang,
} from "@git-diff-view/react";
import { DiffFile, generateDiffFile } from "@git-diff-view/file";

import "@git-diff-view/react/styles/diff-view.css";

import { useI18n } from "../../i18n";
import { IncrementalUnifiedDiffView } from "./IncrementalUnifiedDiffView";
import {
  DiffCommentComposer,
  DiffCommentList,
  DiffCommentOrphanSection,
} from "./DiffComments";

import type {
  DiffCommentSide,
  DiffReviewCommentRecord,
} from "../../../preload";

// 从独立模块导入（仅依赖 "diff" 库），并重新导出保持现有导入路径兼容。
import { generateComparePatch } from "../../utils/generateComparePatch";
export {
  generateComparePatch,
  getCompareDiffStats,
} from "../../utils/generateComparePatch";

type DiffTheme = "light" | "dark";

/** 显示模式偏好：auto 按容器宽度自动切换 */
export type DiffViewModePreference = "auto" | "unified" | "split";

export type DiffCommentContext = {
  comments: DiffReviewCommentRecord[];
  onCreate: (input: {
    side: DiffCommentSide;
    lineNumber: number;
    lineContent: string;
    content: string;
  }) => void;
  onUpdate: (commentId: string, content: string) => void;
  onDelete: (commentId: string) => void;
};

/** 容器宽度达到该值时使用双列(Split)模式,否则使用单列(Unified)模式 */
const SPLIT_MIN_WIDTH = 720;

/** 超过该行数（unified 视图）时停用行内评论,避免大文件一次性挂载导致卡顿 */
const COMMENTS_MAX_LINES = 2000;

/** 监听全局 data-theme 属性,返回当前生效的亮/暗主题。 */
const useDiffViewTheme = (): DiffTheme => {
  const getTheme = (): DiffTheme =>
    document.documentElement.getAttribute("data-theme") === "dark"
      ? "dark"
      : "light";
  const [theme, setTheme] = useState<DiffTheme>(getTheme);

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(getTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return theme;
};

/** 根据容器宽度自动切换单列(Unified)/双列(Split)显示。 */
const useAutoDiffMode = (): {
  containerRef: React.RefObject<HTMLDivElement | null>;
  mode: DiffModeEnum;
} => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [mode, setMode] = useState<DiffModeEnum>(DiffModeEnum.Unified);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setMode(
        width >= SPLIT_MIN_WIDTH ? DiffModeEnum.Split : DiffModeEnum.Unified,
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { containerRef, mode };
};

/** 预构建 DiffFile 实例，避免 DiffView 内部再克隆一份完整数据 */
const buildDiffFile = (
  fileName: string,
  oldContent: string,
  newContent: string,
  hunks: string[] | null,
  theme: DiffTheme,
): DiffFile | null => {
  try {
    const lang = getLang(fileName);
    const diffFile = hunks
      ? new DiffFile(
          fileName,
          oldContent,
          fileName,
          newContent,
          hunks,
          lang,
          lang,
        )
      : generateDiffFile(
          fileName,
          oldContent,
          fileName,
          newContent,
          lang,
          lang,
        );
    diffFile.initTheme(theme);
    diffFile.initRaw();
    diffFile.initSyntax();
    diffFile.buildSplitDiffLines();
    diffFile.buildUnifiedDiffLines();
    return diffFile;
  } catch {
    return null;
  }
};

type GitDiffViewProps = {
  /** 用于推断语法高亮语言的文件名 */
  fileName: string;
  /** git 原始 unified diff 文本(git 模式,传入后忽略 oldContent/newContent) */
  patch?: string | null;
  /** 对比模式的旧内容 */
  oldContent?: string;
  /** 对比模式的新内容 */
  newContent?: string;
  /** diff 内容字号,默认 12 */
  fontSize?: number;
  /**
   * 旧内容在真实文件中的起始行号(1-based)。
   * 用于对比片段时显示正确的源文件行号,而非始终从 1 开始。
   */
  oldStartLine?: number;
  /**
   * 新内容在真实文件中的起始行号(1-based)。
   * 用于对比片段时显示正确的源文件行号,而非始终从 1 开始。
   */
  newStartLine?: number;
  /** 显示模式偏好,默认 auto（按容器宽度自动切换） */
  viewMode?: DiffViewModePreference;
  /** 是否自动换行,默认 true；关闭后长行保持单行并横向滚动 */
  wrapLines?: boolean;
  /** 行内评论上下文；未提供时停用评论与模式无关的扩展行 */
  commentContext?: DiffCommentContext | null;
};

/** 某一行上挂载的评论数据（含该行当前内容快照用于过期检测）。 */
type CommentLineData = {
  lineContent: string | null;
  comments: DiffReviewCommentRecord[];
};

/**
 * 基于 @git-diff-view/react 的统一差异查看组件。
 *
 * - git 模式: 传入 patch(git 原始 diff 文本)。
 * - 对比模式: 传入 oldContent / newContent,内部通过 jsdiff 生成差异。
 * - 自动跟随全局亮/暗主题;显示模式可按偏好固定或按容器宽度自动切换。
 * - 传入 commentContext 时启用行内评论（大文件自动降级）。
 */
export const GitDiffView = ({
  fileName,
  patch,
  oldContent,
  newContent,
  fontSize = 12,
  oldStartLine,
  newStartLine,
  viewMode = "auto",
  wrapLines = true,
  commentContext,
}: GitDiffViewProps): React.JSX.Element => {
  const theme = useDiffViewTheme();
  const { containerRef, mode: autoMode } = useAutoDiffMode();
  const { t } = useI18n();

  const mode =
    viewMode === "unified"
      ? DiffModeEnum.Unified
      : viewMode === "split"
        ? DiffModeEnum.Split
        : autoMode;

  /**
   * patch 非空但不含 hunk 头（行首 `@@ `）时，@git-diff-view 会解析出
   * 0 行并静默渲染成空白。git 报错消息、被 ANSI 色码污染的文本、仅有
   * mode/rename 变更的 patch 都会命中这种情况，这里提前拦截并显示
   * 可辨识的提示，而不是留白。
   */
  const patchMissingHunks = useMemo(
    () => (patch ? !/^@@ /m.test(patch) : false),
    [patch],
  );

  /**
   * 有行号偏移时，先用 generateComparePatch（context:3）把片段转成带正确行号的
   * 标准 patch；无偏移的大片段同样转 patch，把上下文行压缩到 hunk 级别，
   * 避免 createTwoFilesPatch 的全量上下文参与构建。
   */
  const comparePatch = useMemo(() => {
    if (patch) {
      return null;
    }
    const oldStr = oldContent ?? "";
    const newStr = newContent ?? "";
    if (!oldStr && !newStr) {
      return null;
    }
    const hasOffset =
      (oldStartLine != null && oldStartLine > 1) ||
      (newStartLine != null && newStartLine > 1);
    const totalLines = oldStr.split("\n").length + newStr.split("\n").length;
    if (!hasOffset && totalLines <= 500) {
      return null;
    }
    return generateComparePatch(
      fileName,
      oldStr,
      newStr,
      oldStartLine,
      newStartLine,
    );
  }, [patch, fileName, oldContent, newContent, oldStartLine, newStartLine]);

  const activePatch = patch ?? comparePatch;

  const renderDiffFile = useMemo<DiffFile | null>(() => {
    if (patchMissingHunks) {
      return null;
    }
    if (activePatch) {
      return buildDiffFile(fileName, "", "", [activePatch], theme);
    }
    return buildDiffFile(
      fileName,
      oldContent ?? "",
      newContent ?? "",
      null,
      theme,
    );
  }, [patchMissingHunks, activePatch, fileName, oldContent, newContent, theme]);

  const commentsEnabled = Boolean(
    commentContext &&
    renderDiffFile &&
    renderDiffFile.unifiedLineLength <= COMMENTS_MAX_LINES,
  );
  const showCommentsDisabledHint = Boolean(
    commentContext &&
    renderDiffFile &&
    renderDiffFile.unifiedLineLength > COMMENTS_MAX_LINES,
  );

  /** 按行号把评论挂到 extendData；行号已不存在的评论收进孤儿列表兜底展示。 */
  const { extendData, orphanComments } = useMemo(() => {
    if (!commentsEnabled || !commentContext || !renderDiffFile) {
      return {
        extendData: undefined,
        orphanComments: [] as DiffReviewCommentRecord[],
      };
    }
    const oldFile: Record<string, { data: CommentLineData }> = {};
    const newFile: Record<string, { data: CommentLineData }> = {};
    const orphans: DiffReviewCommentRecord[] = [];
    for (const comment of commentContext.comments) {
      const lineContent =
        comment.side === "old"
          ? renderDiffFile.getOldPlainLine(comment.lineNumber)?.value
          : renderDiffFile.getNewPlainLine(comment.lineNumber)?.value;
      if (lineContent === undefined) {
        orphans.push(comment);
        continue;
      }
      const target = comment.side === "old" ? oldFile : newFile;
      const key = String(comment.lineNumber);
      if (!target[key]) {
        target[key] = { data: { lineContent, comments: [] } };
      }
      target[key].data.comments.push(comment);
    }
    return { extendData: { oldFile, newFile }, orphanComments: orphans };
  }, [commentContext, commentsEnabled, renderDiffFile]);

  const renderCommentWidgetLine = useCallback(
    ({
      side,
      lineNumber,
      onClose,
    }: {
      diffFile: DiffFile;
      side: SplitSide;
      lineNumber: number;
      onClose: () => void;
    }): React.ReactNode => {
      if (!commentContext) {
        return null;
      }
      const sideKey: DiffCommentSide = side === SplitSide.old ? "old" : "new";
      return (
        <DiffCommentComposer
          filePath={fileName}
          side={sideKey}
          lineNumber={lineNumber}
          onSubmit={(content) => {
            const lineContent =
              (sideKey === "old"
                ? renderDiffFile?.getOldPlainLine(lineNumber)?.value
                : renderDiffFile?.getNewPlainLine(lineNumber)?.value) ?? "";
            commentContext.onCreate({
              side: sideKey,
              lineNumber,
              lineContent,
              content,
            });
            onClose();
          }}
          onCancel={onClose}
        />
      );
    },
    [commentContext, fileName, renderDiffFile],
  );

  const renderCommentExtendLine = useCallback(
    ({
      side,
      data,
    }: {
      diffFile: DiffFile;
      side: SplitSide;
      lineNumber: number;
      data: CommentLineData;
      onUpdate: () => void;
    }): React.ReactNode => {
      if (!commentContext) {
        return null;
      }
      return (
        <DiffCommentList
          comments={data.comments}
          filePath={fileName}
          currentLineContent={data.lineContent}
          onUpdate={commentContext.onUpdate}
          onDelete={commentContext.onDelete}
        />
      );
    },
    [commentContext, fileName],
  );

  const useIncremental =
    mode === DiffModeEnum.Unified &&
    renderDiffFile !== null &&
    !commentsEnabled;

  return (
    <div className="git-diff-view" ref={containerRef}>
      {showCommentsDisabledHint ? (
        <div className="diff-comments-disabled-hint">
          {t("diffComments.disabledLargeFile")}
        </div>
      ) : null}
      {patchMissingHunks ? (
        <div className="git-diff-view-empty">
          {t("rightPanel.diffUnavailable")}
        </div>
      ) : useIncremental && renderDiffFile ? (
        <IncrementalUnifiedDiffView
          diffFile={renderDiffFile}
          fontSize={fontSize}
          enableWrap={wrapLines}
        />
      ) : renderDiffFile ? (
        <DiffView
          diffFile={renderDiffFile}
          diffViewMode={mode}
          diffViewTheme={theme}
          diffViewHighlight
          diffViewWrap={wrapLines}
          diffViewFontSize={fontSize}
          diffViewAddWidget={commentsEnabled}
          extendData={commentsEnabled ? extendData : undefined}
          renderWidgetLine={
            commentsEnabled ? renderCommentWidgetLine : undefined
          }
          renderExtendLine={
            commentsEnabled ? renderCommentExtendLine : undefined
          }
        />
      ) : null}
      {commentsEnabled && commentContext && orphanComments.length > 0 ? (
        <DiffCommentOrphanSection
          comments={orphanComments}
          filePath={fileName}
          onUpdate={commentContext.onUpdate}
          onDelete={commentContext.onDelete}
        />
      ) : null}
    </div>
  );
};
