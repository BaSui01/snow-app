import { useSyncExternalStore } from "react";

// 子代理通信记录（仅渲染进程内存）：入队登记 pending，消费时回写终态。
export type SubAgentMessageStatus = "pending" | "delivered" | "withdrawn";

export type SubAgentMessageRecord = {
  status: SubAgentMessageStatus;
  queuedAt: number;
  settledAt?: number;
};

const MAX_RECORDS = 500;
const records = new Map<string, SubAgentMessageRecord>();
const listeners = new Set<() => void>();

const emit = (): void => {
  listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const createSubAgentMessageId = (): string =>
  `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const registerSubAgentMessage = (messageId: string): number => {
  const queuedAt = Date.now();
  records.set(messageId, { status: "pending", queuedAt });
  if (records.size > MAX_RECORDS) {
    const oldest = records.keys().next().value;
    if (oldest !== undefined) records.delete(oldest);
  }
  emit();
  return queuedAt;
};

export const settleSubAgentMessage = (
  messageId: string | undefined,
  status: Exclude<SubAgentMessageStatus, "pending">,
): void => {
  if (!messageId) return;
  const current = records.get(messageId);
  if (!current || current.status !== "pending") return;
  // 替换对象以保证快照引用变化
  records.set(messageId, { ...current, status, settledAt: Date.now() });
  emit();
};

export const useSubAgentMessageRecord = (
  messageId: string | undefined,
): SubAgentMessageRecord | undefined =>
  useSyncExternalStore(subscribe, () =>
    messageId ? records.get(messageId) : undefined,
  );
