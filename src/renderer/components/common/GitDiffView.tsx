import { useEffect, useMemo, useRef, useState } from "react";
import { DiffModeEnum, DiffView, getLang } from "@git-diff-view/react";
import { DiffFile, generateDiffFile } from "@git-diff-view/file";

import "@git-diff-view/react/styles/diff-view.css";

import { useI18n } from "../../i18n";

// 从独立模块导入（仅依赖 "diff" 库），并重新导出保持现有导入路径兼容。
import { generateComparePatch } from "../../utils/generateComparePatch";
export {
  generateComparePatch,
  getCompareDiffStats,
} from "../../utils/generateComparePatch";

type DiffTheme = "light" | "dark";

/** 容器宽度达到该值时使用双列(Split)模式,否则使用单列(Unified)模式 */
const SPLIT_MIN_WIDTH = 720;

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
};

/**
 * 基于 @git-diff-view/react 的统一差异查看组件。
 *
 * - git 模式: 传入 patch(git 原始 diff 文本)。
 * - 对比模式: 传入 oldContent / newContent,内部通过 jsdiff 生成差异。
 * - 自动跟随全局亮/暗主题,并根据容器宽度自动切换单/双列显示。
 */
export const GitDiffView = ({
  fileName,
  patch,
  oldContent,
  newContent,
  fontSize = 12,
  oldStartLine,
  newStartLine,
}: GitDiffViewProps): React.JSX.Element => {
  const theme = useDiffViewTheme();
  const { containerRef, mode } = useAutoDiffMode();
  const { t } = useI18n();

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
   * 当提供了 oldStartLine/newStartLine 时,说明 oldContent/newContent 是文件片段而非完整文件。
   * 复用 generateComparePatch 生成带正确行号偏移的 unified diff 文本,
   * 再预构建 DiffFile 实例(与 compareDiffFile 一致),避免 data 模式的异步初始化导致渲染闪烁。
   */
  const offsetDiffFile = useMemo<DiffFile | null>(() => {
    if (patch) {
      return null;
    }
    const oldStr = oldContent ?? "";
    const newStr = newContent ?? "";
    if (
      (oldStartLine == null || oldStartLine <= 1) &&
      (newStartLine == null || newStartLine <= 1)
    ) {
      return null;
    }

    const patchText = generateComparePatch(
      fileName,
      oldStr,
      newStr,
      oldStartLine,
      newStartLine,
    );
    if (!patchText) {
      return null;
    }

    try {
      const lang = getLang(fileName);
      const diffFile = new DiffFile(
        fileName,
        "",
        fileName,
        "",
        [patchText],
        lang,
        lang,
      );
      diffFile.initTheme(theme);
      diffFile.initRaw();
      diffFile.init();
      diffFile.buildSplitDiffLines();
      diffFile.buildUnifiedDiffLines();
      return diffFile;
    } catch {
      return null;
    }
  }, [
    patch,
    fileName,
    oldContent,
    newContent,
    oldStartLine,
    newStartLine,
    theme,
  ]);

  const patchData = useMemo(
    () =>
      patch
        ? {
            oldFile: { fileName, content: null as string | null },
            newFile: { fileName, content: null as string | null },
            hunks: [patch],
          }
        : null,
    [patch, fileName],
  );

  const compareDiffFile = useMemo<DiffFile | null>(() => {
    if (patch || offsetDiffFile) {
      return null;
    }
    const lang = getLang(fileName);
    const diffFile = generateDiffFile(
      fileName,
      oldContent ?? "",
      fileName,
      newContent ?? "",
      lang,
      lang,
    );
    diffFile.initTheme(theme);
    diffFile.init();
    diffFile.buildSplitDiffLines();
    diffFile.buildUnifiedDiffLines();
    return diffFile;
  }, [patch, offsetDiffFile, fileName, oldContent, newContent, theme]);

  const renderDiffFile = patchData ? null : (offsetDiffFile ?? compareDiffFile);

  return (
    <div className="git-diff-view" ref={containerRef}>
      {patchMissingHunks ? (
        <div className="git-diff-view-empty">
          {t("rightPanel.diffUnavailable")}
        </div>
      ) : patchData ? (
        <DiffView
          data={patchData}
          diffViewMode={mode}
          diffViewTheme={theme}
          diffViewHighlight
          diffViewWrap
          diffViewFontSize={fontSize}
        />
      ) : renderDiffFile ? (
        <DiffView
          diffFile={renderDiffFile}
          diffViewMode={mode}
          diffViewTheme={theme}
          diffViewHighlight
          diffViewWrap
          diffViewFontSize={fontSize}
        />
      ) : null}
    </div>
  );
};
