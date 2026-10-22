export type BrowserMcpCommandArgs = Record<string, unknown>;

export type BrowserMcpCommandHandler = (
  operation: string,
  args: BrowserMcpCommandArgs,
) => Promise<unknown>;

type InstanceWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const instances = new Map<string, BrowserMcpCommandHandler>();
const instanceWaiters = new Map<string, Set<InstanceWaiter>>();
/** 用户在面板中当前激活的标签：只用于 Agent 尚未选定工作标签时的首次绑定。 */
let userFocusedInstanceId: string | null = null;
/**
 * Agent 工作标签（issue #253）：省略 instanceId 的命令始终指向它，用户切换
 * 标签只影响面板显示。由 browser-create / browser-focus 显式选定；尚未选定时，
 * 首次省略 instanceId 的调用绑定到用户当前激活的标签。工作标签关闭后保留其
 * ID，后续省略 instanceId 的调用明确报错，不回退到其他标签。
 */
let agentInstanceId: string | null = null;

const parseCommandArgs = (argsJson: string): BrowserMcpCommandArgs => {
  const value = JSON.parse(argsJson) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Browser command arguments must be a JSON object");
  }
  return value as BrowserMcpCommandArgs;
};

const resolveAgentInstanceId = (operation: string): string => {
  if (agentInstanceId) {
    if (instances.has(agentInstanceId)) {
      return agentInstanceId;
    }
    throw new Error(
      `The agent's working browser tab ${agentInstanceId} is no longer available in this window (closed or moved to a separate window). Call browser-list, then browser-focus with an instanceId (or browser-create) to choose a new working tab, or pass instanceId explicitly.`,
    );
  }
  if (userFocusedInstanceId && instances.has(userFocusedInstanceId)) {
    agentInstanceId = userFocusedInstanceId;
    return agentInstanceId;
  }
  throw new Error(
    `No embedded browser tab is selected for browser ${operation}; open one with browser-create or select one with browser-focus`,
  );
};

/** 解析命令目标：显式 instanceId 原样使用，省略或 current 时取 Agent 工作标签。 */
export const resolveBrowserMcpTargetInstanceId = (
  requested: unknown,
  operation: string,
): string => {
  const instanceId = typeof requested === "string" ? requested.trim() : "";
  if (instanceId && instanceId.toLowerCase() !== "current") {
    return instanceId;
  }
  return resolveAgentInstanceId(operation);
};

export const createBrowserInstanceId = (): string =>
  `browser-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/** 用户在面板中激活标签（点击/切换）时调用；不改变 Agent 工作标签。 */
export const focusBrowserMcpInstance = (instanceId: string): void => {
  if (instances.has(instanceId)) {
    userFocusedInstanceId = instanceId;
  }
};

/** Agent 经 browser-create / browser-focus 显式选定工作标签。 */
export const selectAgentBrowserInstance = (instanceId: string): void => {
  agentInstanceId = instanceId;
};

export const getAgentBrowserInstanceId = (): string | null => agentInstanceId;

export const registerBrowserMcpInstance = (
  instanceId: string,
  handler: BrowserMcpCommandHandler,
): (() => void) => {
  instances.set(instanceId, handler);
  // 上报实例归属到主进程：命令按 instanceId 路由时能定位到本渲染进程
  // （实例弹出到独立浏览器窗口后归属随窗口迁移）。
  window.snow.notifyBrowserInstanceRegistered(instanceId);
  const waiters = instanceWaiters.get(instanceId);
  if (waiters) {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    instanceWaiters.delete(instanceId);
  }

  return () => {
    if (instances.get(instanceId) === handler) {
      instances.delete(instanceId);
      window.snow.notifyBrowserInstanceUnregistered(instanceId);
      if (userFocusedInstanceId === instanceId) {
        userFocusedInstanceId = null;
      }
      // 实例在就绪前被关闭(如 create 命令等待期间用户关掉 tab):
      // 立即 reject 挂起的 waiter 并清掉其超时定时器,避免定时器
      // 悬挂到超时(多实例反复 create/close 会累积残留定时器)。
      const waiters = instanceWaiters.get(instanceId);
      if (waiters) {
        for (const waiter of waiters) {
          clearTimeout(waiter.timer);
          waiter.reject(
            new Error(
              `Browser instance was closed before it became ready: ${instanceId}`,
            ),
          );
        }
        instanceWaiters.delete(instanceId);
      }
    }
  };
};

export const waitForBrowserMcpInstance = (
  instanceId: string,
  timeoutMs = 10_000,
): Promise<void> => {
  if (instances.has(instanceId)) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      const waiters = instanceWaiters.get(instanceId);
      waiters?.delete(waiter);
      if (waiters?.size === 0) {
        instanceWaiters.delete(instanceId);
      }
      reject(new Error(`Browser instance did not become ready: ${instanceId}`));
    }, timeoutMs);
    const waiter: InstanceWaiter = { resolve, reject, timer };
    const waiters =
      instanceWaiters.get(instanceId) ?? new Set<InstanceWaiter>();
    waiters.add(waiter);
    instanceWaiters.set(instanceId, waiters);
  });
};

// 仅包含离线文件分析；take 仍需页面授权、实例与 webContents。
const OFFLINE_HEAP_ACTIONS = new Map<
  string,
  Exclude<Parameters<typeof window.snow.browserHeap>[0], "take">
>([
  ["get_heapsnapshot_summary", "summary"],
  ["query_heapsnapshot_objects", "query"],
  ["get_heapsnapshot_object_details", "details"],
  ["get_heapsnapshot_edges", "edges"],
  ["get_heapsnapshot_retainers", "retainers"],
  ["get_heapsnapshot_retaining_paths", "paths"],
  ["get_heapsnapshot_duplicate_strings", "strings"],
  ["compare_heapsnapshots", "compare"],
]);

export const isOfflineBrowserHeapOperation = (operation: string): boolean =>
  OFFLINE_HEAP_ACTIONS.has(operation);

export const executeBrowserMcpCommand = async (
  operation: string,
  argsJson: string,
): Promise<string> => {
  const args = parseCommandArgs(argsJson);
  const offlineHeapAction = OFFLINE_HEAP_ACTIONS.get(operation);
  if (offlineHeapAction) {
    // 原 IPC 的主进程文件路径校验仍负责拒绝非法/越权路径。
    return JSON.stringify(
      await window.snow.browserHeap(offlineHeapAction, args),
    );
  }
  const instanceId = resolveBrowserMcpTargetInstanceId(
    args.instanceId,
    operation,
  );

  const handler = instances.get(instanceId);
  if (!handler) {
    throw new Error(`Browser instance was not found: ${instanceId}`);
  }
  const result = await handler(operation, { ...args, instanceId });
  return JSON.stringify(result);
};

export const parseBrowserMcpCommandArgs = parseCommandArgs;

export const hasBrowserMcpInstance = (instanceId: string): boolean =>
  instances.has(instanceId);
