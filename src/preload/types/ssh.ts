export type SshAuthMethod = "password" | "privateKey" | "agent";

export type SshConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "degraded"
  | "reconnecting"
  | "offline"
  | "auth_required"
  | "host_key_changed";

/** A stable SSH profile handle; sessionId changes whenever the transport reconnects. */
export type SshProfileConnection = {
  profileId: string;
  sessionId?: string;
  generation: number;
  status: SshConnectionStatus;
  lastError?: string;
};

/**
 * SSH 连接失败的错误码，由主进程 `ssh:connect` handler 分类产生，
 * 渲染层据此展示本地化的友好提示。
 */
export type SshConnectErrorCode =
  "network" | "timeout" | "auth" | "sftp" | "invalid" | "unknown";

/** preload 抛出的 SSH 连接错误：携带错误码与原始技术细节。 */
export type SshConnectError = Error & {
  code?: SshConnectErrorCode;
  detail?: string;
};

/**
 * `ssh:connect` 的结构化返回结果。注意：contextBridge 序列化 Error 时
 * 会丢弃自定义属性（code/detail），因此需要完整错误信息的调用方
 * （如连接向导）应使用 `sshConnectDetailed` 直接消费本类型。
 */
export type SshConnectResult =
  | { ok: true; sessionId: string }
  | { ok: false; code: SshConnectErrorCode; message: string; detail: string };

/** 单级 ProxyJump 的跳板机连接参数。 */
export type SshJumpHost = {
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  privateKeyPath?: string;
  /** password (authMethod "password") 或 passphrase (authMethod "privateKey") */
  secret?: string;
};

/** 已保存的跳板机记录：secret 以密文存放。 */
export type SshJumpHostRecord = Omit<SshJumpHost, "secret"> & {
  encryptedSecret?: string;
};

export type SshConnectParams = {
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  /** 经跳板机（ProxyJump）连接目标主机，仅支持单级。 */
  jump?: SshJumpHost;
  hostKeyPolicy?: "replace";
};

export type SshDirectoryEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
};

export type SshCapabilities = {
  platform: "posix" | "windows";
  remoteOs?: string;
  remoteArch?: string;
  posixShell: boolean;
  systemdUser: boolean;
  tmux: boolean;
  setsid: boolean;
  nohup: boolean;
  powerShell: boolean;
};

export type SshFileSaveGuarantee =
  "strong_atomic" | "atomic_best_effort" | "compatibility";

export type SshFileVersion = {
  exists: boolean;
  sha256?: string;
  size?: number;
  mtime?: number;
};

export type SshFileWriteOptions = {
  /** Stable SSH workspace record that Main resolves to the authorized root. */
  workspaceId: string;
  /** Required write CAS precondition for all user-reachable saves. */
  expectedVersion: SshFileVersion;
};

export type SshFileWriteResult = {
  guarantee: SshFileSaveGuarantee;
  sideEffect: "committed";
  bytes: number;
  version: SshFileVersion;
  durability: {
    fsynced: boolean;
    posixRename: boolean;
  };
};

export type RemoteDraftStatus = "pending" | "conflict";

export type RemoteDraftInput = {
  profileId: string;
  workspaceId: string;
  remotePath: string;
  baseVersionJson: string;
  content: string;
  status: RemoteDraftStatus;
};

export type RemoteDraftRecord = RemoteDraftInput & {
  id: string;
  updatedAt: string;
};

export type RemoteWorkspaceFileSearchOptions = {
  query: string;
  listChildren: boolean;
};

// ===== SSH 文件传输（上传 / 下载） =====

export type SshTransferDirection = "upload" | "download";

export type SshTransferStatus =
  | "queued"
  | "preparing"
  | "awaiting-conflict"
  | "transferring"
  | "verifying"
  | "committing"
  | "succeeded"
  | "skipped"
  | "failed"
  | "cancelled"
  | "commit-unknown";

export type SshTransferConflictSnapshot = {
  direction: SshTransferDirection;
  baseName: string;
  suggestedName: string;
  targetPath: string;
  existingSize: number | null;
  rounds: number;
};

export type SshTransferTaskSnapshot = {
  taskId: string;
  batchId: string;
  direction: SshTransferDirection;
  status: SshTransferStatus;
  name: string;
  remotePath: string;
  localPath: string;
  /** 提交完成后的最终目标路径（下载为本地路径、上传为远端路径）。 */
  finalPath: string | null;
  workspaceId: string;
  profileId: string;
  bytesTotal: number | null;
  bytesTransferred: number;
  startedAt: number;
  endedAt: number | null;
  error: { code: string; message: string } | null;
  conflict: SshTransferConflictSnapshot | null;
};

export type SshTransferBatchSnapshot = {
  batchId: string;
  workspaceId: string;
  profileId: string;
  total: number;
  pending: number;
  succeeded: number;
  skipped: number;
  failed: number;
  cancelled: number;
  commitUnknown: number;
};

export type SshTransferSnapshot = {
  version: number;
  tasks: SshTransferTaskSnapshot[];
  batches: SshTransferBatchSnapshot[];
};

export type SshTransferStartResult =
  | { canceled: false; batchId: string; taskIds: string[] }
  | { canceled: true; reason: string };

export type SshTransferConflictAction = "replace" | "skip" | "rename";

/** 上传：渲染层已确认的本地普通文件路径，上传到远端目录。 */
export type SshTransferUploadParams = {
  workspaceId: string;
  remoteDirectory: string;
  localPaths: string[];
};

export type SshTransferDownloadParams = {
  workspaceId: string;
  /** 选中的远端条目路径（目录 / 缺失 / 链接项由主进程过滤并确认）。 */
  remotePaths: string[];
};

export type SshTransferCancelParams = {
  taskId?: string;
  batchId?: string;
};

export type SshTransferResolveConflictParams = {
  taskId: string;
  action: SshTransferConflictAction;
  newName?: string;
  applyToBatch?: boolean;
};

export type SshCredentialRecord = {
  profileKey: string;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  privateKeyPath?: string;
  encryptedSecret?: string;
  /** 经跳板机（ProxyJump）连接时的跳板机记录。 */
  jump?: SshJumpHostRecord;
};

export type ParsedSshUrl = {
  host: string;
  port: number;
  username: string;
  remotePath: string;
};

/** 跳板机（ProxyJump）解析结果：来自 ssh config 别名的实际连接字段。 */
export type SshConfigJumpHost = {
  /** 匹配到的 ssh config 别名；直接以 host 形式给出时为空 */
  alias?: string;
  host: string;
  port: number;
  user?: string;
  identityFile?: string;
};

/** 本地 ~/.ssh/config 中解析出的主机条目。 */
export type SshConfigHost = {
  /** `Host` 关键字的值（别名） */
  alias: string;
  /** 实际主机名（HostName，缺失时回退为 alias） */
  host: string;
  /** 登录用户名（User） */
  user?: string;
  /** 端口（Port），默认 22 */
  port: number;
  /** 私钥文件路径（IdentityFile） */
  identityFile?: string;
  /** ProxyJump 原始值（`[user@]host[:port]` 或 ssh config 别名） */
  proxyJump?: string;
  /** ProxyJump 解析后的跳板机字段 */
  proxyJumpHost?: SshConfigJumpHost;
};
