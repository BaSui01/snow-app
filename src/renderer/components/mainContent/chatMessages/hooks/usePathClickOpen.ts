import { useCallback, useEffect } from "react";
import { useI18n } from "../../../../i18n";
import {
  openResolvedLocalEntry,
  openResolvedRemoteEntry,
} from "../../../../utils/fileLinkOpen";
import { localFileUrlToPath } from "../../../../utils/localFileUrl";
import {
  isFileLinkHref,
  openBrowserFile,
} from "../../../../utils/browserFileOpen";

/** 启发式判断文本是否像文件路径（含分隔符，或是带扩展名的文件名）。 */
const looksLikePath = isFileLinkHref;

/** 解析 `path:line`、`path:start-end` 或 Markdown `path#Lline`。 */
const parsePathWithLine = (raw: string): { path: string; line?: number } => {
  const cleaned = raw.replace(/^["'`]+|["'`]+$/g, "").trim();
  const hashMatch = cleaned.match(/^(.+?)#L(\d+)(?:-L?\d+)?$/i);
  if (hashMatch) {
    return { path: hashMatch[1], line: parseInt(hashMatch[2], 10) };
  }
  if (/^file:/i.test(cleaned)) return { path: cleaned };
  // 冒号后必须为纯数字，避免误伤 Windows 盘符（C:\foo）。
  const lineMatch = cleaned.match(/^(.+):(\d+)(?:[-–](\d+))?$/);
  if (lineMatch) {
    return { path: lineMatch[1], line: parseInt(lineMatch[2], 10) };
  }
  return { path: cleaned };
};

const decodeHref = (href: string): string => {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
};

/** 当前存在非空文本选区（拖选文字时松开鼠标同样会触发 click，不应误开文件）。 */
const hasTextSelection = (): boolean => {
  const selection = window.getSelection();
  return (
    selection != null &&
    !selection.isCollapsed &&
    selection.toString().trim().length > 0
  );
};

/** worker 标记为文件路径的 inline code（见 markdownWorker 的 code_inline 规则）。 */
const FILE_PATH_CODE_SELECTOR = "code.md-file-path[data-file-path]";
const FILE_PATH_MISSING_CLASS = "md-file-path-missing";

/**
 * 聊天区路径点击 → 打开文件 的容器级委托。
 *
 * 性能设计：
 * - 渲染零扫描：不遍历消息文本，仅在用户点击时识别目标元素。
 * - 单一委托：挂在常驻 chat-area，兼容消息虚拟化及 DOM 动态增删。
 * - Ctrl 状态用 body.classList 驱动纯 CSS，不触发 React re-render。
 *
 * 普通点击：正文里被识别为文件路径的 inline code 与非 http(s) 的文件链接。
 * Ctrl(+Meta)+点击，识别优先级：
 * 1. [data-path]：工具调用组件显式标记（精确）
 * 2. Markdown 文件链接的 href（启发式）
 * 3. inline code，排除 pre > code（启发式）
 * 4. [title] 中的完整路径（兜底）
 *
 * 路径先解析为真实存在的条目——本地工作区经 Rust（相对项目根 / 项目内后缀查找），
 * SSH 工作区经主进程远端 stat / find：目录在资源管理器中展开高亮，本地文档与
 * 媒体类文件交给系统默认应用，其余在右侧文件阅读器中打开；找不到时给触发元素
 * 打上「未找到」标记。
 */
export const usePathClickOpen = (
  directoryPath: string | undefined,
  directoryId: string | undefined,
): {
  onClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  onAuxClick: (event: React.MouseEvent<HTMLDivElement>) => void;
} => {
  const { t } = useI18n();

  useEffect(() => {
    const updateHeld = (held: boolean): void => {
      document.body.classList.toggle("ctrl-held", held);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey) {
        updateHeld(true);
      }
    };
    const handleKeyUp = (event: KeyboardEvent): void => {
      if (!event.ctrlKey && !event.metaKey) {
        updateHeld(false);
      }
    };
    const handleBlur = (): void => updateHeld(false);

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
      updateHeld(false);
    };
  }, []);

  const openPath = useCallback(
    (raw: string, lineAttr?: string, source?: HTMLElement): void => {
      const parsed = parsePathWithLine(raw);
      const isFileUrl = /^file:/i.test(parsed.path);
      // A file URL is explicitly local, never reinterpret it as an SSH path.
      if (isFileUrl && directoryPath?.startsWith("ssh://")) {
        return;
      }
      const path = isFileUrl ? localFileUrlToPath(parsed.path) : parsed.path;
      if (!path) {
        return;
      }
      // 仅接受本地路径与 ssh:// —— 其他 scheme（http、data、javascript 等）
      // 不当作文件引用处理。
      const explicitSsh = /^ssh:\/\//i.test(path);
      if (
        /^[a-z][a-z0-9+.-]*:/i.test(path) &&
        !/^[a-z]:[\\/]/i.test(path) &&
        !explicitSsh
      ) {
        return;
      }
      const attrLine = lineAttr ? parseInt(lineAttr, 10) : undefined;
      const candidateLine = parsed.line ?? attrLine;
      const focusLine =
        candidateLine && candidateLine > 0 ? candidateLine : undefined;

      const sshWorkspacePath = explicitSsh
        ? path
        : directoryPath?.startsWith("ssh://")
          ? directoryPath
          : null;
      const resolving = sshWorkspacePath
        ? window.snow.sshResolveFileLink(sshWorkspacePath, path)
        : window.snow.resolveFileLink(directoryPath ?? null, path);

      void resolving
        .then((resolved) => {
          if (!resolved) {
            if (source) {
              source.classList.add(FILE_PATH_MISSING_CLASS);
              source.title = t("markdown.filePathNotFound");
            }
            return;
          }
          if (sshWorkspacePath) {
            openResolvedRemoteEntry(
              resolved,
              { workspacePath: sshWorkspacePath, directoryId },
              focusLine,
            );
            return;
          }
          // HTML / PDF / 图片等浏览器可预览的本地文件在内置浏览器中打开。
          if (openBrowserFile(resolved.path)) {
            return;
          }
          openResolvedLocalEntry(resolved, focusLine);
        })
        .catch((error: unknown) => {
          console.error("Failed to resolve file path from chat", error);
        });
    },
    [directoryId, directoryPath, t],
  );

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      if (!event.ctrlKey && !event.metaKey) {
        if (event.button !== 0 || hasTextSelection()) {
          return;
        }
        // 正文中被识别为文件路径的 inline code：普通点击即打开。
        const pathCode = target.closest<HTMLElement>(FILE_PATH_CODE_SELECTOR);
        if (pathCode && !pathCode.closest("a[href]")) {
          event.preventDefault();
          openPath(pathCode.dataset.filePath ?? "", undefined, pathCode);
          return;
        }
        // 非 http(s) 的文件链接：拦截默认导航（渲染进程导航到相对 URL
        // 会让整个前端白屏），改为打开文件。
        const anchor = target.closest<HTMLAnchorElement>("a[href]");
        if (anchor) {
          const href = anchor.getAttribute("href")?.trim() ?? "";
          if (/^https?:\/\//i.test(href)) {
            return;
          }
          const decoded = /^file:/i.test(href) ? href : decodeHref(href);
          if (looksLikePath(decoded)) {
            event.preventDefault();
            openPath(decoded, undefined, anchor);
          }
        }
        return;
      }

      // 1) 工具组件显式标记的路径，优先级最高。
      const pathEl = target.closest<HTMLElement>("[data-path]");
      if (pathEl) {
        const raw = pathEl.dataset.path;
        if (raw) {
          event.preventDefault();
          openPath(raw, pathEl.dataset.line);
          return;
        }
      }

      // 2) Markdown 链接：HTTP(S) 保持现有右侧浏览器行为；
      // 非 HTTP 且 href 像文件路径时，按文件链接处理。
      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (anchor) {
        const href = anchor.getAttribute("href")?.trim() ?? "";
        if (/^https?:\/\//i.test(href)) {
          return;
        }
        const decoded = /^file:/i.test(href) ? href : decodeHref(href);
        if (looksLikePath(decoded)) {
          event.preventDefault();
          openPath(decoded, undefined, anchor);
        }
        return;
      }

      // 3) Markdown inline code（排除代码块，降低命令文本误判）。
      const codeEl = target.closest<HTMLElement>("code");
      if (codeEl && !codeEl.closest("pre")) {
        const text = codeEl.textContent?.trim();
        if (text && looksLikePath(text)) {
          event.preventDefault();
          openPath(text, undefined, codeEl);
          return;
        }
      }

      // 4) title 携带完整路径的元素（tool call header 等兜底）。
      const titledEl = target.closest<HTMLElement>("[title]");
      if (titledEl) {
        const title = titledEl.getAttribute("title")?.trim();
        if (title && looksLikePath(title)) {
          event.preventDefault();
          openPath(title);
        }
      }
    },
    [openPath],
  );

  // auxclick 与 click 共用同一处理：Chromium 中 Ctrl/Cmd+点击或中键点击
  // 触发的是 auxclick 事件，其“新标签打开”默认行为只有 auxclick 的
  // preventDefault 才能阻止；若只挂 onClick，Ctrl+点击 <a href> 会降级为
  // 当前窗口导航，导致整个前端刷新、进行中的会话/生成全部中断。
  return { onClick: handleClick, onAuxClick: handleClick };
};
