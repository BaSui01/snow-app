/**
 * SSH 文件传输内核：在任务专属的独立 SFTP channel 上执行流式上传 / 下载。
 *
 * 设计要点（与 `.scratch/notes/SSH_FILE_TRANSFER_PLAN.md` 一致）：
 * - 不复用共享 `session.sftp`：取消一个传输只影响任务自己的 channel；
 * - 所有数据只经过本进程内的「本地文件流 <-> SFTP」循环，字节不经渲染层；
 * - 先写目标同目录的随机临时文件，校验通过后再提交（rename / 链接防覆盖）；
 * - 不支持安全原子替换时明确失败，绝不静默降级为截断写；
 * - 提交阶段连接中断视为「提交结果未知」（commit-unknown），不自动重试；
 * - 源/目标变化只做「变化检测」（大小 + mtime），不承诺一致快照。
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as localPath from "node:path";
import { dirname as remoteDirname } from "node:path/posix";

import {
  getSshSession,
  isSshPathWithinRoot,
  normalizeSshRemotePath,
  SshOperationError,
  type SshSession,
} from "./sshManager";
import type { SFTPWrapper, Stats } from "ssh2";

// ===== 常量 =====

/** 打开数据 channel 的超时。 */
const CHANNEL_OPEN_TIMEOUT_MS = 15_000;
/** 单个 SFTP 读 / 写操作的超时（无进展即视为卡死）。 */
const SFTP_OP_TIMEOUT_MS = 60_000;
/** 提交（rename）确认超时：超时后结果未知。 */
const COMMIT_TIMEOUT_MS = 30_000;
/** 清理阶段允许的最长等待（失败即放弃，不阻断任务收尾）。 */
const CLEANUP_TIMEOUT_MS = 5_000;
/** 传输分块大小：兼顾吞吐与单包内存占用（OpenSSH 服务端单包上限 256KB）。 */
const CHUNK_SIZE = 128 * 1024;
/** 冲突协商最多轮数（用户改的名字仍然占用时）。 */
const CONFLICT_MAX_ROUNDS = 3;
/** 自动名称后缀最多尝试次数。 */
const FREE_NAME_MAX_ATTEMPTS = 100;

// ===== 错误类型 =====

export class SshTransferError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SshTransferError";
    this.code = code;
  }
}

