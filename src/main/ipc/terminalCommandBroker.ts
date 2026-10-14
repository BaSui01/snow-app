import type { WebContents } from "electron";
import { randomUUID } from "node:crypto";
import type {
  TerminalCommand,
  TerminalCommandRequest,
  TerminalCommandResponse,
} from "../native/types";
import { safeSend } from "../utils/safeSend";

const TERMINAL_COMMAND_CHANNEL = "terminal:command";
const TERMINAL_COMMAND_RESPONSE_CHANNEL = "terminal:command-response";
const TERMINAL_COMMAND_TIMEOUT_MS = 125_000;

const terminalRenderers = new Map<number, WebContents>();
/**
 * tabId -> 持有该终端 tab 的渲染进程。终端 tab「在新窗口中打开」后归属迁移到
 * 独立面板窗口，MCP 终端命令须按 tabId 精确路由到持有者（与浏览器实例路由一致），
 * 避免命令只落到主窗口而找不到该 tab。
 */
const terminalTabRenderers = new Map<string, WebContents>();
const observedTabRenderers = new WeakSet<WebContents>();
const pendingCommands = new Map<
  string,
  {
    resolve: (resultJson: string) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }
>();

const cleanupTabRenderers = (renderer: WebContents): void => {
  for (const [tabId, owner] of terminalTabRenderers) {
    if (owner === renderer) {
      terminalTabRenderers.delete(tabId);
    }
  }
};

const failPendingCommandsForRenderer = (rendererId: number): void => {
  for (const [commandId, pending] of pendingCommands) {
    if (!commandId.startsWith(`${rendererId}:`)) {
      continue;
    }
    clearTimeout(pending.timer);
    pending.reject(new Error("Terminal renderer was destroyed"));
    pendingCommands.delete(commandId);
  }
};

export const registerTerminalRenderer = (webContents: WebContents): void => {
  const rendererId = webContents.id;
  terminalRenderers.set(rendererId, webContents);
  webContents.once("destroyed", () => {
    terminalRenderers.delete(rendererId);
    failPendingCommandsForRenderer(rendererId);
  });
};

export const unregisterTerminalRenderer = (webContents: WebContents): void => {
  terminalRenderers.delete(webContents.id);
  failPendingCommandsForRenderer(webContents.id);
};

/** 渲染端终端 tab 挂载时上报归属（独立面板窗口中的 tab 也走同一条路径）。 */
export const registerTerminalTabRenderer = (
  tabId: string,
  webContents: WebContents,
): void => {
  terminalTabRenderers.set(tabId, webContents);
  if (!observedTabRenderers.has(webContents)) {
    observedTabRenderers.add(webContents);
    webContents.once("destroyed", () => cleanupTabRenderers(webContents));
  }
};

/** 移除 tab 归属（仅当归属仍是该渲染进程时删除，避免覆盖迁移后的新归属）。 */
export const unregisterTerminalTabRenderer = (
  tabId: string,
  webContents: WebContents,
): void => {
  if (terminalTabRenderers.get(tabId) === webContents) {
    terminalTabRenderers.delete(tabId);
  }
};

/** 解析命令显式指定的 tabId（current / 缺省返回空串，走发起方回退）。 */
const readRequestedTabId = (argsJson: string): string => {
  try {
    const args = JSON.parse(argsJson) as { tabId?: unknown };
    const requested = typeof args.tabId === "string" ? args.tabId.trim() : "";
    return requested && requested.toLowerCase() !== "current" ? requested : "";
  } catch {
    return "";
  }
};

export const dispatchTerminalCommand = async (
  source: WebContents,
  command: TerminalCommand,
): Promise<string> => {
  const owner = terminalTabRenderers.get(readRequestedTabId(command.argsJson));
  const renderer =
    owner && !owner.isDestroyed() ? owner : terminalRenderers.get(source.id);
  if (!renderer || renderer.isDestroyed()) {
    throw new Error("Terminal renderer is not available");
  }

  // 命令 ID 前缀取目标渲染进程（响应方），与 resolveTerminalCommand 的校验一致；
  // tab 已迁移到独立窗口时目标不再是发起方。
  const commandId = `${renderer.id}:${randomUUID()}`;
  const request: TerminalCommandRequest = {
    commandId,
    operation: command.operation,
    argsJson: command.argsJson,
  };

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(commandId);
      reject(new Error(`Terminal command timed out: ${command.operation}`));
    }, TERMINAL_COMMAND_TIMEOUT_MS);

    pendingCommands.set(commandId, { resolve, reject, timer });
    safeSend(renderer, TERMINAL_COMMAND_CHANNEL, request);
  });
};

export const resolveTerminalCommand = (
  source: WebContents,
  response: TerminalCommandResponse,
): void => {
  const expectedPrefix = `${source.id}:`;
  if (!response.commandId.startsWith(expectedPrefix)) {
    return;
  }

  const pending = pendingCommands.get(response.commandId);
  if (!pending) {
    return;
  }

  clearTimeout(pending.timer);
  pendingCommands.delete(response.commandId);
  if (response.error) {
    pending.reject(new Error(response.error));
    return;
  }
  if (typeof response.resultJson !== "string") {
    pending.reject(
      new Error("Terminal command response is missing result JSON"),
    );
    return;
  }
  pending.resolve(response.resultJson);
};

export { TERMINAL_COMMAND_CHANNEL, TERMINAL_COMMAND_RESPONSE_CHANNEL };
