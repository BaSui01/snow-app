import { useSyncExternalStore } from "react";

/** 子代理运行控制：全局并发上限（排队）与失败挂起决策（重试/放弃）。
 *  仅存在于渲染进程内存；并发上限持久化在 system_settings（全局唯一）。 */

export const SUB_AGENT_MAX_CONCURRENCY_SETTING = "sub_agent_max_concurrency";
export const SUB_AGENT_MAX_CONCURRENCY_DEFAULT = 3;
export const SUB_AGENT_MAX_CONCURRENCY_MIN = 1;
export const SUB_AGENT_MAX_CONCURRENCY_MAX = 16;

export const clampSubAgentMaxConcurrency = (value: unknown): number => {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) return SUB_AGENT_MAX_CONCURRENCY_DEFAULT;
  return Math.min(
    SUB_AGENT_MAX_CONCURRENCY_MAX,
    Math.max(SUB_AGENT_MAX_CONCURRENCY_MIN, Math.round(parsed)),
  );
};

let maxConcurrency = SUB_AGENT_MAX_CONCURRENCY_DEFAULT;
let loading: Promise<void> | null = null;

const ensureLoaded = (): Promise<void> => {
  if (!loading) {
    loading = window.snow
      .getSystemSettingValue(SUB_AGENT_MAX_CONCURRENCY_SETTING)
      .then((value) => {
        if (value != null && value.trim()) {
          maxConcurrency = clampSubAgentMaxConcurrency(value);
        }
      })
      .catch(() => {
        // 读取失败沿用默认值
      });
  }
  return loading;
};

export const loadSubAgentMaxConcurrency = async (): Promise<number> => {
  await ensureLoaded();
  return maxConcurrency;
};

export const saveSubAgentMaxConcurrency = async (
  value: number,
): Promise<number> => {
  await ensureLoaded();
  const next = clampSubAgentMaxConcurrency(value);
  await window.snow.setSystemSetting(
    "子代理最大并发数",
    SUB_AGENT_MAX_CONCURRENCY_SETTING,
    String(next),
  );
  maxConcurrency = next;
  pumpSlots();
  return next;
};

// ---------------------------------------------------------------------------
// 订阅（排队集合 / 待决策集合）
// ---------------------------------------------------------------------------

const listeners = new Set<() => void>();
let queuedSnapshot: ReadonlySet<string> = new Set();
let pendingDecisionSnapshot: ReadonlySet<string> = new Set();

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const emit = (): void => {
  queuedSnapshot = new Set(slotWaiters.map((waiter) => waiter.key));
  pendingDecisionSnapshot = new Set(decisionResolvers.keys());
  listeners.forEach((listener) => listener());
};

// ---------------------------------------------------------------------------
// 并发信号量（key = 子代理会话 id）
// ---------------------------------------------------------------------------

const slotHolders = new Set<string>();
const slotWaiters: { key: string; resolve: (acquired: boolean) => void }[] = [];

function pumpSlots(): void {
  let changed = false;
  while (slotWaiters.length > 0 && slotHolders.size < maxConcurrency) {
    const waiter = slotWaiters.shift()!;
    slotHolders.add(waiter.key);
    waiter.resolve(true);
    changed = true;
  }
  if (changed) emit();
}

/** 获取运行名额；返回 false 表示已取消或排队期间被取消。 */
export const acquireSubAgentSlot = async (
  key: string,
  isCancelled?: () => boolean,
): Promise<boolean> => {
  await ensureLoaded();
  if (isCancelled?.()) return false;
  if (slotHolders.has(key)) return true;
  if (slotWaiters.length === 0 && slotHolders.size < maxConcurrency) {
    slotHolders.add(key);
    return true;
  }
  return new Promise<boolean>((resolve) => {
    slotWaiters.push({ key, resolve });
    emit();
  });
};

/** 释放名额（幂等）。 */
export const releaseSubAgentSlot = (key: string): void => {
  if (slotHolders.delete(key)) pumpSlots();
};

// ---------------------------------------------------------------------------
// 失败挂起决策
// ---------------------------------------------------------------------------

export type SubAgentFailureDecision = "retry" | "abandon";

const decisionResolvers = new Map<
  string,
  (decision: SubAgentFailureDecision) => void
>();

/** 挂起直到用户选择重试或放弃。 */
export const awaitSubAgentFailureDecision = (
  key: string,
): Promise<SubAgentFailureDecision> =>
  new Promise<SubAgentFailureDecision>((resolve) => {
    decisionResolvers.get(key)?.("abandon");
    decisionResolvers.set(key, resolve);
    emit();
  });

export const resolveSubAgentFailureDecision = (
  key: string,
  decision: SubAgentFailureDecision,
): void => {
  const resolve = decisionResolvers.get(key);
  if (!resolve) return;
  decisionResolvers.delete(key);
  emit();
  resolve(decision);
};

/** 中止时唤醒该子代理的排队与待决策等待。 */
export const cancelSubAgentRunWaits = (key: string): void => {
  const index = slotWaiters.findIndex((waiter) => waiter.key === key);
  if (index >= 0) {
    const [waiter] = slotWaiters.splice(index, 1);
    emit();
    waiter.resolve(false);
  }
  resolveSubAgentFailureDecision(key, "abandon");
};

export const useSubAgentQueued = (key: string | undefined): boolean => {
  const snapshot = useSyncExternalStore(subscribe, () => queuedSnapshot);
  return Boolean(key && snapshot.has(key));
};

export const useSubAgentFailurePending = (key: string | undefined): boolean => {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => pendingDecisionSnapshot,
  );
  return Boolean(key && snapshot.has(key));
};
