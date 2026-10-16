import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { homedir } from "node:os";
import {
  basename as localBasename,
  dirname as localDirname,
  join as joinLocalPath,
} from "node:path";
import type { NativeBridge, RemoteDraftInput } from "../../native/types";
import {
  connectSsh,
  disconnectSsh,
  executeSshCommand,
  listSshDirectory,
  parseSshUrl,
  probeSshCapabilities,
  isSshPath,
  readSshFile,
  readSshFileWithVersion,
  resolveSshWorkspaceRoot,
  writeSshFile,
  deleteSshFile,
  renameSshFile,
  deleteSshDirectory,
  statSshEntry,
  type SshAuthMethod,
  type SshConnectParams,
  type SshFileVersion,
  type SshJumpHost,
} from "../../ssh/sshManager";
import { sshConnectionManager } from "../../ssh/sshConnectionManager";
import {
  cancelSshTransfer,
  classifySshDownloadSources,
  classifySshUploadSources,
  clearFinishedSshTransfers,
  createSshDownloadBatch,
  createSshUploadBatch,
  getSshTransferSnapshot,
  initSshTransferWorkspaceLookup,
  resolveSshTransferConflict,
  shutdownSshTransfers,
  watchSshTransferOwner,
  type SshTransferConflictAction,
} from "../../ssh/sshTransferManager";
import { sanitizeLocalFileName } from "../../ssh/sshFileTransfer";
import {
  getLastDownloadDir,
  setLastDownloadDir,
} from "../../ssh/sshTransferPrefs";
import { tMain } from "../../i18n/mainI18n";
import { processFileContent } from "../../utils/fileReader";
import {
  saveSshCredentialWithPlainSecret,
  getSshCredential,
  getDecryptedSecret,
  getDecryptedJumpSecret,
  listSshCredentials,
  deleteSshCredential,
} from "../../ssh/sshCredentials";
import {
  listSshConfigHosts,
  resolveSshConfigJumpHost,
} from "../../ssh/sshConfig";
import { buildSshConnectParams } from "../../ssh/remoteWorkspaceCommand";
import { classifySshConnectError } from "../../ssh/sshErrors";

const REMOTE_SEARCH_MAX_DEPTH = 15;
const REMOTE_SEARCH_MAX_RESULTS = 200;

const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, `'"'"'`)}'`;

const normalizeRemotePath = (path: string): string => {
  const normalized = path.replace(/\/+$/, "");
  return normalized || "/";
};

const getRemoteRelativePath = (path: string, rootPath: string): string => {
  const normalizedPath = normalizeRemotePath(path);
  const normalizedRoot = normalizeRemotePath(rootPath);

  if (normalizedPath === normalizedRoot) {
    return ".";
  }
  if (normalizedRoot === "/") {
    return normalizedPath.replace(/^\/+/, "");
  }
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }

  return normalizedPath.replace(/^\/+/, "");
};

const buildRemoteWorkspaceUri = (
  workspacePath: string,
  remotePath: string,
  remoteRootPath: string,
): string => {
  const relativePath = getRemoteRelativePath(remotePath, remoteRootPath);
  const normalizedWorkspacePath = workspacePath.replace(/\/+$/, "");

  return relativePath === "."
    ? normalizedWorkspacePath
    : `${normalizedWorkspacePath}/${relativePath}`;
};

const getRemotePathName = (path: string): string => {
  const normalizedPath = normalizeRemotePath(path);
  const separatorIndex = normalizedPath.lastIndexOf("/");
  return normalizedPath.slice(separatorIndex + 1) || "/";
};

const toRemoteWorkspaceSearchResult = (
  workspacePath: string,
  remotePath: string,
  remoteRootPath: string,
  isDirectory: boolean,
): {
  path: string;
  relativePath: string;
  name: string;
  isDirectory: boolean;
  matchedName: boolean;
  lineMatches: Array<{ line: number; text: string }>;
} => ({
  path: buildRemoteWorkspaceUri(workspacePath, remotePath, remoteRootPath),
  relativePath: getRemoteRelativePath(remotePath, remoteRootPath),
  name: getRemotePathName(remotePath),
  isDirectory,
  matchedName: true,
  lineMatches: [],
});

const buildRemoteWorkspaceSearchCommand = (
  rootPath: string,
  query: string,
): string => {
  // Path-aware search: a query containing "/" (e.g. "prompt/" or
  // "prompt/utils") resolves the part before the last "/" as a directory
  // path and lists the directory itself plus its children.
  if (query.includes("/")) {
    return buildRemoteWorkspacePathSearchCommand(rootPath, query);
  }

  const script = [
    `root=${shellQuote(rootPath)}`,
    `query=${shellQuote(query)}`,
    `max_depth=${REMOTE_SEARCH_MAX_DEPTH}`,
    `max_results=${REMOTE_SEARCH_MAX_RESULTS}`,
    "count=0",
    'find "$root" -maxdepth "$max_depth" \\( -type d \\( -name .git -o -name node_modules -o -name target -o -name dist -o -name build -o -name .next -o -name .snow \\) -prune \\) -o -mindepth 1 -print | while IFS= read -r path; do',
    '  [ "$count" -ge "$max_results" ] && break',
    "  name=${path##*/}",
    '  case "$name" in .* ) continue ;; esac',
    "  lower_name=$(printf '%s' \"$name\" | tr '[:upper:]' '[:lower:]')",
    "  lower_query=$(printf '%s' \"$query\" | tr '[:upper:]' '[:lower:]')",
    '  if printf \'%s\' "$lower_name" | grep -Fq -- "$lower_query"; then',
    '    if [ -d "$path" ]; then kind=d; else kind=f; fi',
    '    printf \'%s\\t%s\\n\' "$kind" "$path"',
    "    count=$((count + 1))",
    "  fi",
    "done",
  ].join("\n");

  return `sh -lc ${shellQuote(script)}`;
};

