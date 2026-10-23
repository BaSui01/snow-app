/** 工具调用看门狗：后端迟迟不返回时放弃等待，让主循环继续。 */

const DEFAULT_BASH_TIMEOUT_MS = 30_000;
/** 后端 bash 自身超时应先返回，这里只兜底后端完全无响应的情况。 */
const BASH_WATCHDOG_GRACE_MS = 30_000;
/** 文件 / 检索类工具正常应在秒级完成，超过即视为挂起。 */
const LOCAL_TOOL_WATCHDOG_MS = 120_000;

export class ToolWatchdogTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(
      `Tool execution exceeded ${timeoutMs}ms and was abandoned; the underlying operation may still be running.`,
    );
    this.name = "ToolWatchdogTimeoutError";
  }
}

/**
 * 返回工具的看门狗时长（毫秒）；undefined 表示不设看门狗。
 * 交互式工具（等待用户）、工作流 / 子代理 / 生图 / 浏览器等长任务不设，
 * 外部 MCP 由后端 timeoutMs 统一约束。
 */
export const resolveToolWatchdogMs = (
  toolName: string,
  argsJson: string,
): number | undefined => {
  if (toolName === "bash-terminal-execute") {
    let args: { timeout?: unknown; isInteractive?: unknown } = {};
    try {
      args = JSON.parse(argsJson) as typeof args;
    } catch {
      // 参数非 JSON：按默认超时处理
    }
    if (args.isInteractive === true) {
      return undefined;
    }
    const timeoutMs =
      typeof args.timeout === "number" && args.timeout > 0
        ? args.timeout
        : DEFAULT_BASH_TIMEOUT_MS;
    return timeoutMs + BASH_WATCHDOG_GRACE_MS;
  }
  if (toolName === "grep-search" || toolName.startsWith("filesystem-")) {
    return LOCAL_TOOL_WATCHDOG_MS;
  }
  return undefined;
};

/** 超时即以 ToolWatchdogTimeoutError 拒绝；原 promise 之后的结果被忽略。 */
export const withToolWatchdog = <T>(
  promise: Promise<T>,
  timeoutMs: number | undefined,
): Promise<T> => {
  if (timeoutMs === undefined) {
    return promise;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ToolWatchdogTimeoutError(timeoutMs)),
      timeoutMs,
    );
  });
  // 被放弃的调用之后若 reject，不能成为未处理的 rejection。
  promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};