// ===== 名称与路径工具 =====

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** 远端目标名必须是单个文件名；返回错误消息，合法时返回 null。 */
export const validateRemoteBaseName = (name: string): string | null => {
  const trimmed = name.trim();
  if (!trimmed) {
    return "Name is empty";
  }
  if (trimmed === "." || trimmed === "..") {
    return "Name cannot be a dot segment";
  }
  if (trimmed.length > 255) {
    return "Name is too long";
  }
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return "Name cannot contain path separators";
  }
  if (CONTROL_CHARS.test(trimmed)) {
    return "Name contains control characters";
  }
  return null;
};

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const WINDOWS_INVALID_CHARS = /[<>:"/\\|?*]/;

/**
 * 清洗本地文件名（用于生成默认保存名）。
 * Windows 上同时处理非法字符、保留名与尾随点 / 空格。
 */
export const sanitizeLocalFileName = (
  name: string,
  platform: NodeJS.Platform = process.platform,
): string => {
  let cleaned = name.replace(/[\u0000-\u001f\u007f]/g, "");
  if (platform === "win32") {
    cleaned = cleaned.replace(/[<>:"/\\|?*]/g, "_");
    cleaned = cleaned.replace(/[ .]+$/g, "");
    if (WINDOWS_RESERVED_NAME.test(cleaned)) {
      cleaned = `_${cleaned}`;
    }
  } else {
    cleaned = cleaned.replace(/[/]/g, "_");
  }
  const trimmed = cleaned.trim();
  return trimmed || "download";
};

/** 本地显式命名（另存为输入）的严格校验：清洗后必须与输入完全一致。 */
export const validateLocalBaseName = (
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | null => {
  const trimmed = name.trim();
  if (!trimmed) {
    return "Name is empty";
  }
  if (trimmed === "." || trimmed === "..") {
    return "Name cannot be a dot segment";
  }
  if (trimmed.length > 255) {
    return "Name is too long";
  }
  if (CONTROL_CHARS.test(trimmed)) {
    return "Name contains control characters";
  }
  if (/[/\\]/.test(trimmed)) {
    return "Name cannot contain path separators";
  }
  if (platform === "win32") {
    if (WINDOWS_INVALID_CHARS.test(trimmed)) {
      return "Name contains characters invalid on Windows";
    }
    if (/[ .]$/.test(trimmed)) {
      return "Name cannot end with a dot or space on Windows";
    }
    if (WINDOWS_RESERVED_NAME.test(trimmed)) {
      return "Name is reserved on Windows";
    }
  }
  return null;
};

/** 生成 "name (1).ext" 形式的备选名（仅做一次后缀，不检查可用性）。 */
export const suggestAlternativeName = (name: string): string => {
  const dotIndex = name.lastIndexOf(".");
  const stem = dotIndex > 0 ? name.slice(0, dotIndex) : name;
  const ext = dotIndex > 0 ? name.slice(dotIndex) : "";
  return `${stem} (1)${ext}`;
};

/** 在 "name (n).ext" 基础上递增后缀（n + 1），非该形式时退化为一次后缀。 */
export const incrementAlternativeName = (name: string): string => {
  const match = /^(.*) \((\d+)\)(\.[^.]*)?$/.exec(name);
  if (!match) {
    return suggestAlternativeName(name);
  }
  const nextIndex = Number(match[2]) + 1;
  return `${match[1]} (${nextIndex})${match[3] ?? ""}`;
};

const joinRemotePath = (dir: string, name: string): string =>
  dir === "/" ? `/${name}` : `${dir}/${name}`;

// ===== 恢复上下文类型 =====

export type SshTransferPhase =
  "preparing" | "transferring" | "verifying" | "committing";

export type SshTransferConflictDecision =
  | { action: "replace" }
  | { action: "skip" }
  | { action: "cancel" }
  | { action: "rename"; newName?: string };

export type SshTransferConflictRequest = {
  direction: "upload" | "download";
  /** 冲突条目在目标目录中的原始名称。 */
  baseName: string;
  /** 内核计算出的可用替代名（"name (1).ext"），供界面预填。 */
  suggestedName: string;
  /** 冲突目标的完整展示路径。 */
  targetPath: string;
  /** 已存在目标的字节数（未知时为 null）。 */
  existingSize: number | null;
};

export type SshTransferRunContext = {
  sessionId: string;
  workspaceRoot: string;
  /** 下载：远端源文件路径；上传：远端目标文件路径。 */
  remotePath: string;
  /** 上传：本地源文件路径；下载：本地目标文件路径。 */
  localPath: string;
  signal?: AbortSignal;
  onPhase: (phase: SshTransferPhase) => void;
  onProgress: (bytesTransferred: number, bytesTotal: number | null) => void;
  requestConflict: (
    request: SshTransferConflictRequest,
  ) => Promise<SshTransferConflictDecision>;
};

export type SshTransferRunResult =
  | { outcome: "committed"; bytes: number; finalTargetPath: string }
  | { outcome: "skipped" };

export type SshTransferChannel = {
  sftp: SFTPWrapper;
  end: () => void;
};

// ===== 基础工具 =====

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) {
    throw new SshTransferError("SSH_TRANSFER_CANCELLED", "Transfer cancelled");
  }
};

const isNotFoundError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === 2 || code === "ENOENT" || code === "NO_SUCH_FILE";
};

const isUnsupportedOpenSshExtension = (error: unknown): boolean => {
  const message = errorMessage(error);
  if (/does not support|not supported|unsupported/i.test(message)) {
    return true;
  }
  if (/is not a function|not implemented/i.test(message)) {
    return true;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === 8
  );
};

const isTransportLossError = (error: unknown): boolean =>
  /connection (?:lost|closed|reset)|socket hang up|ECONNRESET|EPIPE|client is closed|channel (?:closed|lost)|no response from server/i.test(
    errorMessage(error),
  );

/** ssh2 回调的 error 参数在 @types 中为 `Error | null | undefined`，统一放宽。 */
type SftpErrorParam = Error | null | undefined;
type SftpResultCallback<T> = (error: SftpErrorParam, result: T) => void;

/**
 * 统一的 SFTP 调用封装：内建取消（AbortSignal）、单操作超时与一次性结算。
 * 底层请求无法真正取消，超时 / 取消后由任务收尾时关闭专属 channel 兜底。
 */
const callSftp = <T>(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  run: (callback: SftpResultCallback<T>) => void,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    function settle(fn: () => void): void {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", onAbort);
      fn();
    }

    function onAbort(): void {
      settle(() =>
        reject(
          new SshTransferError("SSH_TRANSFER_CANCELLED", "Transfer cancelled"),
        ),
      );
    }

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      settle(() =>
        reject(
          new SshTransferError(
            "SSH_TRANSFER_TIMEOUT",
            `SFTP operation timed out after ${timeoutMs}ms`,
          ),
        ),
      );
    }, timeoutMs);

    try {
      run((error, result) => {
        if (error) {
          settle(() => reject(error));
          return;
        }
        settle(() => resolve(result));
      });
    } catch (error) {
      settle(() =>
        reject(error instanceof Error ? error : new Error(String(error))),
      );
    }
  });

// ===== 数据 channel =====

/**
 * 打开任务专属的 SFTP channel（复用既有 SSH 连接与主机信任，不新建认证链路）。
 * 取消 / 失败时只关闭本 channel，绝不触碰共享的 session.sftp 或 SSH client。
 */