// Path-aware search for remote workspaces: resolves the directory path from
// the query segments, then lists the directory itself (when it is not the
// workspace root) and its direct children filtered by the trailing name
// query (empty means list all). Falls back to the regular name search when
// the directory does not exist.
const buildRemoteWorkspacePathSearchCommand = (
  rootPath: string,
  query: string,
): string => {
  const parts = query.split("/");
  const nameQuery = parts[parts.length - 1] ?? "";
  const dirParts = parts.slice(0, -1).filter(Boolean);
  const dirPath =
    dirParts.length === 0
      ? rootPath
      : `${rootPath}/${dirParts.join("/")}`.replace(/\/+/g, "/");
  // Directory segment used for workspace-wide matching when the exact
  // directory does not exist (e.g. "prompt" for "prompt/utils/").
  const matchSegment = dirParts[0] ?? nameQuery;

  // Workspace-wide fallback: collect directories at any depth whose name
  // starts with the first query segment, then list each directory itself
  // plus its direct children filtered by the trailing name query.
  const fallbackScript = [
    `root=${shellQuote(rootPath)}`,
    `seg=${shellQuote(matchSegment)}`,
    `name_query=${shellQuote(nameQuery)}`,
    `max_depth=${REMOTE_SEARCH_MAX_DEPTH}`,
    `max_results=${REMOTE_SEARCH_MAX_RESULTS}`,
    "count=0",
    'find "$root" -maxdepth "$max_depth" \\( -type d \\( -name .git -o -name node_modules -o -name target -o -name dist -o -name build -o -name .next -o -name .snow \\) -prune \\) -o -type d -print | while IFS= read -r cand; do',
    '  [ "$count" -ge "$max_results" ] && break',
    '  [ "$cand" = "$root" ] && continue',
    "  base=${cand##*/}",
    '  case "$base" in .* ) continue ;; esac',
    "  lower_base=$(printf '%s' \\\"$base\\\" | tr '[:upper:]' '[:lower:]')",
    "  lower_seg=$(printf '%s' \\\"$seg\\\" | tr '[:upper:]' '[:lower:]')",
    '  case "$lower_base" in "$lower_seg"* )',
    "    printf 'd\\t%s\\n' \"$cand\"",
    "    count=$((count + 1))",
    '    find "$cand" -maxdepth 1 -mindepth 1 -print | while IFS= read -r path; do',
    '      [ "$count" -ge "$max_results" ] && break',
    "      name=${path##*/}",
    '      case "$name" in .* ) continue ;; esac',
    "      lower_name=$(printf '%s' \\\"$name\\\" | tr '[:upper:]' '[:lower:]')",
    "      lower_query=$(printf '%s' \\\"$name_query\\\" | tr '[:upper:]' '[:lower:]')",
    '      if [ -z "$name_query" ] || printf \'%s\' "$lower_name" | grep -Fq -- "$lower_query"; then',
    '        if [ -d "$path" ]; then kind=d; else kind=f; fi',
    '        printf \'%s\\t%s\\n\' "$kind" "$path"',
    "        count=$((count + 1))",
    "      fi",
    "    done",
    "    ;;",
    "  esac",
    "done",
  ].join("\n");

  const script = [
    `root=${shellQuote(rootPath)}`,
    `dir=${shellQuote(dirPath)}`,
    `name_query=${shellQuote(nameQuery)}`,
    `max_results=${REMOTE_SEARCH_MAX_RESULTS}`,
    "count=0",
    // Include the directory itself when it is not the workspace root.
    'if [ -d "$dir" ] && [ "$dir" != "$root" ]; then',
    "  printf 'd\\t%s\\n' \"$dir\"",
    "  count=$((count + 1))",
    "fi",
    // List the direct children of the directory.
    'if [ -d "$dir" ]; then',
    '  find "$dir" -maxdepth 1 -mindepth 1 -print | while IFS= read -r path; do',
    '    [ "$count" -ge "$max_results" ] && break',
    "    name=${path##*/}",
    '    case "$name" in .* ) continue ;; esac',
    "    lower_name=$(printf '%s' \\\"$name\\\" | tr '[:upper:]' '[:lower:]')",
    "    lower_query=$(printf '%s' \\\"$name_query\\\" | tr '[:upper:]' '[:lower:]')",
    '    if [ -z "$name_query" ] || printf \'%s\' "$lower_name" | grep -Fq -- "$lower_query"; then',
    '      if [ -d "$path" ]; then kind=d; else kind=f; fi',
    '      printf \'%s\\t%s\\n\' "$kind" "$path"',
    "      count=$((count + 1))",
    "    fi",
    "  done",
    // Directory not found: fall back to the regular name search.
    "else",
    fallbackScript,
    "fi",
  ].join("\n");

  return `sh -lc ${shellQuote(script)}`;
};

