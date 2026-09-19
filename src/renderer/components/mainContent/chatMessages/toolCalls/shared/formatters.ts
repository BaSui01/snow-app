export const getFileName = (filePath: string): string =>
  filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;

/**
 * 判断两个路径是否指向同一文件：去首尾空白、统一分隔符、大小写不敏感
 * （Windows 卷大小写不敏感，SSH 工作区路径同样按此归一化比较）。
 * 仅用于 UI 判定，例如复制工具区分「同文件移动」与「跨文件剪切」。
 */
export const pathsReferToSameFile = (left: string, right: string): boolean => {
  if (!left || !right) {
    return false;
  }
  const normalize = (path: string): string =>
    path.trim().replace(/\\/g, "/").toLowerCase();
  return normalize(left) === normalize(right);
};
