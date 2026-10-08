import type {
  ToolAuthorizationDecision,
  ToolCallInfo,
} from "../utils/conversationTypes";
import type { GitFileStatus, GitStatusResult } from "../../../../../preload";

/**
 * 具有工作区变动/写副作用的显式工具集合。
 * 覆盖文件写入、终端执行、交互式终端、子代理派发、LSP 重命名与工作流等。
 */
export const WORKSPACE_MUTATING_TOOL_NAMES = new Set([
  "filesystem-create",
  "filesystem-replace_edit",
  "filesystem-copy",
  "bash-terminal-execute",
  "terminal-send",
  "terminal-open",
  "sub-agents-activate",
  "sub-agents-continue",
  "lsp-rename",
  "workflow-generate",
  "workflow-resume",
  "skills-skill-execute",
]);

const SESSION_BOOKKEEPING_TOOL_PREFIXES = [
  "todo-todo-manage",
  "config-",
  "user-interaction-",
  "memory-",
];

const isSessionOrConfigTool = (toolName: string): boolean =>
  SESSION_BOOKKEEPING_TOOL_PREFIXES.some(
    (prefix) => toolName === prefix || toolName.startsWith(prefix),
  );

/**
 * 判断某个工具调用是否可能对工作区造成状态变更。
 * 显式写工具、外部未知非只读工具、终端与子代理等均保守视为变动源。
 */
export const mayMutateWorkspace = (
  toolCall: ToolCallInfo,
  readonlyToolNames?: Set<string>,
): boolean => {
  if (WORKSPACE_MUTATING_TOOL_NAMES.has(toolCall.name)) {
    return true;
  }
  if (readonlyToolNames && !readonlyToolNames.has(toolCall.name)) {
    if (!isSessionOrConfigTool(toolCall.name)) {
      return true;
    }
  }
  return false;
};

export const normalizeWorkspacePath = (
  filePath: string,
  workspacePath?: string,
): string => {
  const normalizedPath =
    filePath.replace(/\\/g, "/").replace(/\/+$/, "") || ".";
  const normalizedWorkspace = workspacePath
    ?.replace(/\\/g, "/")
    .replace(/\/+$/, "");
  if (!normalizedWorkspace) {
    return normalizedPath;
  }

  const isWindowsPath = /^[a-z]:\//i.test(normalizedWorkspace);
  const comparablePath = isWindowsPath
    ? normalizedPath.toLowerCase()
    : normalizedPath;
  const comparableWorkspace = isWindowsPath
    ? normalizedWorkspace.toLowerCase()
    : normalizedWorkspace;
  if (normalizedPath === ".") {
    return "<workspace>";
  }
  if (normalizedPath.startsWith("./")) {
    return `<workspace>/${normalizedPath.slice(2)}`;
  }
  if (comparablePath === comparableWorkspace) {
    return "<workspace>";
  }
  if (comparablePath.startsWith(`${comparableWorkspace}/`)) {
    return `<workspace>/${normalizedPath.slice(normalizedWorkspace.length + 1)}`;
  }
  return normalizedPath;
};

export const resolveToAbsolutePath = (
  filePath: string,
  workspacePath?: string,
): string => {
  if (!filePath) return "";
  const normalized = filePath.replace(/\\/g, "/");
  if (/^(?:[a-zA-Z]:\/|\/)/.test(normalized)) {
    return normalized;
  }
  if (!workspacePath) return normalized;
  const normalizedWorkspace = workspacePath
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  const rel = normalized.replace(/^\.\//, "");
  return `${normalizedWorkspace}/${rel}`;
};

export const canonicalizeToolArguments = (
  argumentsJson: string,
  toolName?: string,
  workspacePath?: string,
): string | null => {
  try {
    const sortJson = (value: unknown): unknown => {
      if (Array.isArray(value)) {
        return value.map(sortJson);
      }
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => [key, sortJson(child)]),
        );
      }
      return value;
    };
    const parsed = JSON.parse(argumentsJson || "{}") as Record<string, unknown>;
    if (toolName === "filesystem-read" && typeof parsed.filePath === "string") {
      parsed.filePath = normalizeWorkspacePath(parsed.filePath, workspacePath);
    }
    return JSON.stringify(sortJson(parsed));
  } catch {
    return null;
  }
};

export const isFailedToolResult = (result: string): boolean => {
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    return parsed.success === false || typeof parsed.error === "string";
  } catch {
    return false;
  }
};

