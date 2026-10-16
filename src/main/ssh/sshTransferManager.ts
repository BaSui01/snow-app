/**
 * SSH 文件传输任务管理器。
 *
 * 职责：批次 / 子任务建模、队列与并发限制、连接租约、取消、冲突协商、
 * 进度节流推送与任务快照。文件字节不经过本模块之外的任何 IPC 通道；
 * 实际的数据搬运全部发生在 sshFileTransfer 内核与本地文件之间。
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as localPath from "node:path";

import { webContents, type WebContents } from "electron";

import { getSshProfileId, sshConnectionManager } from "./sshConnectionManager";
import {
  getSshSession,
  lstatSshEntry,
  normalizeSshRemotePath,
  parseSshUrl,
  resolveSshWorkspaceRoot,
} from "./sshManager";
import {
  incrementAlternativeName,
  runDownloadTransfer,
  runUploadTransfer,
  sanitizeLocalFileName,
  suggestAlternativeName,
  SshTransferError,
  validateLocalBaseName,
  validateRemoteBaseName,
  type SshTransferConflictDecision,
  type SshTransferConflictRequest,
  type SshTransferPhase,
  type SshTransferRunContext,
} from "./sshFileTransfer";

// ===== 对外类型（与 preload/types/ssh.ts 保持同步） =====

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

export type SshTransferLocalClassification = {
  files: string[];
  skipped: Array<{
    path: string;
    reason: "directory" | "missing" | "not-file";
  }>;
};

export type SshTransferRemoteClassification = {
  files: Array<{ remotePath: string; name: string; size: number }>;
  skipped: Array<{
    path: string;
    reason: "directory" | "missing" | "not-file";
  }>;
};

export type SshTransferConflictAction = "replace" | "skip" | "rename";

// ===== 内部状态 =====

type ConflictState = {
  request: SshTransferConflictRequest;
  resolve: (decision: SshTransferConflictDecision) => void;
};

type TransferTask = {
  id: string;
  batchId: string;
  ownerWebContentsId: number;
  direction: SshTransferDirection;
  workspaceId: string;
  profileId: string;
  sessionId: string;
  generation: number;
  workspaceRoot: string;
  remotePath: string;
  localPath: string;
  name: string;
  status: SshTransferStatus;
  bytesTotal: number | null;
  bytesTransferred: number;
  startedAt: number;
  endedAt: number | null;
  finalPath: string | null;
  error: { code: string; message: string } | null;
  conflict: ConflictState | null;
  conflictRounds: number;
  abortController: AbortController;
  cancelRequested: boolean;
};

type TransferBatch = {
  id: string;
  ownerWebContentsId: number;
  workspaceId: string;
  profileId: string;
  tasks: TransferTask[];
  applyPolicy: SshTransferConflictAction | null;
  holdsConnection: boolean;
};

type WorkspaceLookup = (
  workspaceId: string,
) => Promise<{ path: string; kind: string } | null>;

const tasks = new Map<string, TransferTask>();
const batches = new Map<string, TransferBatch>();
const queued: TransferTask[] = [];
const activeByProfile = new Map<string, number>();
const emitTimers = new Map<number, NodeJS.Timeout>();
const watchedSenders = new Set<number>();

let workspaceLookup: WorkspaceLookup | undefined;
let activeTotal = 0;
let snapshotVersion = 0;

/** 全局并发上限：避免占满服务器的 SSH channel 配额。 */
const MAX_ACTIVE_TOTAL = 4;
/** 单档案并发上限：保留同一连接上的文件浏览 / 编辑器保存可用性。 */
const MAX_ACTIVE_PER_PROFILE = 2;
const PROGRESS_EMIT_INTERVAL_MS = 300;
const MAX_RETAINED_TASKS = 200;
const FREE_NAME_MAX_ATTEMPTS = 100;

const TERMINAL_STATUSES: ReadonlySet<SshTransferStatus> = new Set([
  "succeeded",
  "skipped",
  "failed",
  "cancelled",
  "commit-unknown",
]);

// ===== 基础设施 =====