export const openSshTransferChannel = async (
  session: SshSession,
  signal?: AbortSignal,
): Promise<SshTransferChannel> => {
  throwIfAborted(signal);
  const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    function settle(fn: () => void): void {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", onAbort);
      fn();
    }

    function onAbort(): void {
      settle(() =>
        reject(
          new SshTransferError("SSH_TRANSFER_CANCELLED", "Transfer cancelled"),
        ),
      );
    }

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      settle(() =>
        reject(
          new SshTransferError(
            "SSH_TRANSFER_TIMEOUT",
            "Timed out opening the SFTP transfer channel",
          ),
        ),
      );
    }, CHANNEL_OPEN_TIMEOUT_MS);

    try {
      session.client.sftp((error: Error | undefined, channel: SFTPWrapper) => {
        if (error) {
          settle(() => reject(error));
          return;
        }
        settle(() => resolve(channel));
      });
    } catch (error) {
      settle(() =>
        reject(error instanceof Error ? error : new Error(String(error))),
      );
    }
  });

  return {
    sftp,
    end: () => {
      try {
        sftp.end();
      } catch {
        // channel 可能已被传输层关闭。
      }
    },
  };
};

// ===== SFTP 基础操作 =====

const sftpOpenRemote = (
  sftp: SFTPWrapper,
  remotePath: string,
  mode: string,
  signal: AbortSignal | undefined,
  attributes?: { mode: number },
): Promise<Buffer> =>
  callSftp<Buffer>(signal, SFTP_OP_TIMEOUT_MS, (callback) => {
    if (attributes) {
      sftp.open(remotePath, mode as never, attributes, (error, handle) =>
        callback(error, handle),
      );
    } else {
      sftp.open(remotePath, mode as never, (error, handle) =>
        callback(error, handle),
      );
    }
  });

const sftpCloseRemote = (
  sftp: SFTPWrapper,
  handle: Buffer,
  signal: AbortSignal | undefined,
  timeoutMs = SFTP_OP_TIMEOUT_MS,
): Promise<void> =>
  callSftp<void>(signal, timeoutMs, (callback) => {
    sftp.close(handle, (error) => callback(error, undefined as never));
  });

const sftpFstat = (
  sftp: SFTPWrapper,
  handle: Buffer,
  signal: AbortSignal | undefined,
): Promise<Stats> =>
  callSftp<Stats>(signal, SFTP_OP_TIMEOUT_MS, (callback) => {
    sftp.fstat(handle, (error, stats) => callback(error, stats));
  });

