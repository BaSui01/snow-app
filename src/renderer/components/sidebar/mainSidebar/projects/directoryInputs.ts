import type {
  WorkspaceDirectoryInput,
  WorkspaceDirectoryKind,
  WorkspaceDirectoryRecord,
} from "../../../../../preload";
import { getAutoDirectoryName } from "../directoryDisplayName";

export const createDirectoryId = (
  kind: WorkspaceDirectoryKind,
  path: string,
): string => `${kind}:${path.trim()}`;

export const toWorkspaceDirectoryInput = (
  path: string,
  kind: WorkspaceDirectoryKind,
  existingCount: number,
): WorkspaceDirectoryInput => {
  const trimmedPath = path.trim();

  return {
    directoryId: createDirectoryId(kind, trimmedPath),
    name: getAutoDirectoryName(kind, trimmedPath),
    path: trimmedPath,
    kind,
    isActive: true,
    sortOrder: existingCount,
    source: "manual",
  };
};

export const toPersistableDirectoryInput = (
  directory: WorkspaceDirectoryRecord,
  sortOrder: number,
): WorkspaceDirectoryInput => ({
  directoryId: directory.directoryId,
  name: directory.name,
  path: directory.path,
  kind: directory.kind,
  isActive: directory.isActive,
  sortOrder,
  source: directory.source,
});

const RELINKABLE_PATH_STATES = new Set([
  "missing",
  "mismatch",
  "permission_error",
]);

// 可重新定位的失效状态：磁盘未挂载（offline）不算，避免外置盘未插时误导用户迁移
export const isRelinkablePath = (
  directory: WorkspaceDirectoryRecord | null | undefined,
): boolean =>
  Boolean(
    directory &&
    directory.kind !== "ssh" &&
    RELINKABLE_PATH_STATES.has(directory.pathState),
  );

export const isOfflinePath = (
  directory: WorkspaceDirectoryRecord | null | undefined,
): boolean =>
  Boolean(
    directory && directory.kind !== "ssh" && directory.pathState === "offline",
  );

export const parseUnavailableState = (message: string): string =>
  message.split("WORKSPACE_DIRECTORY_UNAVAILABLE:")[1]?.split(":")[0] ?? "";

/**
 * 按 git 的默认命名规则从仓库地址推导项目目录名：去掉末尾 `.git`
 * 后缀与斜杠后取最后一段，与 Rust 端 clone_git_repository 的命名
 * 逻辑保持一致（仅用于对话框中的最终路径预览）。
 */
export const deriveRepoNameFromUrl = (repoUrl: string): string => {
  const trimmed = repoUrl.trim().replace(/[\\/]+$/, "");
  const withoutSuffix = trimmed.endsWith(".git")
    ? trimmed.slice(0, -".git".length)
    : trimmed;
  const segments = withoutSuffix.split(/[/:\\]/).filter(Boolean);
  return segments[segments.length - 1] ?? "";
};

/** 拼接克隆的最终目录路径（分隔符跟随所选父目录的风格）。 */
export const joinCloneTargetPath = (
  parentPath: string,
  repoName: string,
): string => {
  const separator = parentPath.includes("\\") ? "\\" : "/";
  return `${parentPath.replace(/[\\/]+$/, "")}${separator}${repoName}`;
};