/** 由 IPC 注册处注入工作区查询（native.listWorkspaceDirectories）。 */
export const initSshTransferWorkspaceLookup = (
  lookup: WorkspaceLookup,
): void => {
  workspaceLookup = lookup;
};

const dedupeStrings = (values: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
};

const joinRemote = (dir: string, name: string): string =>
  dir === "/" ? `/${name}` : `${dir}/${name}`;

const remoteBaseName = (remotePath: string): string =>
  normalizeSshRemotePath(remotePath).split("/").pop() ?? remotePath;

const localBaseName = (localPathValue: string): string =>
  localPath.basename(localPathValue);

const generateTransferId = (prefix: string): string =>
  `${prefix}-${Date.now()}-${randomBytes(4).toString("hex")}`;

const lstatLocalMaybe = async (
  targetPath: string,
): Promise<fs.Stats | null> => {
  try {
    return await fs.promises.lstat(targetPath);
  } catch {
    return null;
  }
};

// ===== 快照与推送 =====

const taskToSnapshot = (task: TransferTask): SshTransferTaskSnapshot => ({
  taskId: task.id,
  batchId: task.batchId,
  direction: task.direction,
  status: task.status,
  name: task.name,
  remotePath: task.remotePath,
  localPath: task.localPath,
  finalPath: task.finalPath,
  workspaceId: task.workspaceId,
  profileId: task.profileId,
  bytesTotal: task.bytesTotal,
  bytesTransferred: task.bytesTransferred,
  startedAt: task.startedAt,
  endedAt: task.endedAt,
  error: task.error,
  conflict: task.conflict
    ? {
        direction: task.conflict.request.direction,
        baseName: task.conflict.request.baseName,
        suggestedName: task.conflict.request.suggestedName,
        targetPath: task.conflict.request.targetPath,
        existingSize: task.conflict.request.existingSize,
        rounds: task.conflictRounds,
      }
    : null,
});

const batchToSnapshot = (batch: TransferBatch): SshTransferBatchSnapshot => {
  let pending = 0;
  let succeeded = 0;
  let skipped = 0;
  let failed = 0;
  let cancelled = 0;
  let commitUnknown = 0;
  for (const task of batch.tasks) {
    if (!TERMINAL_STATUSES.has(task.status)) {
      pending += 1;
      continue;
    }
    if (task.status === "succeeded") succeeded += 1;
    else if (task.status === "skipped") skipped += 1;
    else if (task.status === "failed") failed += 1;
    else if (task.status === "cancelled") cancelled += 1;
    else commitUnknown += 1;
  }
  return {
    batchId: batch.id,
    workspaceId: batch.workspaceId,
    profileId: batch.profileId,
    total: batch.tasks.length,
    pending,
    succeeded,
    skipped,
    failed,
    cancelled,
    commitUnknown,
  };
};

const buildSnapshot = (ownerWebContentsId: number): SshTransferSnapshot => {
  const ownerTasks = [...tasks.values()]
    .filter((task) => task.ownerWebContentsId === ownerWebContentsId)
    .sort((left, right) => left.startedAt - right.startedAt);
  const ownerBatches = [...batches.values()]
    .filter((batch) => batch.ownerWebContentsId === ownerWebContentsId)
    .map(batchToSnapshot);
  return {
    version: snapshotVersion,
    tasks: ownerTasks.map(taskToSnapshot),
    batches: ownerBatches,
  };
};

const emitNow = (ownerWebContentsId: number): void => {
  snapshotVersion += 1;
  const contents = webContents.fromId(ownerWebContentsId);
  if (!contents || contents.isDestroyed()) {
    return;
  }
  contents.send("ssh:transfers:updated", buildSnapshot(ownerWebContentsId));
};

const emitImmediate = (ownerWebContentsId: number): void => {
  const timer = emitTimers.get(ownerWebContentsId);
  if (timer) {
    clearTimeout(timer);
    emitTimers.delete(ownerWebContentsId);
  }
  emitNow(ownerWebContentsId);
};

