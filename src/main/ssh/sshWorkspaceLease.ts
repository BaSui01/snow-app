import {
  buildSshConnectParams,
  dispatchRemoteWorkspaceCommand,
  type RemoteWorkspaceCommand,
} from "./remoteWorkspaceCommand";
import { sshConnectionManager } from "./sshConnectionManager";
import { parseSshUrl } from "./sshManager";

export type SshWorkspaceLease = {
  profileId: string;
  release: () => void;
};

/**
 * 后台执行器显式持有工作区连接：走同一个 SshConnectionManager（状态对渲染层可见），
 * 运行期结束后必须 release()，空闲回收交回管理器。
 */
export const acquireSshWorkspaceLease = async (
  workspacePath: string,
): Promise<SshWorkspaceLease> => {
  const profile = await sshConnectionManager.acquire(
    buildSshConnectParams(workspacePath),
  );
  return {
    profileId: profile.profileId,
    release: () => {
      sshConnectionManager.release(profile.profileId);
    },
  };
};

/** 从后台命令参数提取需要租约的 SSH 工作区（同一 authority 只保留一个）。 */
const collectCommandWorkspacePaths = (argsJson: string): string[] => {
  let args: unknown;
  try {
    args = JSON.parse(argsJson);
  } catch {
    return [];
  }
  if (typeof args !== "object" || args === null) {
    return [];
  }
  const record = args as Record<string, unknown>;
  const candidates: unknown[] = [
    record.workspaceRoot,
    record.path,
    record.filePath,
  ];
  if (Array.isArray(record.paths)) {
    candidates.push(...record.paths);
  }

  const seen = new Set<string>();
  const paths: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const path = candidate.trim();
    if (!path.startsWith("ssh://")) continue;
    try {
      const parsed = parseSshUrl(path);
      const key = `${parsed.username}@${parsed.host}:${parsed.port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      paths.push(path);
    } catch {
      // 非法路径交给真正的命令处理去报错
    }
  }
  return paths;
};

/**
 * 后台远程命令通道（checkpoint / 仓库 Wiki）：命令执行期间显式持有工作区连接，
 * 结束后释放。工具调用通道仍要求工作区已连接，两者互不影响。
 */
export const dispatchBackgroundRemoteWorkspaceCommand = async (
  command: RemoteWorkspaceCommand,
): Promise<string> => {
  const workspacePaths = collectCommandWorkspacePaths(command.argsJson);
  if (workspacePaths.length === 0) {
    return dispatchRemoteWorkspaceCommand(command);
  }
  const leases: SshWorkspaceLease[] = [];
  for (const workspacePath of workspacePaths) {
    try {
      leases.push(await acquireSshWorkspaceLease(workspacePath));
    } catch {
      // 建连失败时命令本身会以 SSH_WORKSPACE_NOT_CONNECTED 返回
    }
  }
  try {
    return await dispatchRemoteWorkspaceCommand(command);
  } finally {
    for (const lease of leases) {
      lease.release();
    }
  }
};