interface FileSnapshot {
  exists: boolean;
  size: number;
  contentLength: number;
  preview: string;
}

interface GitSnapshot {
  repoPath: string;
  branch: string;
  ahead: number;
  behind: number;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
  fileDigest: string;
  specificFileStatus?: string;
}

interface CallSnapshot {
  toolName: string;
  callKey: string;
  targetPath?: string;
  fileSnapshot?: FileSnapshot | null;
  gitSnapshot?: GitSnapshot | null;
  recordedAt: number;
}

export interface ReadonlyCallFilterResult {
  executableToolCalls: ToolCallInfo[];
  duplicateReadonlyResults: Map<ToolCallInfo, string>;
}

export interface ReadonlyCallGuardOptions {
  workspacePath?: string;
}

export class ReadonlyCallGuard {
  private workspacePath?: string;
  private completedCalls = new Map<string, CallSnapshot>();
  private duplicateRecoveryAttempted = false;

  constructor(options: ReadonlyCallGuardOptions = {}) {
    this.workspacePath = options.workspacePath;
  }

  public getDuplicateRecoveryAttempted(): boolean {
    return this.duplicateRecoveryAttempted;
  }

  public setDuplicateRecoveryAttempted(attempted: boolean): void {
    this.duplicateRecoveryAttempted = attempted;
  }

  public getReadonlyCallKey(toolCall: ToolCallInfo): string | null {
    const argumentsJson = canonicalizeToolArguments(
      toolCall.arguments,
      toolCall.name,
      this.workspacePath,
    );
    return argumentsJson === null ? null : `${toolCall.name}:${argumentsJson}`;
  }

  public isReadonlyCall(
    toolCall: ToolCallInfo,
    readonlyToolNames: Set<string>,
  ): boolean {
    if (!readonlyToolNames.has(toolCall.name)) {
      return false;
    }
    if (toolCall.name !== "todo-todo-manage") {
      return true;
    }
    try {
      return (
        (JSON.parse(toolCall.arguments || "{}") as { action?: unknown })
          .action === "get"
      );
    } catch {
      return false;
    }
  }

  /**
   * 过滤工具调用：不仅基于参数匹配，更主动检测目标文件及 Git 仓库真实状态。
   * 若物理状态或 Git 状态已发生变更，则允许重新读取。
   */
  public async filterToolCalls(
    toolCalls: ToolCallInfo[],
    readonlyToolNames: Set<string>,
  ): Promise<ReadonlyCallFilterResult> {
    const duplicateReadonlyResults = new Map<ToolCallInfo, string>();
    const executableToolCalls: ToolCallInfo[] = [];

    for (const toolCall of toolCalls) {
      const key = this.getReadonlyCallKey(toolCall);
      if (
        key === null ||
        !this.isReadonlyCall(toolCall, readonlyToolNames) ||
        !this.completedCalls.has(key)
      ) {
        executableToolCalls.push(toolCall);
        continue;
      }

      const priorSnapshot = this.completedCalls.get(key)!;
      const isMutated = await this.checkIfTargetMutated(
        toolCall,
        priorSnapshot,
      );

      if (isMutated) {
        // 目标文件或 Git 仓库已发生真实物理变更，放行本次调用并移除陈旧快照
        this.completedCalls.delete(key);
        executableToolCalls.push(toolCall);
        continue;
      }

      // 目标确实分毫不差、无任何状态或版本变动
      const result = JSON.stringify({
        success: false,
        error: "DUPLICATE_READONLY_TOOL_CALL",
        message:
          "This read-only tool call already completed with identical arguments during this agent run, and no file or Git changes were detected since. Use the prior tool result and finish the task without repeating the call.",
        toolName: toolCall.name,
      });
      duplicateReadonlyResults.set(toolCall, result);
    }

    return { executableToolCalls, duplicateReadonlyResults };
  }