const emitThrottled = (ownerWebContentsId: number): void => {
  if (emitTimers.has(ownerWebContentsId)) {
    return;
  }
  emitTimers.set(
    ownerWebContentsId,
    setTimeout(() => {
      emitTimers.delete(ownerWebContentsId);
      emitNow(ownerWebContentsId);
    }, PROGRESS_EMIT_INTERVAL_MS),
  );
};

/** 供 `ssh:transfers:list` 使用：返回当前窗口可见的任务快照。 */
export const getSshTransferSnapshot = (
  ownerWebContentsId: number,
): SshTransferSnapshot => buildSnapshot(ownerWebContentsId);

// ===== 状态变更 =====

const pruneTasks = (): void => {
  if (tasks.size <= MAX_RETAINED_TASKS) {
    return;
  }
  const terminal = [...tasks.values()]
    .filter((task) => TERMINAL_STATUSES.has(task.status))
    .sort((left, right) => (left.endedAt ?? 0) - (right.endedAt ?? 0));
  for (const task of terminal) {
    if (tasks.size <= MAX_RETAINED_TASKS) {
      break;
    }
    tasks.delete(task.id);
    const batch = batches.get(task.batchId);
    if (batch) {
      batch.tasks = batch.tasks.filter((entry) => entry.id !== task.id);
      if (batch.tasks.length === 0) {
        batches.delete(batch.id);
      }
    }
  }
};

const setStatus = (task: TransferTask, status: SshTransferStatus): void => {
  task.status = status;
  if (TERMINAL_STATUSES.has(status)) {
    task.endedAt = Date.now();
  }
  if (TERMINAL_STATUSES.has(status)) {
    pruneTasks();
  }
  emitImmediate(task.ownerWebContentsId);
};

const phaseToStatus = (phase: SshTransferPhase): SshTransferStatus => {
  switch (phase) {
    case "transferring":
      return "transferring";
    case "verifying":
      return "verifying";
    case "committing":
      return "committing";
    default:
      return "preparing";
  }
};

// ===== 冲突与取消 =====

const requestConflictDecision = (
  task: TransferTask,
  request: SshTransferConflictRequest,
): Promise<SshTransferConflictDecision> => {
  const batch = batches.get(task.batchId);
  const policy = batch?.applyPolicy ?? null;
  if (policy === "replace") {
    return Promise.resolve({ action: "replace" });
  }
  if (policy === "skip") {
    return Promise.resolve({ action: "skip" });
  }
  if (policy === "rename") {
    return Promise.resolve({ action: "rename" });
  }
  task.conflictRounds += 1;
  return new Promise((resolve) => {
    task.conflict = { request, resolve };
    setStatus(task, "awaiting-conflict");
  });
};

const cancelTask = (task: TransferTask): void => {
  if (TERMINAL_STATUSES.has(task.status)) {
    return;
  }
  task.cancelRequested = true;
  if (task.conflict) {
    const pending = task.conflict;
    task.conflict = null;
    pending.resolve({ action: "cancel" });
  }
  if (task.status === "queued") {
    setStatus(task, "cancelled");
    return;
  }
  if (
    task.status === "preparing" ||
    task.status === "transferring" ||
    task.status === "verifying"
  ) {
    task.abortController.abort();
  }
  // committing 阶段不承诺“可立即取消”：提交结果以确认结果为准。
};

const cancelAllForOwner = (ownerWebContentsId: number): void => {
  for (const task of tasks.values()) {
    if (
      task.ownerWebContentsId === ownerWebContentsId &&
      !TERMINAL_STATUSES.has(task.status)
    ) {
      cancelTask(task);
    }
  }
};

// ===== 队列 =====

const maybeReleaseBatch = (batchId: string): void => {
  const batch = batches.get(batchId);
  if (!batch || !batch.holdsConnection) {
    return;
  }
  const anyActive = batch.tasks.some(
    (task) => !TERMINAL_STATUSES.has(task.status),
  );
  if (anyActive) {
    return;
  }
  batch.holdsConnection = false;
  sshConnectionManager.release(batch.profileId);
};

