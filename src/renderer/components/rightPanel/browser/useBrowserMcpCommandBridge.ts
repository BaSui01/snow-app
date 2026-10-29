import { useEffect, useRef } from "react";
import type { BrowserCommandRequest } from "../../../../preload";
import { rightPanelEvents } from "../rightPanelEvents";
import {
  createBrowserInstanceId,
  executeBrowserMcpCommand,
  getAgentBrowserInstanceId,
  isOfflineBrowserHeapOperation,
  parseBrowserMcpCommandArgs,
  resolveBrowserMcpTargetInstanceId,
  selectAgentBrowserInstance,
  waitForBrowserMcpInstance,
} from "./browserMcpController";
import {
  ensureBrowserAgentAccess,
  ensureBrowserAgentCreationAllowed,
  ensureBrowserAgentEnabled,
  getBrowserAgentAccess,
  requestBrowserAgentShare,
  type BrowserAgentAccess,
} from "./browserAgentAccess";
import {
  getBrowserAgentSettings,
  isBrowserAgentUrlAllowed,
  resolveBrowserAgentHost,
} from "./browserAgentSettings";
import { tGlobal } from "../../../i18n";

/** 等待右侧面板展开的兜底超时（毫秒），避免命令被永远挂起。 */
const EXPAND_WAIT_TIMEOUT_MS = 3_000;
/** 单帧等待上限：隐藏窗口会暂停 rAF，轮询不能因此卡死。 */
const EXPAND_FRAME_WAIT_MS = 60;

const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    let settled = false;
    let timer = 0;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve();
    };
    timer = window.setTimeout(finish, EXPAND_FRAME_WAIT_MS);
    window.requestAnimationFrame(finish);
  });

export type BrowserTabInfo = {
  instanceId: string;
  title: string;
  url: string;
  isActive: boolean;
  shared: boolean;
  isolated: boolean;
  origin: "user" | "agent";
};

export type BrowserMcpTabCallbacks = {
  openTab: (
    url?: string,
    instanceId?: string,
    access?: BrowserAgentAccess,
  ) => string;
  closeTab: (instanceId: string) => boolean;
  focusTab: (instanceId: string) => boolean;
  listTabs: () => BrowserTabInfo[];
};

