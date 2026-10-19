import type {
  SnowRemoteRollbackState,
  SnowRemoteState,
} from "../renderer/types/remoteControl";

/**
 * 实时通道（/api/live WebSocket）：服务端按增量补丁推送状态快照，
 * 替代 /api/state 轮询；连不上时由 main.ts 回落到 HTTP 轮询。
 */

type Patch =
  | { r: unknown }
  | { a: string }
  | { p: unknown[] }
  | { o: Record<string, Patch>; d?: string[] }
  | { k: string; i: Record<string, Patch>; l?: string[] };

type ServerFrame =
  | {
      t: "full";
      state: SnowRemoteState;
      rollback: SnowRemoteRollbackState | null;
    }
  | { t: "patch"; state?: Patch; rollback?: Patch }
  | { t: "error"; status: number; message: string }
  | { t: "synced"; id: number };

export type LiveHandlers = {
  onState: (state: SnowRemoteState) => void;
  onError: (status: number, message: string) => void;
  onOpen: () => void;
  /** unauthorized：凭据失效，需要重新解锁。 */
  onClose: (unauthorized: boolean) => void;
};

const CLOSE_UNAUTHORIZED = 4401;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;
const SYNC_TIMEOUT_MS = 8_000;

const applyPatch = (base: unknown, patch: Patch): unknown => {
  if ("r" in patch) return patch.r;
  if ("a" in patch) return String(base ?? "") + patch.a;
  if ("p" in patch) return [...(Array.isArray(base) ? base : []), ...patch.p];
  if ("o" in patch) {
    const next: Record<string, unknown> = {
      ...((base ?? {}) as Record<string, unknown>),
    };
    for (const [key, child] of Object.entries(patch.o)) {
      next[key] = applyPatch(next[key], child);
    }
    for (const key of patch.d ?? []) delete next[key];
    return next;
  }
  const key = patch.k;
  const items = (Array.isArray(base) ? base : []) as Record<string, unknown>[];
  const byId = new Map(items.map((item) => [String(item[key]), item]));
  for (const [id, child] of Object.entries(patch.i)) {
    byId.set(id, applyPatch(byId.get(id), child) as Record<string, unknown>);
  }
  const order = patch.l ?? items.map((item) => String(item[key]));
  return order.map((id) => {
    const item = byId.get(id);
    if (item === undefined) throw new Error("live patch: missing item");
    return item;
  });
};

let handlers: LiveHandlers | null = null;
let socket: WebSocket | null = null;
let ready = false;
let enabled = false;
let paused = false;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let state: SnowRemoteState | null = null;
let rollback: SnowRemoteRollbackState | null = null;
let rollbackListener: ((value: SnowRemoteRollbackState) => void) | null = null;
let syncSeq = 0;
const syncWaiters = new Map<number, (ok: boolean) => void>();

const send = (payload: Record<string, unknown>): void => {
  if (ready && socket) socket.send(JSON.stringify(payload));
};

const settleSyncs = (ok: boolean): void => {
  for (const resolve of syncWaiters.values()) resolve(ok);
  syncWaiters.clear();
};

const emitRollback = (): void => {
  if (rollbackListener && rollback) rollbackListener(rollback);
};

const handleFrame = (frame: ServerFrame): void => {
  if (frame.t === "synced") {
    syncWaiters.get(frame.id)?.(true);
    syncWaiters.delete(frame.id);
    return;
  }
  if (frame.t === "error") {
    state = null;
    rollback = null;
    handlers?.onError(frame.status, frame.message);
    return;
  }
  if (frame.t === "full") {
    state = frame.state;
    rollback = frame.rollback;
    handlers?.onState(state);
    emitRollback();
    return;
  }
  if (!state) {
    send({ t: "resync" });
    return;
  }
  try {
    if (frame.state) {
      state = applyPatch(state, frame.state) as SnowRemoteState;
      handlers?.onState(state);
    }
    if (frame.rollback) {
      rollback = applyPatch(
        rollback,
        frame.rollback,
      ) as SnowRemoteRollbackState;
      emitRollback();
    }
  } catch {
    state = null;
    send({ t: "resync" });
  }
};

const scheduleReconnect = (): void => {
  if (!enabled || reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
};

const connect = (): void => {
  if (!enabled || socket) return;
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  let next: WebSocket;
  try {
    next = new WebSocket(`${scheme}://${location.host}/api/live`);
  } catch {
    scheduleReconnect();
    return;
  }
  socket = next;
  next.onopen = () => {
    if (socket !== next) return;
    ready = true;
    reconnectDelay = RECONNECT_MIN_MS;
    if (paused) send({ t: "pause" });
    if (rollbackListener) send({ t: "watch", rollback: true });
    handlers?.onOpen();
  };
  next.onmessage = (event) => {
    if (socket !== next || typeof event.data !== "string") return;
    try {
      handleFrame(JSON.parse(event.data) as ServerFrame);
    } catch {
      // 非法帧直接忽略
    }
  };
  next.onclose = (event) => {
    if (socket !== next) return;
    const wasReady = ready;
    socket = null;
    ready = false;
    state = null;
    rollback = null;
    settleSyncs(false);
    const unauthorized = event.code === CLOSE_UNAUTHORIZED;
    if (unauthorized) enabled = false;
    else scheduleReconnect();
    if (wasReady || unauthorized) handlers?.onClose(unauthorized);
  };
};

export const initLive = (next: LiveHandlers): void => {
  handlers = next;
};

/** 启动实时通道；已启动时保持现有退避节奏（幂等）。 */
export const startLive = (): void => {
  if (enabled) return;
  enabled = true;
  reconnectDelay = RECONNECT_MIN_MS;
  connect();
};

/** 停止实时通道且不再重连（凭据失效时调用）。 */
export const stopLive = (): void => {
  enabled = false;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const current = socket;
  socket = null;
  ready = false;
  state = null;
  rollback = null;
  settleSyncs(false);
  current?.close();
};

export const isLiveReady = (): boolean => ready;

/** 页面回到前台：若正在退避等待则立即重连（已停止时不处理）。 */
export const wakeLive = (): void => {
  if (!enabled || socket) return;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectDelay = RECONNECT_MIN_MS;
  connect();
};

/** 页面转入后台：服务端停止推送（全部后台时桌面端也停止采集）。 */
export const setLivePaused = (value: boolean): void => {
  if (paused === value) return;
  paused = value;
  send({ t: value ? "pause" : "resume" });
};

/** 等待服务端完成一次全新采集并推送；失败（未连接 / 超时）返回 false。 */
export const syncLive = (): Promise<boolean> => {
  if (!ready) return Promise.resolve(false);
  const id = ++syncSeq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      syncWaiters.delete(id);
      resolve(false);
    }, SYNC_TIMEOUT_MS);
    syncWaiters.set(id, (ok) => {
      clearTimeout(timer);
      resolve(ok);
    });
    send({ t: "sync", id });
  });
};

/** 订阅回滚状态（null 取消订阅）。 */
export const setLiveRollbackListener = (
  listener: ((value: SnowRemoteRollbackState) => void) | null,
): void => {
  const changed = Boolean(listener) !== Boolean(rollbackListener);
  rollbackListener = listener;
  if (changed) send({ t: "watch", rollback: Boolean(listener) });
};