const runTask = async (task: TransferTask): Promise<void> => {
  task.startedAt = Date.now();
  setStatus(task, "preparing");

  const runContext: SshTransferRunContext = {
    sessionId: task.sessionId,
    workspaceRoot: task.workspaceRoot,
    remotePath: task.remotePath,
    localPath: task.localPath,
    signal: task.abortController.signal,
    onPhase: (phase) => {
      setStatus(task, phaseToStatus(phase));
    },
    onProgress: (bytesTransferred, bytesTotal) => {
      task.bytesTransferred = bytesTransferred;
      task.bytesTotal = bytesTotal;
      emitThrottled(task.ownerWebContentsId);
    },
    requestConflict: (request) => requestConflictDecision(task, request),
  };

  try {
    const result =
      task.direction === "download"
        ? await runDownloadTransfer(runContext)
        : await runUploadTransfer(runContext);
    if (result.outcome === "skipped") {
      setStatus(task, "skipped");
    } else {
      task.bytesTransferred = result.bytes;
      task.finalPath = result.finalTargetPath;
      setStatus(task, "succeeded");
    }
  } catch (error) {
    if (task.cancelRequested || task.abortController.signal.aborted) {
      setStatus(task, "cancelled");
      return;
    }
    const mapped =
      error instanceof SshTransferError
        ? { code: error.code, message: error.message }
        : {
            code: "SSH_TRANSFER_IO_FAILED",
            message: error instanceof Error ? error.message : String(error),
          };
    task.error = mapped;
    setStatus(
      task,
      mapped.code === "SSH_TRANSFER_COMMIT_UNKNOWN"
        ? "commit-unknown"
        : "failed",
    );
  } finally {
    if (task.conflict) {
      const pending = task.conflict;
      task.conflict = null;
      pending.resolve({ action: "cancel" });
    }
  }
};

const pump = (): void => {
  for (let index = 0; index < queued.length;) {
    const task = queued[index];
    if (task.status !== "queued") {
      queued.splice(index, 1);
      continue;
    }
    const profileActive = activeByProfile.get(task.profileId) ?? 0;
    if (
      activeTotal >= MAX_ACTIVE_TOTAL ||
      profileActive >= MAX_ACTIVE_PER_PROFILE
    ) {
      index += 1;
      continue;
    }
    queued.splice(index, 1);
    activeTotal += 1;
    activeByProfile.set(task.profileId, profileActive + 1);
    void runTask(task).finally(() => {
      activeTotal = Math.max(0, activeTotal - 1);
      const left = (activeByProfile.get(task.profileId) ?? 1) - 1;
      if (left <= 0) {
        activeByProfile.delete(task.profileId);
      } else {
        activeByProfile.set(task.profileId, left);
      }
      maybeReleaseBatch(task.batchId);
      pump();
    });
  }
};

// ===== 工作区解析 =====

type WorkspaceContext = {
  profileId: string;
  sessionId: string;
  generation: number;
  workspacePath: string;
  workspaceRoot: string;
};

const resolveWorkspaceContext = async (
  workspaceId: string,
): Promise<WorkspaceContext> => {
  if (!workspaceLookup) {
    throw new SshTransferError(
      "SSH_TRANSFER_WORKSPACE_INVALID",
      "SSH transfer workspace lookup is not configured",
    );
  }
  const record = await workspaceLookup(workspaceId);
  if (!record || record.kind !== "ssh") {
    throw new SshTransferError(
      "SSH_TRANSFER_WORKSPACE_INVALID",
      "Workspace is not an SSH workspace",
    );
  }

  let profileId: string;
  try {
    profileId = getSshProfileId(parseSshUrl(record.path));
  } catch {
    throw new SshTransferError(
      "SSH_TRANSFER_WORKSPACE_INVALID",
      "SSH workspace URL is invalid",
    );
  }

  // 长任务必须持有连接租约并固定 session / generation；只对已连接档案生效。
  const retained = sshConnectionManager.retain(profileId);
  if (!retained || !retained.sessionId) {
    throw new SshTransferError(
      "SSH_TRANSFER_NOT_CONNECTED",
      "SSH connection is not available for this workspace",
    );
  }
  if (!getSshSession(retained.sessionId)) {
    sshConnectionManager.release(profileId);
    throw new SshTransferError(
      "SSH_TRANSFER_NOT_CONNECTED",
      "SSH connection is not available for this workspace",
    );
  }
  let workspaceRoot: string;
  try {
    workspaceRoot = resolveSshWorkspaceRoot(retained.sessionId, record.path);
  } catch (error) {
    sshConnectionManager.release(profileId);
    throw new SshTransferError(
      "SSH_TRANSFER_WORKSPACE_INVALID",
      error instanceof Error ? error.message : String(error),
    );
  }
  return {
    profileId,
    sessionId: retained.sessionId,
    generation: retained.generation,
    workspacePath: record.path,
    workspaceRoot,
  };
};