  /**
   * 记录执行成功的工具调用与状态变更
   */
  public async recordToolExecutions(
    executableToolCalls: ToolCallInfo[],
    authorizationDecisions: ToolAuthorizationDecision[],
    executedToolResults: Array<{ result: string } | undefined>,
    readonlyToolNames: Set<string>,
  ): Promise<void> {
    for (let index = 0; index < executableToolCalls.length; index++) {
      const toolCall = executableToolCalls[index];
      const decision = authorizationDecisions[index];
      const result = executedToolResults[index]?.result;

      if (decision?.status !== "approved") {
        continue;
      }

      // 如果执行了可能修改工作区的工具，清空工作区文件与检索类只读缓存
      if (mayMutateWorkspace(toolCall, readonlyToolNames)) {
        this.clearWorkspaceCaches();
        continue;
      }

      // 会话级细粒度失效：todo 更新仅失效 todo-get 缓存
      if (toolCall.name === "todo-todo-manage") {
        this.clearPrefixCaches("todo-todo-manage:");
        continue;
      }
      if (
        toolCall.name.startsWith("memory-") &&
        toolCall.name !== "memory-search" &&
        toolCall.name !== "memory-list"
      ) {
        this.clearPrefixCaches("memory-");
        continue;
      }
      if (
        toolCall.name.startsWith("config-") &&
        toolCall.name !== "config-get" &&
        toolCall.name !== "config-list"
      ) {
        this.clearPrefixCaches("config-");
        continue;
      }

      const key = this.getReadonlyCallKey(toolCall);
      if (key && result && !isFailedToolResult(result)) {
        const snapshot = await this.captureSnapshot(toolCall, key);
        this.completedCalls.set(key, snapshot);
      }
    }
  }

  public clearAll(): void {
    this.completedCalls.clear();
    this.duplicateRecoveryAttempted = false;
  }

  private clearWorkspaceCaches(): void {
    for (const [key, snapshot] of this.completedCalls.entries()) {
      if (
        snapshot.toolName === "filesystem-read" ||
        snapshot.toolName === "grep-search" ||
        snapshot.toolName === "codebase-search" ||
        snapshot.toolName.startsWith("codelens-")
      ) {
        this.completedCalls.delete(key);
      }
    }
  }

  private clearPrefixCaches(prefix: string): void {
    for (const key of this.completedCalls.keys()) {
      if (key.startsWith(prefix)) {
        this.completedCalls.delete(key);
      }
    }
  }

  /**
   * 物理及 Git 变更检测核心
   */
  private async checkIfTargetMutated(
    toolCall: ToolCallInfo,
    prior: CallSnapshot,
  ): Promise<boolean> {
    try {
      if (toolCall.name === "filesystem-read") {
        const parsed = JSON.parse(toolCall.arguments || "{}") as {
          filePath?: string;
        };
        const rawPath =
          typeof parsed.filePath === "string" ? parsed.filePath : "";
        const absPath = resolveToAbsolutePath(rawPath, this.workspacePath);
        if (!absPath) return true;

        // 1. 文件系统内容与尺寸检测
        const currentFile = await this.captureFileSnapshot(absPath);
        if (!prior.fileSnapshot && currentFile) return true;
        if (prior.fileSnapshot && !currentFile) return true;
        if (prior.fileSnapshot && currentFile) {
          if (
            prior.fileSnapshot.exists !== currentFile.exists ||
            prior.fileSnapshot.size !== currentFile.size ||
            prior.fileSnapshot.contentLength !== currentFile.contentLength ||
            prior.fileSnapshot.preview !== currentFile.preview
          ) {
            return true;
          }
        }

        // 2. 目标文件所属 Git 仓库状态检测
        const repoPath =
          prior.gitSnapshot?.repoPath ||
          (await window.snow?.teamResolveRepo(absPath).catch(() => "")) ||
          this.workspacePath;
        if (repoPath) {
          const currentGit = await this.captureGitSnapshot(repoPath, absPath);
          if (this.isGitMutated(prior.gitSnapshot, currentGit)) {
            return true;
          }
        }

        return false;
      }

      if (
        toolCall.name === "grep-search" ||
        toolCall.name === "codebase-search" ||
        toolCall.name.startsWith("codelens-")
      ) {
        const repoPath =
          prior.gitSnapshot?.repoPath ||
          (prior.targetPath
            ? await window.snow
                ?.teamResolveRepo(prior.targetPath)
                .catch(() => "")
            : "") ||
          this.workspacePath;
        if (repoPath) {
          const currentGit = await this.captureGitSnapshot(repoPath);
          if (this.isGitMutated(prior.gitSnapshot, currentGit)) {
            return true;
          }
        }
        return false;
      }

      return false;
    } catch {
      // 若检测过程中发生任何未知异常，安全回退为已变更，避免误杀正常执行
      return true;
    }
  }

