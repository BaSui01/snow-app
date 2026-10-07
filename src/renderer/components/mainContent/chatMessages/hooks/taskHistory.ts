import type { ChatMessageRecord } from "../../../../../preload";
import type {
  FileChangeRecord,
  FileChangeCoverageRecord,
} from "../utils/conversationTypes";
import { parseToolCalls } from "../utils/conversationHelpers";
import { extractFileTrackingFromRecords } from "./fileChangeTracking";

type Source = {
  conversationId: string;
  subAgentName: string;
  recordIds: string[];
};
type Manifest = { version: 1; taskId: string; sources: Source[] };
export type TaskSnapshot = Readonly<{
  id: string;
  records: readonly FileChangeRecord[];
  coverage: readonly FileChangeCoverageRecord[];
}>;
export type AgentTaskHistory = {
  id: string;
  closed: boolean;
  endResponseId: string;
  sources: Map<string, { responseIds: Set<string>; subAgentName: string }>;
};
const activeTasks = new Map<string, AgentTaskHistory>();
export const startAgentTask = (key: string): AgentTaskHistory => {
  const task = {
    id: crypto.randomUUID(),
    closed: false,
    endResponseId: "",
    sources: new Map(),
  };
  activeTasks.set(key, task);
  return task;
};
export const currentAgentTask = (key: string): AgentTaskHistory | undefined =>
  activeTasks.get(key);
export const bindAgentTask = (key: string, task: AgentTaskHistory): void => {
  if (task.closed) return;
  const current = activeTasks.get(key);
  if (!current || current === task) activeTasks.set(key, task);
};
export const recordTaskResponse = (
  task: AgentTaskHistory | undefined,
  conversationId: string,
  responseId: string,
  subAgentName = "",
): void => {
  if (!task || task.closed || !responseId || !conversationId) return;
  const source = task.sources.get(conversationId) ?? {
    responseIds: new Set<string>(),
    subAgentName,
  };
  source.responseIds.add(responseId);
  task.sources.set(conversationId, source);
};

/** Resolve identities from actual responses and paired call IDs, never time/checkpoints. */
export const finishAgentTask = async (
  task: AgentTaskHistory,
  conversationId: string,
): Promise<void> => {
  if (task.closed) return;
  task.closed = true;
  for (const [key, current] of activeTasks)
    if (current === task) activeTasks.delete(key);
  const manifest: Manifest = { version: 1, taskId: task.id, sources: [] };
  let finalResponseId = "";
  for (const [sourceId, source] of task.sources) {
    const records = await window.snow.listChatMessages(sourceId);
    for (const responseId of source.responseIds) {
      if (
        records.filter(
          (record) =>
            record.role === "assistant" && record.responseId === responseId,
        ).length !== 1
      )
        throw new Error("Task response identity is missing or ambiguous");
    }
    const assistants = records.filter(
      (record) =>
        record.role === "assistant" &&
        source.responseIds.has(record.responseId),
    );
    const ids = new Set(assistants.map((record) => record.id));
    // Tool results are persisted after their calling assistant and before the
    // next assistant. Scope the call-ID pairing to that actual record chain;
    // providers can reuse a call ID in a later user task.
    let callingKeys = new Set<string>();
    for (const record of records) {
      if (record.role === "assistant") {
        callingKeys = source.responseIds.has(record.responseId)
          ? new Set(
              parseToolCalls(record.toolCallsJson).flatMap((call) =>
                call.callId ? [`${call.name}#${call.callId}`] : [],
              ),
            )
          : new Set();
        continue;
      }
      if (record.role !== "tool") continue;
      const segments = record.content.split(/\n\n(?=\[Tool: [^\n]+\]\n)/);
      if (
        segments.some((segment) => {
          const header = /^\[Tool:\s*(.+?)\]\n/.exec(segment);
          return !!header && callingKeys.has(header[1]);
        })
      )
        ids.add(record.id);
    }
    manifest.sources.push({
      conversationId: sourceId,
      subAgentName: source.subAgentName,
      recordIds: records
        .filter((record) => ids.has(record.id))
        .map((record) => record.id),
    });
    if (sourceId === conversationId)
      finalResponseId = assistants.some(
        (record) => record.responseId === task.endResponseId,
      )
        ? task.endResponseId
        : "";
  }
  if (!finalResponseId) return;
  await window.snow.saveTaskHistory(
    conversationId,
    finalResponseId,
    JSON.stringify(manifest),
  );
  pendingSnapshots.delete(conversationId);
  window.dispatchEvent(
    new CustomEvent("agent-task-history-updated", { detail: conversationId }),
  );
};