const releaseContext = (context: WorkspaceContext): void => {
  sshConnectionManager.release(context.profileId);
};

// ===== 批次创建 =====

const createTaskRecord = (params: {
  batchId: string;
  ownerWebContentsId: number;
  direction: SshTransferDirection;
  workspaceId: string;
  context: WorkspaceContext;
  remotePath: string;
  localPath: string;
  name: string;
}): TransferTask => {
  const task: TransferTask = {
    id: generateTransferId("ssh-task"),
    batchId: params.batchId,
    ownerWebContentsId: params.ownerWebContentsId,
    direction: params.direction,
    workspaceId: params.workspaceId,
    profileId: params.context.profileId,
    sessionId: params.context.sessionId,
    generation: params.context.generation,
    workspaceRoot: params.context.workspaceRoot,
    remotePath: params.remotePath,
    localPath: params.localPath,
    name: params.name,
    status: "queued",
    bytesTotal: null,
    bytesTransferred: 0,
    startedAt: Date.now(),
    endedAt: null,
    finalPath: null,
    error: null,
    conflict: null,
    conflictRounds: 0,
    abortController: new AbortController(),
    cancelRequested: false,
  };
  tasks.set(task.id, task);
  return task;
};

/** 上传批次：本地多个普通文件 → 远端目录。 */
export const createSshUploadBatch = async (params: {
  ownerWebContentsId: number;
  workspaceId: string;
  remoteDirectory: string;
  localPaths: string[];
}): Promise<SshTransferStartResult> => {
  const remoteDirectory = params.remoteDirectory.trim();
  if (!remoteDirectory) {
    throw new SshTransferError(
      "SSH_TRANSFER_PATH_INVALID",
      "Remote target directory is required",
    );
  }
  const localPaths = dedupeStrings(params.localPaths);
  if (localPaths.length === 0) {
    return { canceled: true, reason: "no-files" };
  }

  const context = await resolveWorkspaceContext(params.workspaceId);
  const normalizedDir = normalizeSshRemotePath(remoteDirectory);
  const batchId = generateTransferId("ssh-batch");
  const batch: TransferBatch = {
    id: batchId,
    ownerWebContentsId: params.ownerWebContentsId,
    workspaceId: params.workspaceId,
    profileId: context.profileId,
    tasks: [],
    applyPolicy: null,
    holdsConnection: true,
  };

  try {
    for (const localPathValue of localPaths) {
      const name = localBaseName(localPathValue);
      batch.tasks.push(
        createTaskRecord({
          batchId,
          ownerWebContentsId: params.ownerWebContentsId,
          direction: "upload",
          workspaceId: params.workspaceId,
          context,
          remotePath: joinRemote(normalizedDir, name),
          localPath: localPathValue,
          name,
        }),
      );
    }
  } catch (error) {
    releaseContext(context);
    throw error;
  }

  batches.set(batchId, batch);
  queued.push(...batch.tasks);
  emitImmediate(params.ownerWebContentsId);
  pump();
  return {
    canceled: false,
    batchId,
    taskIds: batch.tasks.map((task) => task.id),
  };
};