const parseRemoteWorkspaceSearchResults = (
  output: string,
  workspacePath: string,
  remoteRootPath: string,
): Array<{
  path: string;
  relativePath: string;
  name: string;
  isDirectory: boolean;
  matchedName: boolean;
  lineMatches: Array<{ line: number; text: string }>;
}> => {
  return output
    .split("\n")
    .flatMap((line) => {
      const [kind, remotePath] = line.split("\t", 2);
      if ((kind !== "d" && kind !== "f") || !remotePath) {
        return [];
      }

      return [
        toRemoteWorkspaceSearchResult(
          workspacePath,
          remotePath,
          remoteRootPath,
          kind === "d",
        ),
      ];
    })
    .sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) {
        return left.isDirectory ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    })
    .slice(0, REMOTE_SEARCH_MAX_RESULTS);
};

const normalizeSshAuthMethod = (
  value: unknown,
  fallback: SshAuthMethod = "password",
): SshAuthMethod =>
  value === "password" || value === "privateKey" || value === "agent"
    ? value
    : fallback;

/** 渲染层传来的跳板机参数：缺主机 / 用户名时视为未配置跳板机。 */
const normalizeSshJumpHost = (value: unknown): SshJumpHost | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const input = value as Record<string, unknown>;
  const host = typeof input.host === "string" ? input.host.trim() : "";
  const username =
    typeof input.username === "string" ? input.username.trim() : "";
  if (!host || !username) {
    return undefined;
  }
  const port =
    typeof input.port === "number" && input.port > 0 && input.port <= 65535
      ? input.port
      : 22;
  const jump: SshJumpHost = {
    host,
    port,
    username,
    authMethod: normalizeSshAuthMethod(input.authMethod, "agent"),
  };
  if (typeof input.privateKeyPath === "string" && input.privateKeyPath) {
    jump.privateKeyPath = input.privateKeyPath;
  }
  if (typeof input.secret === "string" && input.secret) {
    jump.secret = input.secret;
  }
  return jump;
};

/** SSH 文件传输的确认对话框里最多列出的名称数量。 */
const TRANSFER_NAME_PREVIEW_LIMIT = 8;

/** 把路径列表压缩成便于对话框展示的名称预览。 */
const transferCompactNames = (
  paths: string[],
  limit = TRANSFER_NAME_PREVIEW_LIMIT,
): string => {
  const names = paths.map((value) => value.split(/[\\/]/).pop() || value);
  const shown = names.slice(0, limit).join(", ");
  return names.length > limit ? `${shown} …` : shown;
};

const normalizeTransferWorkspaceId = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("SSH transfer workspace ID is required");
  }
  return value.trim();
};

const normalizeTransferStringList = (
  value: unknown,
  label: string,
): string[] => {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === "string" && item.trim())
  ) {
    throw new Error(`${label} are required`);
  }
  return value.map((item) => (item as string).trim());
};

const showTransferConfirm = async (
  browserWindow: BrowserWindow | null,
  options: Electron.MessageBoxOptions,
): Promise<boolean> => {
  const result = browserWindow
    ? await dialog.showMessageBox(browserWindow, options)
    : await dialog.showMessageBox(options);
  return result.response === 0;
};