const readManifest = (value: unknown): Manifest | null => {
  if (!value || typeof value !== "object") return null;
  const manifest = value as Manifest;
  if (
    manifest.version !== 1 ||
    typeof manifest.taskId !== "string" ||
    !manifest.taskId ||
    !Array.isArray(manifest.sources)
  )
    return null;
  if (
    !manifest.sources.every(
      (source) =>
        source &&
        typeof source.conversationId === "string" &&
        !!source.conversationId &&
        typeof source.subAgentName === "string" &&
        Array.isArray(source.recordIds) &&
        source.recordIds.every((id) => typeof id === "string" && !!id),
    )
  )
    return null;
  return manifest;
};

/** Host-only reconstruction. Plugins receive file evidence, never chat records. */
const reconstructTaskSnapshots = async (
  conversationId: string,
): Promise<Map<string, TaskSnapshot>> => {
  const manifests = await window.snow.listTaskHistory(conversationId);
  const histories = new Map<string, Promise<ChatMessageRecord[]>>();
  const snapshots = new Map<string, TaskSnapshot>();
  for (const json of manifests) {
    let saved: { messageId: string; responseId: string; manifest: unknown };
    try {
      saved = JSON.parse(json);
    } catch {
      continue;
    }
    const manifest = readManifest(saved.manifest);
    if (!manifest || !saved.responseId || !saved.messageId) continue;
    // Fork/import can copy raw provider metadata without remapping references.
    // Never read the original conversation as if it belonged to this fork.
    if (
      !manifest.sources.some(
        (source) =>
          source.conversationId === conversationId &&
          source.recordIds.includes(saved.messageId),
      )
    )
      continue;
    const changes: FileChangeRecord[] = [];
    const coverage: FileChangeCoverageRecord[] = [];
    let complete = true;
    for (const source of manifest.sources) {
      let history = histories.get(source.conversationId);
      if (!history) {
        history = window.snow.listChatMessages(source.conversationId);
        histories.set(source.conversationId, history);
      }
      const records = (await history).filter((record) =>
        source.recordIds.includes(record.id),
      );
      if (records.length !== new Set(source.recordIds).size) {
        complete = false;
        break;
      }
      const tracking = extractFileTrackingFromRecords(records);
      const attribution = {
        agent:
          source.conversationId === conversationId
            ? ("main" as const)
            : ("sub" as const),
        ...(source.subAgentName ? { subAgentName: source.subAgentName } : {}),
      };
      changes.push(
        ...tracking.changes.map((change) => ({ ...change, ...attribution })),
      );
      coverage.push(
        ...tracking.coverage.map((record) => ({ ...record, ...attribution })),
      );
    }
    if (!complete) continue;
    const snapshot: TaskSnapshot = Object.freeze({
      id: manifest.taskId,
      records: Object.freeze(
        changes.map((record) =>
          Object.freeze({
            ...record,
            ...(record.diff ? { diff: Object.freeze({ ...record.diff }) } : {}),
          }),
        ),
      ),
      coverage: Object.freeze(
        coverage.map((record) =>
          Object.freeze({
            ...record,
            reasons: Object.freeze([...record.reasons]) as unknown as string[],
          }),
        ),
      ),
    });
    snapshots.set(`message:${saved.messageId}`, snapshot);
    const rootRecords = await histories.get(conversationId);
    // A provider may reuse a response ID. Persisted message IDs still identify
    // old cards, but a live temporary message must never inherit their snapshot.
    if (
      rootRecords?.filter(
        (record) =>
          record.role === "assistant" && record.responseId === saved.responseId,
      ).length === 1
    )
      snapshots.set(`response:${saved.responseId}`, snapshot);
  }
  return snapshots;
};

// Share simultaneous history reads across the visible message window, not durable data.
const pendingSnapshots = new Map<string, Promise<Map<string, TaskSnapshot>>>();
export const loadTaskSnapshots = (
  conversationId: string,
): Promise<Map<string, TaskSnapshot>> => {
  const existing = pendingSnapshots.get(conversationId);
  if (existing) return existing;
  const pending = reconstructTaskSnapshots(conversationId);
  pendingSnapshots.set(conversationId, pending);
  void pending
    .finally(() => {
      if (pendingSnapshots.get(conversationId) === pending)
        pendingSnapshots.delete(conversationId);
    })
    .catch(() => {});
  return pending;
};
