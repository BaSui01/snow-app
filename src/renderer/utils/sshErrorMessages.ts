/**
 * SSH 相关错误的本地化辅助。
 *
 * 主进程 ssh2 操作（读目录/读写文件/执行命令等）抛出的错误是英文技术
 * 消息，且经 Electron IPC 传输后还会带上
 * `Error invoking remote method 'ssh:xxx': Error: ` 前缀。此模块负责：
 * 1. 剥离 IPC 包装前缀，还原原始消息；
 * 2. 识别已知错误模式，映射为当前语言的友好文案（detail 保留原始原因）。
 */

export type LocalizedSshError = {
  /** 本地化主文案。 */
  message: string;
  /** 原始技术原因（已剥离 IPC 前缀），用于排查。 */
  detail?: string;
};

type TranslateFn = (
  key: string,
  options?: { defaultValue?: string; values?: Record<string, string | number> },
) => string;

const IPC_ERROR_PREFIX =
  /^Error invoking remote method '[^']+': Error: (?:Error: )?(.*)$/s;

export const stripIpcErrorPrefix = (message: string): string => {
  const match = IPC_ERROR_PREFIX.exec(message);
  return match ? match[1] : message;
};

/**
 * 把 SSH 相关错误转换为「本地化主文案 + 原始原因」。
 * 未知错误原样返回（message 为剥离前缀后的原始消息，detail 为空），
 * 不会让用户看到 IPC 包装前缀。
 */
export const localizeSshError = (
  err: unknown,
  t: TranslateFn,
): LocalizedSshError => {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const detail = stripIpcErrorPrefix(raw);

  if (detail.includes("SSH session not found")) {
    return {
      message: t("sidebar.sshErrorSessionLost", {
        defaultValue: "SSH connection lost. Please reconnect.",
      }),
      detail,
    };
  }
  if (detail.startsWith("Failed to read remote directory")) {
    return {
      message: t("sidebar.sshBrowseError", {
        defaultValue: "Failed to list remote directory",
      }),
      detail,
    };
  }
  if (detail.startsWith("Failed to read remote file")) {
    return {
      message: t("sidebar.sshErrorReadFile", {
        defaultValue: "Failed to read remote file",
      }),
      detail,
    };
  }
  if (detail.startsWith("Failed to write remote file")) {
    return {
      message: t("sidebar.sshErrorWriteFile", {
        defaultValue: "Failed to write remote file",
      }),
      detail,
    };
  }
  if (detail.startsWith("Failed to delete remote file")) {
    return {
      message: t("sidebar.sshErrorDelete", {
        defaultValue: "Failed to delete remote entry",
      }),
      detail,
    };
  }
  if (detail.startsWith("Failed to rename remote file")) {
    return {
      message: t("sidebar.sshErrorRename", {
        defaultValue: "Failed to rename remote entry",
      }),
      detail,
    };
  }
  if (detail.includes("timed out after")) {
    return {
      message: t("sidebar.sshErrorCommandTimeout", {
        defaultValue: "Remote command timed out",
      }),
      detail,
    };
  }
  if (detail.startsWith("Failed to execute remote command")) {
    return {
      message: t("sidebar.sshErrorCommand", {
        defaultValue: "Failed to execute remote command",
      }),
      detail,
    };
  }
  if (detail === "Remote path does not exist") {
    return {
      message: t("sidebar.sshErrorPathMissing", {
        defaultValue: "Remote path does not exist",
      }),
      detail,
    };
  }

  return { message: detail };
};

// ===== SSH 文件传输错误本地化 =====

/** 传输错误码 → 渲染层文案 key（与 lang 三语文件中的键保持一致）。 */
const SSH_TRANSFER_ERROR_MESSAGE_KEYS: Record<string, string> = {
  SSH_TRANSFER_NOT_CONNECTED: "explorer.transferErrorNotConnected",
  SSH_TRANSFER_TIMEOUT: "explorer.transferErrorTimeout",
  SSH_TRANSFER_SOURCE_CHANGED: "explorer.transferErrorSourceChanged",
  SSH_TRANSFER_TARGET_CHANGED: "explorer.transferErrorTargetChanged",
  SSH_TRANSFER_REPLACE_UNSUPPORTED: "explorer.transferErrorReplaceUnsupported",
  SSH_TRANSFER_COMMIT_UNKNOWN: "explorer.transferErrorCommitUnknown",
  SSH_TRANSFER_SIZE_MISMATCH: "explorer.transferErrorSizeMismatch",
  SSH_TRANSFER_PATH_INVALID: "explorer.transferErrorPathInvalid",
  SSH_TRANSFER_OUTSIDE_WORKSPACE: "explorer.transferErrorOutsideWorkspace",
  SSH_TRANSFER_NOT_A_FILE: "explorer.transferErrorNotAFile",
  SSH_TRANSFER_SYMLINK_NOT_ALLOWED: "explorer.transferErrorSymlink",
  SSH_TRANSFER_CONFLICT_UNRESOLVED: "explorer.transferErrorConflictUnresolved",
  SSH_TRANSFER_TARGET_EXISTS: "explorer.transferErrorExists",
  SSH_TRANSFER_IO_FAILED: "explorer.transferErrorIo",
  SSH_TRANSFER_WORKSPACE_INVALID: "explorer.transferErrorGeneric",
};

/**
 * 把传输任务的错误对象转成当前语言的文案。
 * 已知错误码走本地化键（缺失时回退主进程英文消息），未知错误原样展示。
 */
export const localizeSshTransferError = (
  error: { code: string; message: string } | null,
  t: TranslateFn,
): string => {
  if (!error) {
    return "";
  }
  const key = SSH_TRANSFER_ERROR_MESSAGE_KEYS[error.code];
  if (key) {
    return t(key, { defaultValue: error.message });
  }
  return error.message;
};
