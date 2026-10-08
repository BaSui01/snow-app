import type { NativeBridge } from "../native/types";
import { snowLog } from "../../utils/snowLogger";

// 系统日志自动清理：启动时立即执行一次，之后每 6 小时复查一次，
// 让长时间不重启的应用也不会让日志无限增长。
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

const pruneExpiredAppLogs = async (native: NativeBridge): Promise<void> => {
  try {
    const deleted = await native.pruneAppLogs();
    if (deleted > 0) {
      snowLog.info({
        module: "app/storage",
        func: "pruneExpiredAppLogs",
        message: "Pruned expired system logs",
        context: `deleted=${deleted}`,
      });
    }
  } catch (error) {
    snowLog.warn({
      module: "app/storage",
      func: "pruneExpiredAppLogs",
      message: "Failed to prune expired system logs",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export const startAppLogRetention = (native: NativeBridge): void => {
  void pruneExpiredAppLogs(native);
  const timer = setInterval(
    () => void pruneExpiredAppLogs(native),
    PRUNE_INTERVAL_MS,
  );
  timer.unref();
};