  private isGitMutated(
    prior: GitSnapshot | null | undefined,
    current: GitSnapshot | null | undefined,
  ): boolean {
    if (!prior || !current) return false;
    if (prior.branch !== current.branch) return true;
    if (prior.ahead !== current.ahead || prior.behind !== current.behind)
      return true;
    if (
      prior.stagedCount !== current.stagedCount ||
      prior.unstagedCount !== current.unstagedCount ||
      prior.untrackedCount !== current.untrackedCount
    ) {
      return true;
    }
    if (prior.fileDigest !== current.fileDigest) return true;
    if (prior.specificFileStatus !== current.specificFileStatus) return true;
    return false;
  }

  private async captureSnapshot(
    toolCall: ToolCallInfo,
    callKey: string,
  ): Promise<CallSnapshot> {
    const snapshot: CallSnapshot = {
      toolName: toolCall.name,
      callKey,
      recordedAt: Date.now(),
    };

    try {
      if (toolCall.name === "filesystem-read") {
        const parsed = JSON.parse(toolCall.arguments || "{}") as {
          filePath?: string;
        };
        const rawPath =
          typeof parsed.filePath === "string" ? parsed.filePath : "";
        const absPath = resolveToAbsolutePath(rawPath, this.workspacePath);
        snapshot.targetPath = absPath;
        if (absPath) {
          snapshot.fileSnapshot = await this.captureFileSnapshot(absPath);
          const repoPath =
            (await window.snow?.teamResolveRepo(absPath).catch(() => "")) ||
            this.workspacePath;
          if (repoPath) {
            snapshot.gitSnapshot = await this.captureGitSnapshot(
              repoPath,
              absPath,
            );
          }
        }
      } else if (
        toolCall.name === "grep-search" ||
        toolCall.name === "codebase-search" ||
        toolCall.name.startsWith("codelens-")
      ) {
        const repoPath = this.workspacePath;
        snapshot.targetPath = repoPath;
        if (repoPath) {
          snapshot.gitSnapshot = await this.captureGitSnapshot(repoPath);
        }
      }
    } catch {
      // 快照捕获失败时不阻断主流程
    }

    return snapshot;
  }

  private async captureFileSnapshot(
    absPath: string,
  ): Promise<FileSnapshot | null> {
    try {
      const result = await window.snow?.readFileContent(absPath);
      if (!result) {
        return { exists: false, size: 0, contentLength: 0, preview: "" };
      }
      return {
        exists: true,
        size: result.size ?? 0,
        contentLength: result.content?.length ?? 0,
        preview: (result.content || "").slice(0, 128),
      };
    } catch {
      return { exists: false, size: 0, contentLength: 0, preview: "" };
    }
  }

  private async captureGitSnapshot(
    repoPath: string,
    specificFilePath?: string,
  ): Promise<GitSnapshot | null> {
    try {
      const status: GitStatusResult = await window.snow?.gitStatus(repoPath);
      if (!status || !status.isRepo) {
        return null;
      }

      let specificFileStatus: string | undefined;
      if (specificFilePath) {
        const normalizedTarget = specificFilePath
          .replace(/\\/g, "/")
          .toLowerCase();
        const normalizedRepo = repoPath
          .replace(/\\/g, "/")
          .toLowerCase()
          .replace(/\/+$/, "");
        const relPath = normalizedTarget.startsWith(`${normalizedRepo}/`)
          ? normalizedTarget.slice(normalizedRepo.length + 1)
          : normalizedTarget;

        const matched = status.files?.find((f: GitFileStatus) => {
          const p = (f.path || "").replace(/\\/g, "/").toLowerCase();
          return p === relPath || normalizedTarget.endsWith(`/${p}`);
        });
        specificFileStatus = matched
          ? `${matched.status}:${matched.workdirStatus}`
          : "clean";
      }

      const fileDigest = (status.files || [])
        .map((f: GitFileStatus) => `${f.path}:${f.status}:${f.workdirStatus}`)
        .sort()
        .join(";");

      return {
        repoPath,
        branch: status.currentBranch || "",
        ahead: status.ahead || 0,
        behind: status.behind || 0,
        stagedCount: status.stagedCount || 0,
        unstagedCount: status.unstagedCount || 0,
        untrackedCount: status.untrackedCount || 0,
        fileDigest,
        specificFileStatus,
      };
    } catch {
      return null;
    }
  }
}