/** 下载批次：远端普通文件 → 本地目录（单个文件可直接指定最终文件名）。 */
export const createSshDownloadBatch = async (params: {
  ownerWebContentsId: number;
  workspaceId: string;
  files: Array<{ remotePath: string; name: string }>;
  targetDir: string;
  singleFileName?: string;
}): Promise<SshTransferStartResult> => {
  if (params.files.length === 0) {
    return { canceled: true, reason: "no-files" };
  }

  const context = await resolveWorkspaceContext(params.workspaceId);
  const batchId = generateTransferId("ssh-batch");
  const batch: TransferBatch = {
    id: batchId,
    ownerWebContentsId: params.ownerWebContentsId,
    workspaceId: params.workspaceId,
    profileId: context.profileId,
    tasks: [],
    applyPolicy: null,
    holdsConnection: true,
  };

  const usedNames = new Set<string>();
  const nameKey = (name: string): string =>
    process.platform === "win32" ? name.toLowerCase() : name;

  try {
    for (const file of params.files) {
      let fileName = params.singleFileName
        ? params.singleFileName
        : sanitizeLocalFileName(file.name);
      if (!params.singleFileName) {
        // 批内同名（不同来源目录的同名文件）自动加后缀，避免中途逐个弹冲突。
        let attempt = 0;
        while (
          usedNames.has(nameKey(fileName)) &&
          attempt < FREE_NAME_MAX_ATTEMPTS
        ) {
          fileName =
            attempt === 0
              ? suggestAlternativeName(fileName)
              : incrementAlternativeName(fileName);
          attempt += 1;
        }
      }
      usedNames.add(nameKey(fileName));
      const localPathValue = localPath.join(params.targetDir, fileName);
      batch.tasks.push(
        createTaskRecord({
          batchId,
          ownerWebContentsId: params.ownerWebContentsId,
          direction: "download",
          workspaceId: params.workspaceId,
          context,
          remotePath: file.remotePath,
          localPath: localPathValue,
          name: fileName,
        }),
      );
    }
  } catch (error) {
    releaseContext(context);
    throw error;
  }

  batches.set(batchId, batch);
  queued.push(...batch.tasks);
  emitImmediate(params.ownerWebContentsId);
  pump();
  return {
    canceled: false,
    batchId,
    taskIds: batch.tasks.map((task) => task.id),
  };
};

// ===== 来源分类（对话框确认前使用） =====

/** 分类本地来源：仅普通文件可上传；目录 / 缺失 / 特殊文件单独列出。 */
export const classifySshUploadSources = async (
  localPaths: string[],
): Promise<SshTransferLocalClassification> => {
  const files: string[] = [];
  const skipped: SshTransferLocalClassification["skipped"] = [];
  for (const value of dedupeStrings(localPaths)) {
    const stats = await lstatLocalMaybe(value);
    if (!stats) {
      skipped.push({ path: value, reason: "missing" });
      continue;
    }
    if (stats.isDirectory()) {
      skipped.push({ path: value, reason: "directory" });
      continue;
    }
    if (!stats.isFile()) {
      skipped.push({ path: value, reason: "not-file" });
      continue;
    }
    files.push(value);
  }
  return { files, skipped };
};

