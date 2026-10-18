import { posix } from "node:path";
import { shellQuote, withSshSession } from "./remoteWorkspaceCommand";
import { executeSshCommand, statSshEntry } from "./sshManager";

/**
 * SSH 工作区中的文件路径引用解析（与本地 Rust 端 fs_explorer::link 的规则一致）：
 * 绝对路径直接校验存在性；否则按「工作区根 + 相对路径」拼接；仍不存在时在
 * 工作区内按路径后缀查找（模型常只写名称或路径后半段），返回层级最浅的命中。
 */

export type RemoteResolvedFileLink = {
  path: string;
  isDirectory: boolean;
};

const MAX_RAW_PATH_LEN = 1024;
const SUFFIX_SEARCH_MAX_DEPTH = 15;
const SUFFIX_SEARCH_MAX_CANDIDATES = 200;
const SUFFIX_SEARCH_TIMEOUT_MS = 15_000;
// 与远程文件搜索保持一致的跳过目录（依赖、构建产物、VCS 元数据）。
const SKIP_DIRS = [
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  ".next",
  ".snow",
];

/** 规范化为远端绝对路径：统一分隔符、折叠 `.` / `..` / 重复分隔符。 */
const normalizeAbsolute = (path: string): string =>
  posix.normalize(`/${path}`).replace(/\/+$/, "") || "/";

/** find -name 的参数按 glob 解释，名称中的通配字符需转义成字面量。 */
const escapeFindGlob = (name: string): string =>
  name.replace(/[\\*?[\]]/g, (char) => `\\${char}`);

const statEntry = async (
  sessionId: string,
  path: string,
): Promise<RemoteResolvedFileLink | null> => {
  const stats = await statSshEntry(sessionId, path);
  return stats ? { path, isDirectory: stats.isDirectory() } : null;
};

const findBySuffix = async (
  sessionId: string,
  root: string,
  segments: string[],
): Promise<RemoteResolvedFileLink | null> => {
  const name = segments[segments.length - 1];
  const prune = SKIP_DIRS.map((dir) => `-name ${shellQuote(dir)}`).join(" -o ");
  const command =
    `find ${shellQuote(root)} -maxdepth ${SUFFIX_SEARCH_MAX_DEPTH} ` +
    `\\( -type d \\( ${prune} \\) -prune \\) -o ` +
    `-name ${shellQuote(escapeFindGlob(name))} -print 2>/dev/null ` +
    `| head -n ${SUFFIX_SEARCH_MAX_CANDIDATES}`;
  const output = await executeSshCommand(sessionId, command, {
    timeoutMs: SUFFIX_SEARCH_TIMEOUT_MS,
  });
  const suffix = `/${segments.join("/")}`;
  const candidate = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(suffix) && line !== root)
    .sort((a, b) => a.split("/").length - b.split("/").length)[0];
  return candidate ? statEntry(sessionId, candidate) : null;
};

export const resolveRemoteFileLink = (
  workspacePath: string,
  rawPath: string,
): Promise<RemoteResolvedFileLink | null> =>
  withSshSession(workspacePath, async (sessionId, rootPath) => {
    const raw = rawPath
      .trim()
      .replace(/^ssh:\/\/[^/]+/, "")
      .replace(/\\/g, "/");
    // Windows 盘符路径不可能出现在远端文件系统中。
    if (!raw || raw.length > MAX_RAW_PATH_LEN || /^[a-zA-Z]:\//.test(raw)) {
      return null;
    }
    const root = normalizeAbsolute(rootPath);

    if (raw.startsWith("/")) {
      const found = await statEntry(sessionId, normalizeAbsolute(raw));
      if (found) {
        return found;
      }
    }

    const relative = raw.replace(/^\/+/, "");
    if (!relative) {
      return null;
    }
    const joined = await statEntry(
      sessionId,
      normalizeAbsolute(posix.join(root, relative)),
    );
    if (joined) {
      return joined;
    }

    // 含 `..` 的路径无法做后缀匹配。
    const segments = relative
      .split("/")
      .filter((segment) => segment && segment !== ".");
    if (segments.length === 0 || segments.includes("..")) {
      return null;
    }
    return findBySuffix(sessionId, root, segments);
  });