const sftpLstatMaybe = async (
  sftp: SFTPWrapper,
  remotePath: string,
  signal: AbortSignal | undefined,
): Promise<Stats | null> => {
  try {
    return await callSftp<Stats>(signal, SFTP_OP_TIMEOUT_MS, (callback) => {
      sftp.lstat(remotePath, (error, stats) => callback(error, stats));
    });
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
};

const sftpRealpath = (
  sftp: SFTPWrapper,
  remotePath: string,
  signal: AbortSignal | undefined,
): Promise<string> =>
  callSftp<string>(signal, SFTP_OP_TIMEOUT_MS, (callback) => {
    sftp.realpath(remotePath, (error, resolved) => callback(error, resolved));
  });

const sftpReadChunk = (
  sftp: SFTPWrapper,
  handle: Buffer,
  buffer: Buffer,
  length: number,
  position: number,
  signal: AbortSignal | undefined,
): Promise<number> =>
  callSftp<number>(signal, SFTP_OP_TIMEOUT_MS, (callback) => {
    sftp.read(handle, buffer, 0, length, position, (error, bytesRead) =>
      callback(error, bytesRead),
    );
  });

const sftpWriteChunk = (
  sftp: SFTPWrapper,
  handle: Buffer,
  buffer: Buffer,
  length: number,
  position: number,
  signal: AbortSignal | undefined,
): Promise<void> =>
  callSftp<void>(signal, SFTP_OP_TIMEOUT_MS, (callback) => {
    sftp.write(handle, buffer, 0, length, position, (error) =>
      callback(error, undefined as never),
    );
  });

const sftpUnlinkQuiet = async (
  sftp: SFTPWrapper,
  remotePath: string,
): Promise<void> => {
  try {
    await callSftp<void>(undefined, CLEANUP_TIMEOUT_MS, (callback) => {
      sftp.unlink(remotePath, (error) => callback(error, undefined as never));
    });
  } catch {
    // 清理失败不覆盖主错误；残留由任务错误信息提示。
  }
};

const sftpFsyncQuiet = async (
  sftp: SFTPWrapper,
  handle: Buffer,
  signal: AbortSignal | undefined,
): Promise<void> => {
  if (typeof sftp.ext_openssh_fsync !== "function") {
    return;
  }
  try {
    await callSftp<void>(signal, SFTP_OP_TIMEOUT_MS, (callback) => {
      sftp.ext_openssh_fsync(handle, (error) =>
        callback(error, undefined as never),
      );
    });
  } catch (error) {
    if (!isUnsupportedOpenSshExtension(error)) {
      throw error;
    }
  }
};

// ===== 边界与类型检查 =====

const assertTransferBoundary = async (
  sftp: SFTPWrapper,
  remotePath: string,
  workspaceRoot: string,
  signal: AbortSignal | undefined,
): Promise<void> => {
  const normalizedPath = normalizeSshRemotePath(remotePath);
  const normalizedRoot = normalizeSshRemotePath(workspaceRoot);
  if (!isSshPathWithinRoot(normalizedPath, normalizedRoot)) {
    throw new SshTransferError(
      "SSH_TRANSFER_OUTSIDE_WORKSPACE",
      "Remote path is outside the authorized workspace",
    );
  }
  const [resolvedRoot, resolvedParent] = await Promise.all([
    sftpRealpath(sftp, normalizedRoot, signal),
    sftpRealpath(sftp, remoteDirname(normalizedPath), signal),
  ]);
  if (!isSshPathWithinRoot(resolvedParent, resolvedRoot)) {
    throw new SshTransferError(
      "SSH_TRANSFER_OUTSIDE_WORKSPACE",
      "Remote path parent resolves outside the authorized workspace",
    );
  }
};

const assertRemoteRegularFile = (remotePath: string, stats: Stats): void => {
  if (stats.isSymbolicLink()) {
    throw new SshTransferError(
      "SSH_TRANSFER_SYMLINK_NOT_ALLOWED",
      `Refusing to transfer symbolic link: ${remotePath}`,
    );
  }
  if (!stats.isFile()) {
    throw new SshTransferError(
      "SSH_TRANSFER_NOT_A_FILE",
      `Only regular files are supported: ${remotePath}`,
    );
  }
};

type RemoteEntryVersion = {
  exists: boolean;
  size?: number;
  mtime?: number;
};

const toRemoteVersion = (stats: Stats | null): RemoteEntryVersion =>
  stats
    ? { exists: true, size: stats.size, mtime: stats.mtime }
    : { exists: false };

const remoteVersionChanged = (
  recorded: RemoteEntryVersion,
  current: RemoteEntryVersion,
): boolean => {
  if (recorded.exists !== current.exists) {
    return true;
  }
  if (!recorded.exists) {
    return false;
  }
  return recorded.size !== current.size || recorded.mtime !== current.mtime;
};

// ===== 本地文件工具 =====

const lstatLocalMaybe = async (
  targetPath: string,
): Promise<fs.Stats | null> => {
  try {
    return await fs.promises.lstat(targetPath);
  } catch {
    return null;
  }
};

const localFileExists = async (targetPath: string): Promise<boolean> =>
  (await lstatLocalMaybe(targetPath)) !== null;

const createLocalTempPath = (dir: string, baseName: string): string =>
  localPath.join(
    dir,
    `.${baseName}.snow-${randomBytes(12).toString("hex")}.part`,
  );

const createRemoteTempPath = (dir: string, baseName: string): string =>
  joinRemotePath(
    dir,
    `.${baseName}.snow-${randomBytes(12).toString("hex")}.tmp`,
  );

/**
 * 提交本地临时文件：
 * - overwrite=true：rename 覆盖（同目录内为原子可见替换）；
 * - overwrite=false：先尝试硬链接（原子防覆盖），链接不受支持时退化为
 *   「检查不存在后 rename」，并在调用方文案中保持“best effort”口径。
 */
const commitLocalFile = async (
  tempPath: string,
  targetPath: string,
  overwrite: boolean,
): Promise<void> => {
  if (overwrite) {
    try {
      await fs.promises.rename(tempPath, targetPath);
      return;
    } catch (error) {
      throw new SshTransferError(
        "SSH_TRANSFER_IO_FAILED",
        `Failed to replace the local target (it may be open in another program): ${errorMessage(error)}`,
      );
    }
  }

  try {
    await fs.promises.link(tempPath, targetPath);
    try {
      await fs.promises.unlink(tempPath);
    } catch {
      // 临时文件残留不影响已完成的提交，仅留下隐藏的 .part 文件。
    }
    return;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    if (code === "EEXIST") {
      throw new SshTransferError(
        "SSH_TRANSFER_TARGET_EXISTS",
        "Local target appeared during the transfer; retry to choose another name",
      );
    }
    // 部分文件系统不支持硬链接：退化为先检查再 rename（best effort）。
    if (await localFileExists(targetPath)) {
      throw new SshTransferError(
        "SSH_TRANSFER_TARGET_EXISTS",
        "Local target appeared during the transfer; retry to choose another name",
      );
    }
    try {
      await fs.promises.rename(tempPath, targetPath);
    } catch (renameError) {
      throw new SshTransferError(
        "SSH_TRANSFER_IO_FAILED",
        `Failed to commit the local file: ${errorMessage(renameError)}`,
      );
    }
  }
};

// ===== 冲突协商 =====

type NegotiatedTarget =
  | {
      action: "target";
      name: string;
      overwrite: boolean;
      recorded: RemoteEntryVersion;
    }
  | { action: "skip" };

const suggestFreeName = async (
  baseName: string,
  exists: (name: string) => Promise<boolean>,
): Promise<string> => {
  let candidate = suggestAlternativeName(baseName);
  for (let attempt = 0; attempt < FREE_NAME_MAX_ATTEMPTS; attempt += 1) {
    if (!(await exists(candidate))) {
      return candidate;
    }
    candidate = incrementAlternativeName(candidate);
  }
  return candidate;
};

type NegotiateArgs = {
  direction: "upload" | "download";
  baseName: string;
  targetDirDisplay: string;
  signal: AbortSignal | undefined;
  /** 与 baseName 对应的当前目标版本（在调用前检测）。 */
  initialVersion: RemoteEntryVersion;
  existingSize: number | null;
  exists: (name: string) => Promise<boolean>;
  requestConflict: (
    request: SshTransferConflictRequest,
  ) => Promise<SshTransferConflictDecision>;
  validateName: (name: string) => string | null;
};

/**
 * 冲突协商循环：内核负责计算可用替代名与二次存在性检查，
 * 界面只负责给出用户决策；用户指定的名字仍被占用时最多重新协商 3 轮。
 */
const negotiateTarget = async (
  args: NegotiateArgs,
): Promise<NegotiatedTarget> => {
  let round = 0;
  let suggestion = await suggestFreeName(args.baseName, args.exists);

  while (round < CONFLICT_MAX_ROUNDS) {
    throwIfAborted(args.signal);
    const decision = await args.requestConflict({
      direction: args.direction,
      baseName: args.baseName,
      suggestedName: suggestion,
      targetPath: `${args.targetDirDisplay}/${args.baseName}`,
      existingSize: args.existingSize,
    });
    throwIfAborted(args.signal);

    if (decision.action === "skip") {
      return { action: "skip" };
    }
    if (decision.action === "cancel") {
      throw new SshTransferError(
        "SSH_TRANSFER_CANCELLED",
        "Transfer cancelled",
      );
    }
    if (decision.action === "replace") {
      if (!(await args.exists(args.baseName))) {
        // 冲突目标在协商期间消失：按新建提交。
        return {
          action: "target",
          name: args.baseName,
          overwrite: false,
          recorded: { exists: false },
        };
      }
      return {
        action: "target",
        name: args.baseName,
        overwrite: true,
        recorded: args.initialVersion,
      };
    }

    const requested = (decision.newName ?? suggestion).trim() || suggestion;
    const validationError = args.validateName(requested);
    if (validationError) {
      throw new SshTransferError(
        "SSH_TRANSFER_PATH_INVALID",
        `Invalid target name: ${validationError}`,
      );
    }
    if (requested === args.baseName) {
      // 名字保持不变视为替换。
      const stillExists = await args.exists(args.baseName);
      return {
        action: "target",
        name: args.baseName,
        overwrite: stillExists,
        recorded: stillExists ? args.initialVersion : { exists: false },
      };
    }
    if (!(await args.exists(requested))) {
      return {
        action: "target",
        name: requested,
        overwrite: false,
        recorded: { exists: false },
      };
    }
    suggestion = await suggestFreeName(requested, args.exists);
    round += 1;
  }

  throw new SshTransferError(
    "SSH_TRANSFER_CONFLICT_UNRESOLVED",
    "The chosen name is still in use; transfer cancelled",
  );
};

// ===== 下载 =====

export const runDownloadTransfer = async (
  ctx: SshTransferRunContext,
): Promise<SshTransferRunResult> => {
  const session = getSshSession(ctx.sessionId);
  if (!session) {
    throw new SshTransferError(
      "SSH_TRANSFER_NOT_CONNECTED",
      "SSH session not found. Please reconnect.",
    );
  }
  const signal = ctx.signal;
  ctx.onPhase("preparing");

  const channel = await openSshTransferChannel(session, signal);
  const sftp = channel.sftp;
  let remoteHandle: Buffer | undefined;
  let localHandle: fs.promises.FileHandle | undefined;
  let tempPath: string | undefined;
  let committed = false;

  try {
    // 1) 远端源文件与边界检查
    await assertTransferBoundary(
      sftp,
      ctx.remotePath,
      ctx.workspaceRoot,
      signal,
    );
    const initial = await sftpLstatMaybe(sftp, ctx.remotePath, signal);
    if (!initial) {
      throw new SshTransferError(
        "SSH_TRANSFER_NOT_A_FILE",
        "Remote source file does not exist",
      );
    }
    assertRemoteRegularFile(ctx.remotePath, initial);
    const initialVersion = toRemoteVersion(initial);

    // 2) 本地目标与冲突协商
    const targetDir = localPath.dirname(ctx.localPath);
    const dirStats = await lstatLocalMaybe(targetDir);
    if (!dirStats || !dirStats.isDirectory()) {
      throw new SshTransferError(
        "SSH_TRANSFER_PATH_INVALID",
        "Local target directory does not exist",
      );
    }
    let targetName = localPath.basename(ctx.localPath);
    let overwrite = false;

    const initialTarget = await lstatLocalMaybe(
      localPath.join(targetDir, targetName),
    );
    if (initialTarget && initialTarget.isDirectory()) {
      throw new SshTransferError(
        "SSH_TRANSFER_NOT_A_FILE",
        "Local target path is a folder",
      );
    }
    if (initialTarget) {
      const negotiated = await negotiateTarget({
        direction: "download",
        baseName: targetName,
        targetDirDisplay: targetDir,
        signal,
        initialVersion: {
          exists: true,
          size: initialTarget.size,
          mtime: initialTarget.mtimeMs,
        },
        existingSize: initialTarget.size,
        exists: (name) => localFileExists(localPath.join(targetDir, name)),
        requestConflict: ctx.requestConflict,
        validateName: (name) => validateLocalBaseName(name),
      });
      if (negotiated.action === "skip") {
        return { outcome: "skipped" };
      }
      targetName = negotiated.name;
      overwrite = negotiated.overwrite;
    }
    const targetPath = localPath.join(targetDir, targetName);

    // 3) 传输到本地临时文件
    tempPath = createLocalTempPath(targetDir, targetName);
    localHandle = await fs.promises.open(tempPath, "wx", 0o600);
    ctx.onPhase("transferring");

    remoteHandle = await sftpOpenRemote(sftp, ctx.remotePath, "r", signal);
    const remoteInfo = await sftpFstat(sftp, remoteHandle, signal);
    assertRemoteRegularFile(ctx.remotePath, remoteInfo);
    const total = remoteInfo.size;

    let transferred = 0;
    ctx.onProgress(0, total);
    const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
    while (transferred < total) {
      throwIfAborted(signal);
      const length = Math.min(CHUNK_SIZE, total - transferred);
      const bytesRead = await sftpReadChunk(
        sftp,
        remoteHandle,
        buffer,
        length,
        transferred,
        signal,
      );
      if (bytesRead <= 0 || bytesRead > length) {
        throw new SshTransferError(
          "SSH_TRANSFER_SIZE_MISMATCH",
          `Unexpected read result at offset ${transferred}`,
        );
      }
      await localHandle.write(buffer, 0, bytesRead, transferred);
      transferred += bytesRead;
      ctx.onProgress(transferred, total);
    }

    // 4) 校验：本地字节数 + 远端源未发生变化
    ctx.onPhase("verifying");
    try {
      await localHandle.sync();
    } catch {
      // fsync 不支持时忽略；字节数校验仍然生效。
    }
    const localInfo = await localHandle.stat();
    if (localInfo.size !== transferred || transferred !== total) {
      throw new SshTransferError(
        "SSH_TRANSFER_SIZE_MISMATCH",
        "Local file size does not match the remote source",
      );
    }
    await sftpCloseRemote(sftp, remoteHandle, signal);
    remoteHandle = undefined;

    const after = await sftpLstatMaybe(sftp, ctx.remotePath, signal);
    if (
      !after ||
      remoteVersionChanged(initialVersion, toRemoteVersion(after))
    ) {
      throw new SshTransferError(
        "SSH_TRANSFER_SOURCE_CHANGED",
        "Remote source file changed during the transfer; download cancelled",
      );
    }
    await localHandle.close();
    localHandle = undefined;

    // 5) 提交
    ctx.onPhase("committing");
    await commitLocalFile(tempPath, targetPath, overwrite);
    committed = true;
    tempPath = undefined;

    return {
      outcome: "committed",
      bytes: transferred,
      finalTargetPath: targetPath,
    };
  } catch (error) {
    throw normalizeTransferError(error);
  } finally {
    if (remoteHandle) {
      await sftpCloseRemote(
        sftp,
        remoteHandle,
        undefined,
        CLEANUP_TIMEOUT_MS,
      ).catch(() => undefined);
    }
    if (localHandle) {
      await localHandle.close().catch(() => undefined);
    }
    if (!committed && tempPath) {
      await fs.promises.unlink(tempPath).catch(() => undefined);
    }
    channel.end();
  }
};

// ===== 上传 =====

export const runUploadTransfer = async (
  ctx: SshTransferRunContext,
): Promise<SshTransferRunResult> => {
  const session = getSshSession(ctx.sessionId);
  if (!session) {
    throw new SshTransferError(
      "SSH_TRANSFER_NOT_CONNECTED",
      "SSH session not found. Please reconnect.",
    );
  }
  const signal = ctx.signal;
  ctx.onPhase("preparing");

  const channel = await openSshTransferChannel(session, signal);
  const sftp = channel.sftp;
  let remoteHandle: Buffer | undefined;
  let localHandle: fs.promises.FileHandle | undefined;
  let tempRemote: string | undefined;
  let committed = false;

  try {
    // 2) 目标目录、本地源文件与冲突协商
    const normalizedRemote = normalizeSshRemotePath(ctx.remotePath);
    const targetNameCandidate = normalizedRemote.slice(
      normalizedRemote.lastIndexOf("/") + 1,
    );
    if (!targetNameCandidate || targetNameCandidate.includes("\\")) {
      throw new SshTransferError(
        "SSH_TRANSFER_PATH_INVALID",
        "Remote target must be an absolute file path",
      );
    }
    const targetDir = remoteDirname(normalizedRemote);
    await assertTransferBoundary(
      sftp,
      ctx.remotePath,
      ctx.workspaceRoot,
      signal,
    );
    const dirStats = await sftpLstatMaybe(sftp, targetDir, signal);
    if (!dirStats || !dirStats.isDirectory()) {
      throw new SshTransferError(
        "SSH_TRANSFER_PATH_INVALID",
        "Remote target directory does not exist",
      );
    }

    localHandle = await fs.promises.open(ctx.localPath, "r");
    const sourceInfo = await localHandle.stat();
    if (!sourceInfo.isFile()) {
      throw new SshTransferError(
        "SSH_TRANSFER_NOT_A_FILE",
        "Only regular local files can be uploaded",
      );
    }
    const sourceVersion = {
      size: sourceInfo.size,
      mtimeMs: sourceInfo.mtimeMs,
    };

    let targetName = targetNameCandidate;
    let overwrite = false;
    let recordedTarget: RemoteEntryVersion = { exists: false };

    const initialTarget = await sftpLstatMaybe(sftp, ctx.remotePath, signal);
    if (initialTarget && !initialTarget.isFile()) {
      throw new SshTransferError(
        initialTarget.isSymbolicLink()
          ? "SSH_TRANSFER_SYMLINK_NOT_ALLOWED"
          : "SSH_TRANSFER_NOT_A_FILE",
        "Remote target exists and is not a regular file",
      );
    }
    if (initialTarget) {
      const negotiated = await negotiateTarget({
        direction: "upload",
        baseName: targetName,
        targetDirDisplay: targetDir,
        signal,
        initialVersion: toRemoteVersion(initialTarget),
        existingSize: initialTarget.size,
        exists: async (name) =>
          (await sftpLstatMaybe(
            sftp,
            joinRemotePath(targetDir, name),
            signal,
          )) !== null,
        requestConflict: ctx.requestConflict,
        validateName: (name) => validateRemoteBaseName(name),
      });
      if (negotiated.action === "skip") {
        return { outcome: "skipped" };
      }
      targetName = negotiated.name;
      overwrite = negotiated.overwrite;
      recordedTarget = negotiated.recorded;
    }
    const targetPath = joinRemotePath(targetDir, targetName);

    // 3) 上传到远端临时文件
    tempRemote = createRemoteTempPath(targetDir, targetName);
    remoteHandle = await sftpOpenRemote(sftp, tempRemote, "wx", signal, {
      mode: 0o600,
    });
    ctx.onPhase("transferring");

    const total = sourceVersion.size;
    let transferred = 0;
    ctx.onProgress(0, total);
    const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
    while (transferred < total) {
      throwIfAborted(signal);
      const length = Math.min(CHUNK_SIZE, total - transferred);
      const { bytesRead } = await localHandle.read(
        buffer,
        0,
        length,
        transferred,
      );
      if (bytesRead <= 0) {
        throw new SshTransferError(
          "SSH_TRANSFER_SIZE_MISMATCH",
          `Unexpected local read result at offset ${transferred}`,
        );
      }
      await sftpWriteChunk(
        sftp,
        remoteHandle,
        buffer,
        bytesRead,
        transferred,
        signal,
      );
      transferred += bytesRead;
      ctx.onProgress(transferred, total);
    }

    // 4) 校验：远端临时文件字节数 + 本地源未发生变化
    ctx.onPhase("verifying");
    await sftpFsyncQuiet(sftp, remoteHandle, signal);
    const tempInfo = await sftpFstat(sftp, remoteHandle, signal);
    if (tempInfo.size !== transferred || transferred !== total) {
      throw new SshTransferError(
        "SSH_TRANSFER_SIZE_MISMATCH",
        "Remote temporary file size does not match the local source",
      );
    }
    await sftpCloseRemote(sftp, remoteHandle, signal);
    remoteHandle = undefined;

    const sourceAfter = await localHandle.stat();
    if (
      sourceAfter.size !== sourceVersion.size ||
      sourceAfter.mtimeMs !== sourceVersion.mtimeMs
    ) {
      throw new SshTransferError(
        "SSH_TRANSFER_SOURCE_CHANGED",
        "Local source file changed during the transfer; upload cancelled",
      );
    }
    await localHandle.close();
    localHandle = undefined;

    // 5) 提交前重新检查边界与目标状态
    await assertTransferBoundary(sftp, targetPath, ctx.workspaceRoot, signal);
    const currentTarget = await sftpLstatMaybe(sftp, targetPath, signal);
    if (remoteVersionChanged(recordedTarget, toRemoteVersion(currentTarget))) {
      throw new SshTransferError(
        "SSH_TRANSFER_TARGET_CHANGED",
        "Remote target changed during the transfer; retry the upload",
      );
    }

    // 6) 提交
    ctx.onPhase("committing");
    if (overwrite) {
      const replaced = await tryAtomicReplaceCommit(
        sftp,
        tempRemote,
        targetPath,
        signal,
      );
      if (!replaced) {
        throw new SshTransferError(
          "SSH_TRANSFER_REPLACE_UNSUPPORTED",
          "The server does not support safe atomic replacement; save under a new name instead",
        );
      }
    } else {
      await plainRenameCommit(sftp, tempRemote, targetPath, signal);
    }
    committed = true;
    tempRemote = undefined;

    return {
      outcome: "committed",
      bytes: transferred,
      finalTargetPath: targetPath,
    };
  } catch (error) {
    throw normalizeTransferError(error);
  } finally {
    if (remoteHandle) {
      await sftpCloseRemote(
        sftp,
        remoteHandle,
        undefined,
        CLEANUP_TIMEOUT_MS,
      ).catch(() => undefined);
    }
    if (localHandle) {
      await localHandle.close().catch(() => undefined);
    }
    if (!committed && tempRemote) {
      await sftpUnlinkQuiet(sftp, tempRemote);
    }
    channel.end();
  }
};

// ===== 提交操作（远端） =====

/**
 * 原子替换提交：优先 OpenSSH posix-rename 扩展。
 * - 扩展不支持：返回 false，由调用方给出「另存为」建议；
 * - 超时 / 传输中断：抛出 commit-unknown（可能已生效，绝不重试覆盖）。
 */
const tryAtomicReplaceCommit = async (
  sftp: SFTPWrapper,
  tempRemote: string,
  targetPath: string,
  signal: AbortSignal | undefined,
): Promise<boolean> => {
  if (typeof sftp.ext_openssh_rename !== "function") {
    return false;
  }
  try {
    await callSftp<void>(signal, COMMIT_TIMEOUT_MS, (callback) => {
      sftp.ext_openssh_rename(tempRemote, targetPath, (error) =>
        callback(error, undefined as never),
      );
    });
    return true;
  } catch (error) {
    if (error instanceof SshTransferError) {
      if (error.code === "SSH_TRANSFER_TIMEOUT") {
        throw new SshTransferError(
          "SSH_TRANSFER_COMMIT_UNKNOWN",
          "The replacement may or may not have completed; the connection was interrupted before confirmation",
        );
      }
      throw error;
    }
    if (isUnsupportedOpenSshExtension(error)) {
      return false;
    }
    if (isTransportLossError(error)) {
      throw new SshTransferError(
        "SSH_TRANSFER_COMMIT_UNKNOWN",
        "The replacement may or may not have completed; the connection was interrupted before confirmation",
      );
    }
    throw new SshTransferError(
      "SSH_TRANSFER_IO_FAILED",
      `Failed to replace the remote file: ${errorMessage(error)}`,
    );
  }
};

/**
 * 新建提交：普通 rename。SFTP 协议语义不保证 no-clobber（OpenSSH 实现会覆盖），
 * 因此在调用前刚做过目标不存在检查（best effort），文案不得宣称严格防覆盖。
 */
const plainRenameCommit = async (
  sftp: SFTPWrapper,
  tempRemote: string,
  targetPath: string,
  signal: AbortSignal | undefined,
): Promise<void> => {
  try {
    await callSftp<void>(signal, COMMIT_TIMEOUT_MS, (callback) => {
      sftp.rename(tempRemote, targetPath, (error) =>
        callback(error, undefined as never),
      );
    });
  } catch (error) {
    if (error instanceof SshTransferError) {
      if (error.code === "SSH_TRANSFER_TIMEOUT") {
        throw new SshTransferError(
          "SSH_TRANSFER_COMMIT_UNKNOWN",
          "The upload may or may not have completed; the connection was interrupted before confirmation",
        );
      }
      throw error;
    }
    if (isTransportLossError(error)) {
      throw new SshTransferError(
        "SSH_TRANSFER_COMMIT_UNKNOWN",
        "The upload may or may not have completed; the connection was interrupted before confirmation",
      );
    }
    throw new SshTransferError(
      "SSH_TRANSFER_IO_FAILED",
      `Failed to publish the remote file: ${errorMessage(error)}`,
    );
  }
};

// ===== 错误归一化 =====

/**
 * 把底层错误（ssh2 / SshOperationError / fs）归一化为带稳定错误码的
 * SshTransferError，供任务管理器映射到界面文案。
 */
const normalizeTransferError = (error: unknown): SshTransferError => {
  if (error instanceof SshTransferError) {
    return error;
  }
  if (error instanceof SshOperationError) {
    const codeMap: Record<string, string> = {
      SSH_FILE_INVALID_PATH: "SSH_TRANSFER_PATH_INVALID",
      SSH_FILE_OUTSIDE_WORKSPACE: "SSH_TRANSFER_OUTSIDE_WORKSPACE",
      SSH_FILE_SYMLINK_NOT_ALLOWED: "SSH_TRANSFER_SYMLINK_NOT_ALLOWED",
      SSH_FILE_TYPE_UNSUPPORTED: "SSH_TRANSFER_NOT_A_FILE",
      SSH_OPERATION_CANCELLED: "SSH_TRANSFER_CANCELLED",
    };
    return new SshTransferError(
      codeMap[error.code] ?? "SSH_TRANSFER_IO_FAILED",
      error.message.replace(/^\[[^\]]+\]\s*/, ""),
    );
  }
  const message = errorMessage(error);
  if (isTransportLossError(error)) {
    return new SshTransferError(
      "SSH_TRANSFER_NOT_CONNECTED",
      "SSH connection was interrupted during the transfer",
    );
  }
  return new SshTransferError(
    "SSH_TRANSFER_IO_FAILED",
    message || "SSH file transfer failed",
  );
};
