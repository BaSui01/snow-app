import type { ResolvedFileLink } from "../../preload";
import {
  explorerRevealStore,
  relativePathSegments,
} from "../components/common/explorerRevealStore";
import { rightPanelEvents } from "../components/rightPanel/rightPanelEvents";

/**
 * 交给系统默认应用打开的文件类型：Office / WPS / PDF 等文档与常见音视频。
 * 文件阅读器只能抽取它们的纯文本或干脆无法显示，用本机关联的应用
 * （Office、WPS、PDF 阅读器、播放器）打开体验更完整。
 *
 * 只收录文档与媒体类扩展名：系统默认打开对可执行文件 / 脚本等同于直接运行，
 * 绝不能放进这个白名单。
 */
const SYSTEM_APP_EXTENSIONS = new Set([
  "pdf",
  "doc",
  "docx",
  "docm",
  "dot",
  "dotx",
  "xls",
  "xlsx",
  "xlsm",
  "xlsb",
  "ppt",
  "pptx",
  "pptm",
  "pps",
  "ppsx",
  "odt",
  "ods",
  "odp",
  "rtf",
  "wps",
  "wpt",
  "et",
  "ett",
  "dps",
  "dpt",
  "pages",
  "numbers",
  "vsd",
  "vsdx",
  "mpp",
  "mp3",
  "wav",
  "flac",
  "aac",
  "m4a",
  "ogg",
  "mp4",
  "mov",
  "avi",
  "mkv",
  "wmv",
  "webm",
]);

/** 路径是否应交给系统默认应用打开（按扩展名判断）。 */
const shouldOpenWithSystemApp = (filePath: string): boolean => {
  const name = filePath.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) {
    return false;
  }
  return SYSTEM_APP_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
};

/** 用系统默认应用打开本地文件或目录；失败只记录日志，不打断用户操作。 */
const openWithSystemApp = (filePath: string): void => {
  void window.snow
    .openPathWithSystemApp(filePath)
    .then((error) => {
      if (error) {
        console.warn("[file-link] open with system app failed:", error);
      }
    })
    .catch((error: unknown) => {
      console.warn("[file-link] open with system app failed:", error);
    });
};

/**
 * 在资源管理器中定位目录：按最长前缀匹配所属的本地工作区，交给侧栏打开
 * 资源管理器并展开高亮；不属于任何工作区时用系统文件管理器打开。
 */
const revealDirectoryInExplorer = async (dirPath: string): Promise<void> => {
  const directories = await window.snow.listWorkspaceDirectories();
  let owner: { directoryId: string; path: string } | null = null;
  for (const directory of directories) {
    if (directory.path.startsWith("ssh://")) {
      continue;
    }
    if (
      relativePathSegments(directory.path, dirPath) !== null &&
      (!owner || directory.path.length > owner.path.length)
    ) {
      owner = directory;
    }
  }
  if (!owner) {
    openWithSystemApp(dirPath);
    return;
  }
  explorerRevealStore.request({
    directoryId: owner.directoryId,
    rootPath: owner.path,
    path: dirPath,
  });
};

/**
 * 打开一个已确认存在的本地条目：目录在资源管理器中定位，文档 / 媒体类文件
 * 交给系统默认应用，其余在右侧文件阅读器中打开（可定位行号）。
 */
export const openResolvedLocalEntry = (
  entry: ResolvedFileLink,
  focusLine?: number,
): void => {
  if (entry.isDirectory) {
    void revealDirectoryInExplorer(entry.path).catch((error: unknown) => {
      console.warn("[file-link] reveal directory failed:", error);
    });
    return;
  }
  if (shouldOpenWithSystemApp(entry.path)) {
    openWithSystemApp(entry.path);
    return;
  }
  rightPanelEvents.emit("open-file", {
    filePath: entry.path,
    isSsh: false,
    focusLine,
  });
};

/** 路径引用所在的 SSH 工作区。 */
export type RemoteLinkWorkspace = {
  /** 工作区 ssh:// 路径 */
  workspacePath: string;
  /** 工作区目录 id（资源管理器定位与远程草稿需要） */
  directoryId?: string;
  /** 已有的远程会话（文件阅读器内跳转时复用） */
  sshSessionId?: string | null;
};

/**
 * 打开一个已确认存在的 SSH 工作区条目（远端绝对路径）：工作区内的目录在
 * 资源管理器中定位，文件在右侧文件阅读器中打开。远端文件无法直接交给本机
 * 默认应用，文档类同样在文件阅读器中预览。
 */
export const openResolvedRemoteEntry = (
  entry: ResolvedFileLink,
  workspace: RemoteLinkWorkspace,
  focusLine?: number,
): void => {
  if (entry.isDirectory) {
    const remoteRoot =
      workspace.workspacePath.replace(/^ssh:\/\/[^/]+/, "") || "/";
    if (
      workspace.directoryId &&
      relativePathSegments(remoteRoot, entry.path) !== null
    ) {
      explorerRevealStore.request({
        directoryId: workspace.directoryId,
        rootPath: workspace.workspacePath,
        path: entry.path,
      });
    }
    return;
  }
  rightPanelEvents.emit("open-file", {
    filePath: entry.path,
    isSsh: true,
    sshSessionId: workspace.sshSessionId ?? undefined,
    sshWorkspacePath: workspace.workspacePath,
    sshWorkspaceId: workspace.directoryId,
    focusLine,
  });
};