export const registerSshHandlers = (_native: NativeBridge): void => {
  // 文件传输模块通过工作区目录查询解析授权根目录（不信任渲染层自报路径）。
  initSshTransferWorkspaceLookup(async (workspaceId) => {
    const directories = await _native.listWorkspaceDirectories();
    const record = directories.find(
      (directory) => directory.directoryId === workspaceId,
    );
    return record ? { path: record.path, kind: record.kind } : null;
  });
  app.once("before-quit", () => {
    shutdownSshTransfers();
  });

  const normalizeSshConnectParams = (value: unknown): SshConnectParams => {
    if (typeof value !== "object" || value === null) {
      throw new Error("SSH connect params must be an object");
    }
    const obj = value as Record<string, unknown>;
    const host = typeof obj.host === "string" ? obj.host.trim() : "";
    const port = typeof obj.port === "number" ? obj.port : 22;
    const username =
      typeof obj.username === "string" ? obj.username.trim() : "";
    const authMethod = normalizeSshAuthMethod(obj.authMethod);

    if (!host) {
      throw new Error("SSH host is required");
    }
    if (!username) {
      throw new Error("SSH username is required");
    }

    const result: SshConnectParams = { host, port, username, authMethod };
    if (typeof obj.password === "string" && obj.password) {
      result.password = obj.password;
    }
    if (typeof obj.privateKeyPath === "string" && obj.privateKeyPath) {
      result.privateKeyPath = obj.privateKeyPath;
    }
    if (typeof obj.passphrase === "string" && obj.passphrase) {
      result.passphrase = obj.passphrase;
    }
    const jump = normalizeSshJumpHost(obj.jump);
    if (jump) {
      result.jump = jump;
    }
    if (obj.hostKeyPolicy === "replace") {
      result.hostKeyPolicy = "replace";
    }
    return result;
  };

  const normalizeSshFileVersion = (value: unknown): SshFileVersion => {
    if (typeof value !== "object" || value === null) {
      throw new Error("Remote file version must be an object");
    }
    const input = value as Record<string, unknown>;
    if (typeof input.exists !== "boolean") {
      throw new Error("Remote file version must include exists");
    }
    if (!input.exists) {
      return { exists: false };
    }
    if (
      typeof input.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(input.sha256) ||
      typeof input.size !== "number" ||
      !Number.isSafeInteger(input.size) ||
      input.size < 0 ||
      typeof input.mtime !== "number" ||
      !Number.isFinite(input.mtime) ||
      input.mtime < 0
    ) {
      throw new Error("Remote file version is invalid");
    }
    return {
      exists: true,
      sha256: input.sha256,
      size: input.size,
      mtime: input.mtime,
    };
  };

  const normalizeProfileId = (value: unknown): string => {
    if (typeof value !== "string" || !value.trim().startsWith("ssh-profile:")) {
      throw new Error("SSH profile ID is required");
    }
    return value.trim();
  };

  const normalizeRemoteDraftInput = (value: unknown): RemoteDraftInput => {
    if (typeof value !== "object" || value === null) {
      throw new Error("Remote draft must be an object");
    }
    const input = value as Record<string, unknown>;
    const profileId = normalizeProfileId(input.profileId);
    const workspaceId =
      typeof input.workspaceId === "string" ? input.workspaceId.trim() : "";
    const remotePath =
      typeof input.remotePath === "string" ? input.remotePath.trim() : "";
    const baseVersionJson =
      typeof input.baseVersionJson === "string" ? input.baseVersionJson : "";
    const content = typeof input.content === "string" ? input.content : null;
    const status = input.status;
    if (!workspaceId || !remotePath || content === null) {
      throw new Error("Remote draft workspace, path, and content are required");
    }
    if (status !== "pending" && status !== "conflict") {
      throw new Error("Remote draft status is invalid");
    }
    try {
      JSON.parse(baseVersionJson);
    } catch {
      throw new Error("Remote draft base version must be JSON");
    }
    return {
      profileId,
      workspaceId,
      remotePath,
      baseVersionJson,
      content,
      status,
    };
  };

  sshConnectionManager.subscribe((state) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send("ssh:profile-state", state);
      }
    }
  });

  ipcMain.handle("ssh:profiles:connect", async (_event, params: unknown) =>
    sshConnectionManager.acquire(normalizeSshConnectParams(params)),
  );
  ipcMain.handle("ssh:profiles:get", (_event, profileId: unknown) =>
    sshConnectionManager.get(normalizeProfileId(profileId)),
  );
  ipcMain.handle("ssh:profiles:release", (_event, profileId: unknown) => {
    sshConnectionManager.release(normalizeProfileId(profileId));
  });
  ipcMain.handle(
    "ssh:drafts:list",
    (_event, workspaceId: unknown, profileId: unknown) => {
      if (typeof workspaceId !== "string" || !workspaceId.trim()) {
        throw new Error("Remote draft workspace ID is required");
      }
      return _native.listRemoteDrafts(
        workspaceId.trim(),
        profileId === undefined || profileId === null
          ? undefined
          : normalizeProfileId(profileId),
      );
    },
  );
  ipcMain.handle("ssh:drafts:upsert", (_event, draft: unknown) =>
    _native.upsertRemoteDraft(normalizeRemoteDraftInput(draft)),
  );
  ipcMain.handle(
    "ssh:drafts:delete",
    (_event, profileId: unknown, workspaceId: unknown, remotePath: unknown) => {
      if (typeof workspaceId !== "string" || !workspaceId.trim()) {
        throw new Error("Remote draft workspace ID is required");
      }
      if (typeof remotePath !== "string" || !remotePath.trim()) {
        throw new Error("Remote draft path is required");
      }
      return _native.deleteRemoteDraft(
        normalizeProfileId(profileId),
        workspaceId.trim(),
        remotePath.trim(),
      );
    },
  );

  const normalizeSshFileWriteOptions = async (
    sessionId: string,
    value: unknown,
  ): Promise<{ expectedVersion: SshFileVersion; workspaceRoot: string }> => {
    if (typeof value !== "object" || value === null) {
      throw new Error("Atomic remote file save requires write options");
    }
    const input = value as Record<string, unknown>;
    if (input.workspaceRoot !== undefined) {
      throw new Error("Atomic remote file save does not accept workspaceRoot");
    }
    if (typeof input.workspaceId !== "string" || !input.workspaceId.trim()) {
      throw new Error("Atomic remote file save requires a workspace ID");
    }
    if (input.expectedVersion === undefined) {
      throw new Error(
        "Atomic remote file save requires an expected file version",
      );
    }
    const workspaceId = input.workspaceId.trim();
    const workspaces = await _native.listWorkspaceDirectories();
    const workspace = workspaces.find(
      (directory) => directory.directoryId === workspaceId,
    );
    if (!workspace || workspace.kind !== "ssh") {
      throw new Error(
        "Atomic remote file save workspace is not an SSH workspace",
      );
    }
    return {
      workspaceRoot: resolveSshWorkspaceRoot(sessionId, workspace.path),
      expectedVersion: normalizeSshFileVersion(input.expectedVersion),
    };
  };

  ipcMain.handle("ssh:connect", async (_event, params: unknown) => {
    // 连接失败不抛异常，而是返回结构化结果：渲染层拿到稳定的错误码
    // （network/timeout/auth/sftp/invalid/unknown）做本地化展示，原始
    // 技术消息放在 detail 中供排查，避免透传 ssh2 的英文原始错误。
    try {
      const connectParams = normalizeSshConnectParams(params);
      const sessionId = await connectSsh(connectParams);
      return { ok: true as const, sessionId };
    } catch (err) {
      const info = classifySshConnectError(err);
      return {
        ok: false as const,
        code: info.code,
        message: info.message,
        detail: info.detail,
      };
    }
  });

  ipcMain.handle(
    "ssh:list-directory",
    async (_event, sessionId: unknown, remotePath: unknown) => {
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("SSH session ID is required");
      }
      if (typeof remotePath !== "string" || !remotePath.trim()) {
        throw new Error("Remote directory path is required");
      }
      return listSshDirectory(sessionId.trim(), remotePath.trim());
    },
  );

  ipcMain.handle(
    "ssh:execute-command",
    async (_event, sessionId: unknown, command: unknown) => {
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("SSH session ID is required");
      }
      if (typeof command !== "string" || !command.trim()) {
        throw new Error("Remote command is required");
      }
      return executeSshCommand(sessionId.trim(), command);
    },
  );

  ipcMain.handle(
    "ssh:probe-capabilities",
    async (_event, sessionId: unknown) => {
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("SSH session ID is required");
      }
      return probeSshCapabilities(sessionId.trim());
    },
  );

  ipcMain.handle(
    "ssh:search-workspace-files",
    async (_event, workspacePath: unknown, options: unknown) => {
      if (
        typeof workspacePath !== "string" ||
        !isSshPath(workspacePath.trim())
      ) {
        throw new Error("Remote workspace path is required");
      }
      if (typeof options !== "object" || options === null) {
        throw new Error("Remote workspace search options are required");
      }

      const { query, listChildren } = options as Record<string, unknown>;
      if (typeof query !== "string") {
        throw new Error("Remote workspace query must be a string");
      }
      if (typeof listChildren !== "boolean") {
        throw new Error("Remote workspace listChildren option is required");
      }
      if (!listChildren && !query.trim()) {
        return [];
      }

      const parsed = parseSshUrl(workspacePath.trim());
      const sessionId = await connectSsh(
        buildSshConnectParams(workspacePath.trim()),
      );
      try {
        if (listChildren) {
          return (await listSshDirectory(sessionId, parsed.remotePath)).map(
            (entry) =>
              toRemoteWorkspaceSearchResult(
                workspacePath.trim(),
                entry.path,
                parsed.remotePath,
                entry.isDirectory,
              ),
          );
        }

        const output = await executeSshCommand(
          sessionId,
          buildRemoteWorkspaceSearchCommand(parsed.remotePath, query.trim()),
        );
        return parseRemoteWorkspaceSearchResults(
          output,
          workspacePath.trim(),
          parsed.remotePath,
        );
      } finally {
        disconnectSsh(sessionId);
      }
    },
  );

  ipcMain.handle(
    "ssh:read-file",
    async (_event, sessionId: unknown, remotePath: unknown) => {
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("SSH session ID is required");
      }
      if (typeof remotePath !== "string" || !remotePath.trim()) {
        throw new Error("Remote file path is required");
      }
      const file = await readSshFileWithVersion(
        sessionId.trim(),
        remotePath.trim(),
      );
      return {
        ...processFileContent(remotePath.trim(), file.content),
        remoteVersion: file.version,
      };
    },
  );

  ipcMain.handle(
    "ssh:write-file",
    async (
      _event,
      sessionId: unknown,
      remotePath: unknown,
      content: unknown,
      options: unknown,
    ) => {
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("SSH session ID is required");
      }
      if (typeof remotePath !== "string" || !remotePath.trim()) {
        throw new Error("Remote file path is required");
      }
      if (typeof content !== "string") {
        throw new Error("File content must be a string");
      }
      return writeSshFile(
        sessionId.trim(),
        remotePath.trim(),
        content,
        await normalizeSshFileWriteOptions(sessionId.trim(), options),
      );
    },
  );

  ipcMain.handle(
    "ssh:delete-entry",
    async (_event, sessionId: unknown, remotePath: unknown) => {
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("SSH session ID is required");
      }
      if (typeof remotePath !== "string" || !remotePath.trim()) {
        throw new Error("Remote path is required");
      }

      const trimmedSessionId = sessionId.trim();
      const trimmedPath = remotePath.trim();

      // Determine whether the entry is a file or directory so we can call the
      // appropriate deletion routine (SFTP unlink for files, recursive rm -rf
      // for directories via the exec channel).
      const stats = await statSshEntry(trimmedSessionId, trimmedPath);
      if (!stats) {
        throw new Error("Remote path does not exist");
      }
      if (stats.isDirectory()) {
        return deleteSshDirectory(trimmedSessionId, trimmedPath);
      }
      return deleteSshFile(trimmedSessionId, trimmedPath);
    },
  );

  // 批量删除远程条目：单次 IPC，主进程内部逐个执行（SSH 协议无批量删除），
  // 部分失败不中断，逐条收集结果。
  ipcMain.handle(
    "ssh:delete-entries",
    async (_event, sessionId: unknown, remotePaths: unknown) => {
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("SSH session ID is required");
      }
      if (
        !Array.isArray(remotePaths) ||
        remotePaths.length === 0 ||
        !remotePaths.every((p) => typeof p === "string" && p.trim().length > 0)
      ) {
        throw new Error("Remote paths are required");
      }

      const trimmedSessionId = sessionId.trim();
      const paths = Array.from(
        new Set(remotePaths.map((p) => (p as string).trim())),
      );

      // 父子合并：被另一选中路径包含的后代路径跳过（父级删除后自动消失）。
      const topLevel = paths.filter(
        (p) => !paths.some((other) => other !== p && p.startsWith(`${other}/`)),
      );

      const deleted: string[] = [];
      const failed: { path: string; error: string }[] = [];
      for (const remotePath of topLevel) {
        try {
          const stats = await statSshEntry(trimmedSessionId, remotePath);
          if (!stats) {
            throw new Error("Remote path does not exist");
          }
          if (stats.isDirectory()) {
            await deleteSshDirectory(trimmedSessionId, remotePath);
          } else {
            await deleteSshFile(trimmedSessionId, remotePath);
          }
          deleted.push(remotePath);
        } catch (error) {
          failed.push({
            path: remotePath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { deleted, failed };
    },
  );

  ipcMain.handle(
    "ssh:rename-entry",
    async (
      _event,
      sessionId: unknown,
      remotePath: unknown,
      newName: unknown,
    ) => {
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("SSH session ID is required");
      }
      if (typeof remotePath !== "string" || !remotePath.trim()) {
        throw new Error("Remote path is required");
      }
      if (typeof newName !== "string" || !newName.trim()) {
        throw new Error("New entry name is required");
      }

      const trimmedPath = remotePath.trim();
      const trimmedNewName = newName.trim();

      // Build the destination path by replacing the last path segment with the
      // new name, matching the behavior of the local rename implementation.
      const separatorIndex = trimmedPath.lastIndexOf("/");
      const parentDir =
        separatorIndex > 0 ? trimmedPath.slice(0, separatorIndex) : "/";
      const newPath =
        parentDir === "/"
          ? `/${trimmedNewName}`
          : `${parentDir}/${trimmedNewName}`;

      return renameSshFile(sessionId.trim(), trimmedPath, newPath);
    },
  );

  ipcMain.handle("ssh:disconnect", (_event, sessionId: unknown) => {
    if (typeof sessionId !== "string") {
      return;
    }
    disconnectSsh(sessionId);
  });

  ipcMain.handle("ssh:save-credential", (_event, params: unknown) => {
    if (typeof params !== "object" || params === null) {
      throw new Error("SSH credential params must be an object");
    }
    const obj = params as Record<string, unknown>;
    const host = typeof obj.host === "string" ? obj.host.trim() : "";
    const port = typeof obj.port === "number" ? obj.port : 22;
    const username =
      typeof obj.username === "string" ? obj.username.trim() : "";
    const authMethod = normalizeSshAuthMethod(obj.authMethod);

    if (!host || !username) {
      throw new Error("SSH host and username are required");
    }

    return saveSshCredentialWithPlainSecret({
      host,
      port,
      username,
      authMethod,
      privateKeyPath:
        typeof obj.privateKeyPath === "string" ? obj.privateKeyPath : undefined,
      secret: typeof obj.secret === "string" ? obj.secret : undefined,
      jump: normalizeSshJumpHost(obj.jump),
      jumpSecret:
        typeof obj.jumpSecret === "string" ? obj.jumpSecret : undefined,
    });
  });

  ipcMain.handle(
    "ssh:get-credential",
    (_event, host: unknown, port: unknown, username: unknown) => {
      if (typeof host !== "string" || typeof username !== "string") {
        return null;
      }
      const portNum = typeof port === "number" ? port : 22;
      return getSshCredential(host.trim(), portNum, username.trim());
    },
  );

  ipcMain.handle(
    "ssh:get-decrypted-secret",
    (_event, host: unknown, port: unknown, username: unknown) => {
      if (typeof host !== "string" || typeof username !== "string") {
        return null;
      }
      const portNum = typeof port === "number" ? port : 22;
      return getDecryptedSecret(host.trim(), portNum, username.trim());
    },
  );

  ipcMain.handle(
    "ssh:get-decrypted-jump-secret",
    (_event, host: unknown, port: unknown, username: unknown) => {
      if (typeof host !== "string" || typeof username !== "string") {
        return null;
      }
      const portNum = typeof port === "number" ? port : 22;
      return getDecryptedJumpSecret(host.trim(), portNum, username.trim());
    },
  );

  ipcMain.handle("ssh:list-credentials", () => listSshCredentials());

  // 读取本地 ~/.ssh/config 中的主机条目，供渲染层快速导入 SSH 连接。
  ipcMain.handle("ssh:list-config-hosts", () => listSshConfigHosts());

  // 解析向导里填写的跳板机（ssh config 别名或 user@host:port）。
  ipcMain.handle("ssh:resolve-jump-host", (_event, spec: unknown) => {
    if (typeof spec !== "string" || !spec.trim()) {
      return null;
    }
    return resolveSshConfigJumpHost(spec);
  });

  ipcMain.handle(
    "ssh:delete-credential",
    (_event, host: unknown, port: unknown, username: unknown) => {
      if (typeof host !== "string" || typeof username !== "string") {
        return;
      }
      const portNum = typeof port === "number" ? port : 22;
      deleteSshCredential(host.trim(), portNum, username.trim());
    },
  );

  ipcMain.handle(
    "ssh:select-private-key",
    async (event, dialogTitle: unknown) => {
      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const title =
        typeof dialogTitle === "string" && dialogTitle.trim()
          ? dialogTitle.trim()
          : "Select private key file";
      const homeDir = homedir();
      const options: Electron.OpenDialogOptions = {
        title,
        properties: ["openFile"],
        defaultPath: `${homeDir}/.ssh`,
      };
      const result = browserWindow
        ? await dialog.showOpenDialog(browserWindow, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  );

  ipcMain.handle("ssh:parse-url", (_event, sshUrl: unknown) => {
    if (typeof sshUrl !== "string" || !sshUrl.trim()) {
      throw new Error("SSH URL is required");
    }
    if (!isSshPath(sshUrl.trim())) {
      throw new Error("Path is not an SSH URL");
    }
    return parseSshUrl(sshUrl.trim());
  });

  // ===== SSH 文件传输（上传 / 下载） =====
  // 字节流全部发生在主进程内部：本地文件 <-> 任务专属 SFTP channel。
  // 渲染层只负责发起、查询快照与取消。

  /** 上传：主进程弹出文件选择框，用户选择即视为来源确认。 */
  ipcMain.handle("ssh:transfers:upload", async (event, params: unknown) => {
    if (typeof params !== "object" || params === null) {
      throw new Error("SSH upload params must be an object");
    }
    const input = params as Record<string, unknown>;
    const workspaceId = normalizeTransferWorkspaceId(input.workspaceId);
    const remoteDirectory =
      typeof input.remoteDirectory === "string"
        ? input.remoteDirectory.trim()
        : "";
    if (!remoteDirectory) {
      throw new Error("Remote target directory is required");
    }

    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    const openOptions: Electron.OpenDialogOptions = {
      title: tMain("sshTransfer.uploadDialogTitle"),
      properties: ["openFile", "multiSelections"],
    };
    const selection = browserWindow
      ? await dialog.showOpenDialog(browserWindow, openOptions)
      : await dialog.showOpenDialog(openOptions);
    if (selection.canceled || selection.filePaths.length === 0) {
      return { canceled: true as const, reason: "dialog" };
    }

    const classified = await classifySshUploadSources(selection.filePaths);
    if (classified.files.length === 0) {
      await showTransferConfirm(browserWindow, {
        type: "warning",
        title: tMain("sshTransfer.partialTitle"),
        message: tMain("sshTransfer.noTransferableFiles"),
        detail: transferCompactNames(
          classified.skipped.map((item) => item.path),
        ),
        buttons: [tMain("sshTransfer.cancelButton")],
        defaultId: 0,
        cancelId: 0,
      });
      return { canceled: true as const, reason: "no-files" };
    }
    if (classified.skipped.length > 0) {
      const confirmed = await showTransferConfirm(browserWindow, {
        type: "warning",
        title: tMain("sshTransfer.partialTitle"),
        message: tMain("sshTransfer.partialMessage", {
          count: classified.files.length,
          skipped: classified.skipped.length,
        }),
        detail: transferCompactNames(
          classified.skipped.map((item) => item.path),
        ),
        buttons: [
          tMain("sshTransfer.continueButton"),
          tMain("sshTransfer.cancelButton"),
        ],
        defaultId: 0,
        cancelId: 1,
      });
      if (!confirmed) {
        return { canceled: true as const, reason: "user" };
      }
    }

    watchSshTransferOwner(event.sender);
    return createSshUploadBatch({
      ownerWebContentsId: event.sender.id,
      workspaceId,
      remoteDirectory,
      localPaths: classified.files,
    });
  });

  /** 上传（拖入）：来源由 preload 解析，主进程校验并展示来源与目标确认。 */
  ipcMain.handle(
    "ssh:transfers:upload-dropped",
    async (event, params: unknown) => {
      if (typeof params !== "object" || params === null) {
        throw new Error("SSH upload params must be an object");
      }
      const input = params as Record<string, unknown>;
      const workspaceId = normalizeTransferWorkspaceId(input.workspaceId);
      const remoteDirectory =
        typeof input.remoteDirectory === "string"
          ? input.remoteDirectory.trim()
          : "";
      if (!remoteDirectory) {
        throw new Error("Remote target directory is required");
      }
      const localPaths = normalizeTransferStringList(
        input.localPaths,
        "Local file paths",
      );

      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const classified = await classifySshUploadSources(localPaths);
      if (classified.files.length === 0) {
        await showTransferConfirm(browserWindow, {
          type: "warning",
          title: tMain("sshTransfer.partialTitle"),
          message: tMain("sshTransfer.noTransferableFiles"),
          detail: transferCompactNames(
            classified.skipped.map((item) => item.path),
          ),
          buttons: [tMain("sshTransfer.cancelButton")],
          defaultId: 0,
          cancelId: 0,
        });
        return { canceled: true as const, reason: "no-files" };
      }

      const detailParts = [transferCompactNames(classified.files)];
      if (classified.skipped.length > 0) {
        detailParts.push(
          tMain("sshTransfer.partialMessage", {
            count: classified.files.length,
            skipped: classified.skipped.length,
          }),
        );
      }
      const confirmed = await showTransferConfirm(browserWindow, {
        type: "question",
        title: tMain("sshTransfer.dropConfirmTitle"),
        message: tMain("sshTransfer.dropConfirmMessage", {
          count: classified.files.length,
          dir: remoteDirectory,
        }),
        detail: detailParts.join("\n"),
        buttons: [
          tMain("sshTransfer.uploadButton"),
          tMain("sshTransfer.cancelButton"),
        ],
        defaultId: 0,
        cancelId: 1,
      });
      if (!confirmed) {
        return { canceled: true as const, reason: "user" };
      }

      watchSshTransferOwner(event.sender);
      return createSshUploadBatch({
        ownerWebContentsId: event.sender.id,
        workspaceId,
        remoteDirectory,
        localPaths: classified.files,
      });
    },
  );

  /** 下载：单文件弹保存框；多文件弹目录选择框。 */
  ipcMain.handle("ssh:transfers:download", async (event, params: unknown) => {
    if (typeof params !== "object" || params === null) {
      throw new Error("SSH download params must be an object");
    }
    const input = params as Record<string, unknown>;
    const workspaceId = normalizeTransferWorkspaceId(input.workspaceId);
    const remotePaths = normalizeTransferStringList(
      input.remotePaths,
      "Remote file paths",
    );

    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    const classified = await classifySshDownloadSources(
      workspaceId,
      remotePaths,
    );
    if (classified.files.length === 0) {
      await showTransferConfirm(browserWindow, {
        type: "warning",
        title: tMain("sshTransfer.partialTitle"),
        message: tMain("sshTransfer.noTransferableFiles"),
        detail: transferCompactNames(
          classified.skipped.map((item) => item.path),
        ),
        buttons: [tMain("sshTransfer.cancelButton")],
        defaultId: 0,
        cancelId: 0,
      });
      return { canceled: true as const, reason: "no-files" };
    }
    if (classified.skipped.length > 0) {
      const confirmed = await showTransferConfirm(browserWindow, {
        type: "warning",
        title: tMain("sshTransfer.partialTitle"),
        message: tMain("sshTransfer.partialMessage", {
          count: classified.files.length,
          skipped: classified.skipped.length,
        }),
        detail: transferCompactNames(
          classified.skipped.map((item) => item.path),
        ),
        buttons: [
          tMain("sshTransfer.continueButton"),
          tMain("sshTransfer.cancelButton"),
        ],
        defaultId: 0,
        cancelId: 1,
      });
      if (!confirmed) {
        return { canceled: true as const, reason: "user" };
      }
    }

    const defaultDir = getLastDownloadDir() ?? app.getPath("downloads");
    let targetDir: string;
    let singleFileName: string | undefined;

    if (classified.files.length === 1) {
      const file = classified.files[0];
      const saveOptions: Electron.SaveDialogOptions = {
        title: tMain("sshTransfer.downloadSaveTitle"),
        defaultPath: joinLocalPath(
          defaultDir,
          sanitizeLocalFileName(file.name),
        ),
        buttonLabel: tMain("sshTransfer.saveButton"),
      };
      const saveResult = browserWindow
        ? await dialog.showSaveDialog(browserWindow, saveOptions)
        : await dialog.showSaveDialog(saveOptions);
      if (saveResult.canceled || !saveResult.filePath) {
        return { canceled: true as const, reason: "dialog" };
      }
      targetDir = localDirname(saveResult.filePath);
      singleFileName = localBasename(saveResult.filePath);
    } else {
      const dirOptions: Electron.OpenDialogOptions = {
        title: tMain("sshTransfer.downloadDirTitle"),
        properties: ["openDirectory", "createDirectory"],
        defaultPath: defaultDir,
        buttonLabel: tMain("sshTransfer.chooseButton"),
      };
      const dirResult = browserWindow
        ? await dialog.showOpenDialog(browserWindow, dirOptions)
        : await dialog.showOpenDialog(dirOptions);
      if (dirResult.canceled || !dirResult.filePaths[0]) {
        return { canceled: true as const, reason: "dialog" };
      }
      targetDir = dirResult.filePaths[0];
    }
    setLastDownloadDir(targetDir);

    watchSshTransferOwner(event.sender);
    return createSshDownloadBatch({
      ownerWebContentsId: event.sender.id,
      workspaceId,
      files: classified.files.map((file) => ({
        remotePath: file.remotePath,
        name: file.name,
      })),
      targetDir,
      singleFileName,
    });
  });

  ipcMain.handle("ssh:transfers:list", (event) =>
    getSshTransferSnapshot(event.sender.id),
  );

  ipcMain.handle("ssh:transfers:cancel", (event, params: unknown) => {
    if (typeof params !== "object" || params === null) {
      throw new Error("SSH transfer cancel params must be an object");
    }
    const input = params as Record<string, unknown>;
    const taskId =
      typeof input.taskId === "string" && input.taskId.trim()
        ? input.taskId.trim()
        : undefined;
    const batchId =
      typeof input.batchId === "string" && input.batchId.trim()
        ? input.batchId.trim()
        : undefined;
    if (!taskId && !batchId) {
      throw new Error("Transfer task or batch is required");
    }
    cancelSshTransfer({
      ownerWebContentsId: event.sender.id,
      taskId,
      batchId,
    });
  });

  ipcMain.handle("ssh:transfers:resolve-conflict", (event, params: unknown) => {
    if (typeof params !== "object" || params === null) {
      throw new Error("SSH transfer conflict params must be an object");
    }
    const input = params as Record<string, unknown>;
    const taskId = typeof input.taskId === "string" ? input.taskId.trim() : "";
    if (!taskId) {
      throw new Error("Transfer task ID is required");
    }
    const action = input.action;
    if (action !== "replace" && action !== "skip" && action !== "rename") {
      throw new Error("Transfer conflict action is invalid");
    }
    const newName =
      typeof input.newName === "string" && input.newName.trim()
        ? input.newName.trim()
        : undefined;
    const applyToBatch = input.applyToBatch === true;
    resolveSshTransferConflict({
      ownerWebContentsId: event.sender.id,
      taskId,
      action: action as SshTransferConflictAction,
      newName,
      applyToBatch,
    });
  });

  ipcMain.handle("ssh:transfers:clear-finished", (event) => {
    clearFinishedSshTransfers(event.sender.id);
  });
};
