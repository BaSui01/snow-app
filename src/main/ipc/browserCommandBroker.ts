import type { WebContents } from "electron";
import { randomUUID } from "node:crypto";
import type {
  BrowserCommand,
  BrowserCommandRequest,
  BrowserCommandResponse,
} from "../native/types";
import { safeSend } from "../utils/safeSend";

const BROWSER_COMMAND_CHANNEL = "browser:command";
const BROWSER_COMMAND_RESPONSE_CHANNEL = "browser:command-response";
const BROWSER_COMMAND_TIMEOUT_MS = 125_000;

const browserRenderers = new Map<number, WebContents>();
// instanceId -> 持有该实例的渲染进程。浏览器 tab「在新窗口中打开」后实例
// 随窗口迁移到新渲染进程，命令须按 instanceId 精确路由到持有者，避免广播
// 导致多窗口重复执行（如 navigate 被两次触发）。
const browserInstanceRenderers = new Map<string, WebContents>();
const pendingCommands = new Map<
  string,
  {
    resolve: (resultJson: string) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }
>();

const cleanupRendererInstances = (renderer: WebContents): void => {
  for (const [instanceId, owner] of browserInstanceRenderers) {
    if (owner === renderer) {
      browserInstanceRenderers.delete(instanceId);
    }
  }
};

const failPendingCommandsForRenderer = (rendererId: number): void => {
  for (const [commandId, pending] of pendingCommands) {
    if (!commandId.startsWith(`${rendererId}:`)) {
      continue;
    }
    clearTimeout(pending.timer);
    pending.reject(new Error("Browser renderer was destroyed"));
    pendingCommands.delete(commandId);
  }
};

export const registerBrowserRenderer = (webContents: WebContents): void => {
  const rendererId = webContents.id;
  browserRenderers.set(rendererId, webContents);
  webContents.once("destroyed", () => {
    browserRenderers.delete(rendererId);
    // 渲染进程销毁（窗口关闭/崩溃）时清理其上报的全部实例路由。
    cleanupRendererInstances(webContents);
    failPendingCommandsForRenderer(rendererId);
  });
};

export const unregisterBrowserRenderer = (webContents: WebContents): void => {
  browserRenderers.delete(webContents.id);
  cleanupRendererInstances(webContents);
  failPendingCommandsForRenderer(webContents.id);
};

/**
 * 记录浏览器实例与其宿主渲染进程的归属关系（渲染端 registerBrowserMcpInstance
 * 时上报）。实例在窗口间迁移（如独立窗口打开）时以最新上报为准。
 */
export const registerBrowserInstanceRenderer = (
  instanceId: string,
  webContents: WebContents
): void => {
  browserInstanceRenderers.set(instanceId, webContents);
};

/** 移除实例路由（仅当实例仍归属该渲染进程时删除，避免覆盖迁移后的新归属）。 */
export const unregisterBrowserInstanceRenderer = (
  instanceId: string,
  webContents: WebContents
): void => {
  if (browserInstanceRenderers.get(instanceId) === webContents) {
    browserInstanceRenderers.delete(instanceId);
  }
};

/**
 * 解析命令目标渲染进程：命令显式携带 instanceId 时按实例路由（实例可能
 * 已迁移到独立浏览器窗口）；否则回退到发起方渲染进程（原行为）。
 */
const resolveCommandRenderer = (
  source: WebContents,
  command: BrowserCommand
): WebContents | undefined => {
  let renderer = browserRenderers.get(source.id);
  try {
    const args = JSON.parse(command.argsJson) as { instanceId?: unknown };
    const requested =
      typeof args.instanceId === "string" ? args.instanceId.trim() : "";
    if (requested && requested.toLowerCase() !== "current") {
      const targeted = browserInstanceRenderers.get(requested);
      if (targeted && !targeted.isDestroyed()) {
        renderer = targeted;
      }
    }
  } catch {
    // argsJson 解析失败：回退到发起方渲染进程。
  }
  return renderer;
};

export const dispatchBrowserCommand = async (
  source: WebContents,
  command: BrowserCommand
): Promise<string> => {
  const renderer = resolveCommandRenderer(source, command);
  if (!renderer || renderer.isDestroyed()) {
    throw new Error("Browser renderer is not available");
  }

  const commandId = `${source.id}:${randomUUID()}`;
  const request: BrowserCommandRequest = {
    commandId,
    operation: command.operation,
    argsJson: command.argsJson,
  };

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(commandId);
      reject(new Error(`Browser command timed out: ${command.operation}`));
    }, BROWSER_COMMAND_TIMEOUT_MS);

    pendingCommands.set(commandId, { resolve, reject, timer });
    safeSend(renderer, BROWSER_COMMAND_CHANNEL, request);
  });
};

export const resolveBrowserCommand = (
  source: WebContents,
  response: BrowserCommandResponse
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
      new Error("Browser command response is missing result JSON")
    );
    return;
  }
  pending.resolve(response.resultJson);
};

export { BROWSER_COMMAND_CHANNEL, BROWSER_COMMAND_RESPONSE_CHANNEL };