/** 分类远端来源：仅普通文件可下载；目录 / 缺失 / 链接与特殊文件单独列出。 */
export const classifySshDownloadSources = async (
  workspaceId: string,
  remotePaths: string[],
): Promise<SshTransferRemoteClassification> => {
  const context = await resolveWorkspaceContext(workspaceId);
  try {
    const files: SshTransferRemoteClassification["files"] = [];
    const skipped: SshTransferRemoteClassification["skipped"] = [];
    for (const remotePathValue of dedupeStrings(remotePaths)) {
      let stats;
      try {
        stats = await lstatSshEntry(context.sessionId, remotePathValue);
      } catch (error) {
        if (error instanceof SshTransferError) {
          throw error;
        }
        throw new SshTransferError(
          "SSH_TRANSFER_NOT_CONNECTED",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (!stats) {
        skipped.push({ path: remotePathValue, reason: "missing" });
        continue;
      }
      if (stats.isDirectory()) {
        skipped.push({ path: remotePathValue, reason: "directory" });
        continue;
      }
      if (stats.isSymbolicLink() || !stats.isFile()) {
        skipped.push({ path: remotePathValue, reason: "not-file" });
        continue;
      }
      files.push({
        remotePath: remotePathValue,
        name: remoteBaseName(remotePathValue),
        size: stats.size,
      });
    }
    return { files, skipped };
  } finally {
    releaseContext(context);
  }
};

// ===== 冲突解决与取消（IPC 入口） =====

export const resolveSshTransferConflict = (params: {
  ownerWebContentsId: number;
  taskId: string;
  action: SshTransferConflictAction;
  newName?: string;
  applyToBatch?: boolean;
}): void => {
  const task = tasks.get(params.taskId);
  if (!task) {
    throw new Error("Transfer task not found");
  }
  if (task.ownerWebContentsId !== params.ownerWebContentsId) {
    throw new Error("Transfer task belongs to another window");
  }
  const pending = task.conflict;
  if (!pending) {
    throw new Error("Transfer task has no pending conflict");
  }

  let decision: SshTransferConflictDecision;
  if (params.action === "replace") {
    decision = { action: "replace" };
  } else if (params.action === "skip") {
    decision = { action: "skip" };
  } else {
    const raw = (params.newName ?? "").trim();
    if (raw) {
      const validationError =
        task.direction === "upload"
          ? validateRemoteBaseName(raw)
          : validateLocalBaseName(raw);
      if (validationError) {
        throw new Error(`Invalid target name: ${validationError}`);
      }
      decision = { action: "rename", newName: raw };
    } else {
      decision = { action: "rename" };
    }
  }

  if (params.applyToBatch) {
    const batch = batches.get(task.batchId);
    if (batch) {
      batch.applyPolicy = params.action;
    }
  }
  task.conflict = null;
  pending.resolve(decision);
  setStatus(task, "preparing");
};

export const cancelSshTransfer = (params: {
  ownerWebContentsId: number;
  taskId?: string;
  batchId?: string;
}): void => {
  if (params.taskId) {
    const task = tasks.get(params.taskId);
    if (!task) {
      return;
    }
    if (task.ownerWebContentsId !== params.ownerWebContentsId) {
      throw new Error("Transfer task belongs to another window");
    }
    cancelTask(task);
    return;
  }
  if (params.batchId) {
    const batch = batches.get(params.batchId);
    if (!batch) {
      return;
    }
    if (batch.ownerWebContentsId !== params.ownerWebContentsId) {
      throw new Error("Transfer batch belongs to another window");
    }
    for (const task of batch.tasks) {
      cancelTask(task);
    }
  }
};

export const clearFinishedSshTransfers = (ownerWebContentsId: number): void => {
  for (const [id, task] of tasks) {
    if (
      task.ownerWebContentsId === ownerWebContentsId &&
      TERMINAL_STATUSES.has(task.status)
    ) {
      tasks.delete(id);
      const batch = batches.get(task.batchId);
      if (batch) {
        batch.tasks = batch.tasks.filter((entry) => entry.id !== id);
        if (batch.tasks.length === 0) {
          batches.delete(batch.id);
        }
      }
    }
  }
  emitImmediate(ownerWebContentsId);
};

// ===== 生命周期 =====

/** 窗口销毁时取消该窗口的排队 / 传输中任务；不删除已提交或结果未知的最终文件。 */
export const watchSshTransferOwner = (contents: WebContents): void => {
  if (watchedSenders.has(contents.id)) {
    return;
  }
  watchedSenders.add(contents.id);
  contents.once("destroyed", () => {
    watchedSenders.delete(contents.id);
    cancelAllForOwner(contents.id);
  });
};

/** 应用退出：尽力取消所有活动任务（不等待提交确认）。 */
export const shutdownSshTransfers = (): void => {
  for (const timer of emitTimers.values()) {
    clearTimeout(timer);
  }
  emitTimers.clear();
  for (const task of tasks.values()) {
    if (!TERMINAL_STATUSES.has(task.status)) {
      cancelTask(task);
    }
  }
};