const readStringArg = (
  args: Record<string, unknown>,
  field: string,
): string | undefined => {
  const value = args[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

export const useBrowserMcpCommandBridge = (
  callbacks: BrowserMcpTabCallbacks,
  isCollapsed: boolean,
): void => {
  // 通过 ref 持有最新的 callbacks，避免 effect 因 callbacks 引用变化
  // 而反复执行 cleanup/setup。cleanup 会触发 browser:renderer-unregister，
  // 导致主进程立即 reject 所有正在等待的浏览器命令（例如 create 正在
  // 等待 waitForBrowserMcpInstance 时被中断）。
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;
  // isCollapsed 同因：ref 镜像避免命令 handler（只绑定一次）闭包过期。
  const isCollapsedRef = useRef(isCollapsed);
  isCollapsedRef.current = isCollapsed;

  // 面板折叠时 webview 不可见（.right-panel.collapsed 宽度为 0），
  // capturePage 只能返回空白 PNG，screenshot 等依赖渲染结果的操作
  // 必然失败。命令执行前若面板处于折叠状态，先请求展开（App 侧
  // request-expand 监听负责 setState），再轮询等待面板真正展开：
  // collapsed class 移除（React 完成重渲染）且宽度过渡动画结束
  // （> 0），保证 webview 已可见后才继续执行命令。
  const ensurePanelExpanded = async (): Promise<void> => {
    if (!isCollapsedRef.current) {
      return;
    }
    rightPanelEvents.emit("request-expand");
    const deadline = Date.now() + EXPAND_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const panel = document.querySelector(".right-panel");
      if (
        panel &&
        !panel.classList.contains("collapsed") &&
        panel.getBoundingClientRect().width > 10
      ) {
        return;
      }
      await nextFrame();
    }
  };

  useEffect(() => {
    return window.snow.registerBrowserCommandHandler(
      async (request: BrowserCommandRequest): Promise<string> => {
        const args = parseBrowserMcpCommandArgs(request.argsJson);

        // 文件分析没有页面目标：保留浏览器代理开关与主进程路径校验，
        // 不解析/聚焦实例，也不为离线分析展开或创建业务标签。
        if (isOfflineBrowserHeapOperation(request.operation)) {
          ensureBrowserAgentEnabled();
          return executeBrowserMcpCommand(request.operation, request.argsJson);
        }

        switch (request.operation) {
          case "create": {
            const url = readStringArg(args, "url");
            ensureBrowserAgentCreationAllowed(url);
            await ensurePanelExpanded();
            const instanceId = createBrowserInstanceId();
            const settings = getBrowserAgentSettings();
            callbacksRef.current.openTab(url, instanceId, {
              shared: true,
              isolated: settings.isolation,
              origin: "agent",
              url: url ?? "",
            });
            await waitForBrowserMcpInstance(instanceId);
            // 新建的标签成为 Agent 工作标签：之后省略 instanceId 的命令
            // 都指向它，用户切换标签不会改变目标（issue #253）。
            selectAgentBrowserInstance(instanceId);
            return JSON.stringify({
              instanceId,
              url: url || null,
              shared: true,
              isolated: settings.isolation,
              created: true,
            });
          }

          case "close": {
            const instanceId = resolveBrowserMcpTargetInstanceId(
              args.instanceId,
              request.operation,
            );
            ensureBrowserAgentAccess(instanceId);
            await ensurePanelExpanded();
            const closed = callbacksRef.current.closeTab(instanceId);
            if (!closed) {
              throw new Error(`Browser tab was not found: ${instanceId}`);
            }
            return JSON.stringify({
              instanceId,
              closed: true,
            });
          }

          case "focus": {
            const instanceId = readStringArg(args, "instanceId");
            if (!instanceId) {
              throw new Error("instanceId is required for browser-focus");
            }
            ensureBrowserAgentAccess(instanceId);
            await ensurePanelExpanded();
            const focused = callbacksRef.current.focusTab(instanceId);
            if (!focused) {
              throw new Error(`Browser tab was not found: ${instanceId}`);
            }
            selectAgentBrowserInstance(instanceId);
            return JSON.stringify({
              instanceId,
              focused: true,
              agentTarget: true,
            });
          }

          case "list": {
            ensureBrowserAgentEnabled();
            const agentInstanceId = getAgentBrowserInstanceId();
            const tabs = callbacksRef.current.listTabs().map((tab) => ({
              instanceId: tab.instanceId,
              isActive: tab.isActive,
              agentTarget: tab.instanceId === agentInstanceId,
              shared: tab.shared,
              isolated: tab.isolated,
              origin: tab.origin,
              title: tab.shared
                ? tab.title
                : tGlobal("browser.agentTabHiddenTitle", {
                    defaultValue: "Tab not shared with the agent",
                  }),
              url: tab.shared ? tab.url : null,
            }));
            return JSON.stringify({
              tabs,
              totalTabs: tabs.length,
            });
          }

          case "request_share": {
            ensureBrowserAgentEnabled();
            const instanceId = resolveBrowserMcpTargetInstanceId(
              args.instanceId,
              request.operation,
            );
            const access = getBrowserAgentAccess(instanceId);
            if (!access) {
              throw new Error(`Browser tab was not found: ${instanceId}`);
            }
            if (access.shared) {
              return JSON.stringify({ instanceId, shared: true });
            }
            const settings = getBrowserAgentSettings();
            if (!isBrowserAgentUrlAllowed(access.url, settings)) {
              return JSON.stringify({
                instanceId,
                shared: false,
                reason: "domain-blocked",
                host: resolveBrowserAgentHost(access.url),
              });
            }
            await ensurePanelExpanded();
            callbacksRef.current.focusTab(instanceId);
            const granted = await requestBrowserAgentShare(instanceId);
            return JSON.stringify({
              instanceId,
              shared: granted,
              reason: granted ? null : "denied",
            });
          }

          default: {
            const instanceId = resolveBrowserMcpTargetInstanceId(
              args.instanceId,
              request.operation,
            );
            ensureBrowserAgentAccess(
              instanceId,
              request.operation === "navigate"
                ? readStringArg(args, "url")
                : undefined,
            );
            await ensurePanelExpanded();
            return executeBrowserMcpCommand(
              request.operation,
              request.argsJson,
            );
          }
        }
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
};
