import {
  executeTerminalMcpCommand,
  waitForTerminalTab,
} from "./terminalMcpController";

/** PTY 就绪前的重试间隔与最大次数（约 3 秒） */
const READY_RETRY_INTERVAL_MS = 150;
const READY_MAX_ATTEMPTS = 20;

/**
 * 把一段命令写入指定终端 tab，由真实 shell 执行（输出与交互都留在终端里）。
 *
 * 新建的终端 tab 先挂载 xterm 再异步创建 PTY，两条链路存在时间差，
 * 因此 send 失败时按间隔重试直到 PTY 就绪。
 */
export const runCommandInTerminal = async (
  tabId: string,
  command: string,
): Promise<void> => {
  await waitForTerminalTab(tabId);
  const trimmed = command.replace(/[\r\n]+$/, "");
  const input = trimmed ? `${trimmed}\n` : "";
  const argsJson = JSON.stringify({ tabId, input });

  for (let attempt = 1; attempt <= READY_MAX_ATTEMPTS; attempt += 1) {
    try {
      await executeTerminalMcpCommand("send", argsJson);
      return;
    } catch (error) {
      if (attempt === READY_MAX_ATTEMPTS) {
        throw error;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, READY_RETRY_INTERVAL_MS);
      });
    }
  }
};
