import type { GitCommitFile, GitFileStatus } from "../../../../preload";

/** 将提交文件（GitCommitFile）转换为 DiffTab 所需的 GitFileStatus 形状。 */
export const toGitFileStatus = (file: GitCommitFile): GitFileStatus => ({
  path: file.path,
  oldPath: null,
  indexStatus: "",
  workdirStatus: "",
  status: file.status,
});

/** 图片文件直接渲染图片而非文本 diff（文本 diff 会因二进制 --text
 *  重试产生巨大乱码 patch 而卡死）。 */
export const isImageFile = (path: string): boolean =>
  /\.(png|jpe?g|gif|bmp|webp|ico|svg|tiff?|avif)$/i.test(path);

export function formatDate(dateStr: string): string {
  return dateStr.split(" ")[0];
}

export function getCommitFileColor(status: string): string {
  if (status.startsWith("A")) return "git-status-add";
  if (status.startsWith("D")) return "git-status-delete";
  if (status.startsWith("R")) return "git-status-rename";
  return "git-status-modify";
}

export function getCommitFileLabel(status: string): string {
  if (status.startsWith("A")) return "A";
  if (status.startsWith("D")) return "D";
  if (status.startsWith("R")) return "R";
  if (status.startsWith("C")) return "C";
  if (status.startsWith("M")) return "M";
  return status.charAt(0);
}

const normalizePath = (path: string): string =>
  path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export function isOtherWorktreePath(
  wtPath: string | null | undefined,
  repoPath: string,
): boolean {
  if (!wtPath) return false;
  return normalizePath(wtPath) !== normalizePath(repoPath);
}

export function getWorktreeFolderName(wtPath: string): string {
  const parts = wtPath.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || wtPath;
}
