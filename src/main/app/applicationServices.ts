import type { AppStorageInfo, NativeBridge } from "../native/types";
import { markStorageReady, markStorageFailed } from "./storageReady";
import { snowLog } from "../../utils/snowLogger";
import { broadcastWorkspaceDirectoryListChanged } from "../utils/workspaceDirectoryBroadcast";

const ensureDefaultWorkspaceDirectory = async (
  native: NativeBridge,
): Promise<void> => {
  const directories = await native.listWorkspaceDirectories();

  if (directories.length === 0) {
    return;
  }

  if (!directories.some((directory) => directory.isActive)) {
    await native.activateWorkspaceDirectory(directories[0].directoryId);
    // 主进程内部激活（非 IPC 处理器）同样要广播，否则界面会停留在
    // 「没有激活项目」的中间态。
    broadcastWorkspaceDirectoryListChanged();
  }
};

export const initializeApplicationServices = async (
  native: NativeBridge,
): Promise<AppStorageInfo> => {
  try {
    const storageInfo = await native.initializeAppStorage();
    // 数据库已可用：立即解除门控。渲染进程的首次数据请求（项目列表、
    // 会话列表等）从此各自返回，不再被后续启动整理动作拖到同一时刻
    // 一起完成；与数据库无关的 git / 文件请求更是不受门控影响。
    markStorageReady();

    console.info("Snow App storage initialized:", storageInfo.databasePath);
    snowLog.info({
      module: "app/storage",
      func: "initializeApplicationServices",
      message: "Application storage initialized",
      context: storageInfo.databasePath,
    });

    // 以下为启动整理，与界面首次读取无关，放在门控之后执行。
    // 升级后整理旧版检查点布局（扁平目录/对象 → 日期分片/哈希分桶）。
    // 幂等且只做同盘 rename，失败不阻塞启动。
    try {
      const movedCheckpointEntries = await native.migrateCheckpointLayout();
      if (movedCheckpointEntries > 0) {
        console.info(
          `Migrated ${movedCheckpointEntries} legacy checkpoint entries`,
        );
        snowLog.info({
          module: "app/storage",
          func: "initializeApplicationServices",
          message: "Migrated legacy checkpoint layout",
          context: `moved=${movedCheckpointEntries}`,
        });
      }
    } catch (error) {
      snowLog.warn({
        module: "app/storage",
        func: "initializeApplicationServices",
        message: "Failed to migrate legacy checkpoint layout",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const cancelledSubAgentCount = await native.cancelRunningSubAgentSessions();
    await ensureDefaultWorkspaceDirectory(native);
    // 每次启动强制关闭请求日志，避免用户忘记手动关闭导致大量日志写入损伤硬盘。
    await native.setRequestLogging(false);
    await native.setRequestLoggingExpiry(0);
    if (cancelledSubAgentCount > 0) {
      console.info(
        `Cancelled ${cancelledSubAgentCount} interrupted sub-agent session(s)`,
      );
      snowLog.warn({
        module: "app/storage",
        func: "initializeApplicationServices",
        message: "Cancelled interrupted sub-agent sessions from previous run",
        context: `count=${cancelledSubAgentCount}`,
      });
    }
    return storageInfo;
  } catch (error) {
    snowLog.error({
      module: "app/storage",
      func: "initializeApplicationServices",
      message: "Application storage initialization failed",
      error: error instanceof Error ? error.message : String(error),
    });
    markStorageFailed(error);
    throw error;
  }
};
