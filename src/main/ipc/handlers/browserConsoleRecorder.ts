import { app } from "electron";
import { registerDebuggerMessageListener } from "./browserNetworkRecorder";

/**
 * 内置浏览器控制台采集（CDP Runtime / Log 域）。
 * debugger 会话激活（ensureWebContentsDebugger）后才会收到 CDP 事件；
 * 主帧导航时归档当前代际，保留最近 3 代供 includePreserved 查询。
 */

export type BrowserConsoleStackFrame = {
  functionName: string;
  url: string;
  lineNumber: number;
  columnNumber: number;
};

export type BrowserConsoleEntry = {
  id: number;
  kind: "console" | "exception" | "log";
  type: string;
  level: number;
  message: string;
  args?: string[];
  url?: string;
  line?: number;
  column?: number;
  stackTrace?: BrowserConsoleStackFrame[];
  timestamp: number;
  recordedAt: string;
};

const MAX_ENTRIES_PER_GENERATION = 500;
const MAX_ARCHIVED_GENERATIONS = 3;

type ConsoleState = {
  nextId: number;
  current: BrowserConsoleEntry[];
  archived: BrowserConsoleEntry[][];
};

const states = new Map<number, ConsoleState>();
let initialized = false;

const stateFor = (webContentsId: number): ConsoleState => {
  let state = states.get(webContentsId);
  if (!state) {
    state = { nextId: 1, current: [], archived: [] };
    states.set(webContentsId, state);
  }
  return state;
};

const pushEntry = (
  webContentsId: number,
  entry: Omit<BrowserConsoleEntry, "id" | "recordedAt">,
): void => {
  const state = stateFor(webContentsId);
  state.current.push({
    ...entry,
    id: state.nextId++,
    recordedAt: new Date(entry.timestamp || Date.now()).toISOString(),
  });
  if (state.current.length > MAX_ENTRIES_PER_GENERATION) {
    state.current.splice(0, state.current.length - MAX_ENTRIES_PER_GENERATION);
  }
};

const archiveConsoleGeneration = (webContentsId: number): void => {
  const state = states.get(webContentsId);
  if (!state || state.current.length === 0) {
    return;
  }
  state.archived.unshift(state.current);
  if (state.archived.length > MAX_ARCHIVED_GENERATIONS) {
    state.archived.length = MAX_ARCHIVED_GENERATIONS;
  }
  state.current = [];
};

const dropConsoleState = (webContentsId: number): void => {
  states.delete(webContentsId);
};

const CONSOLE_TYPE_LEVEL: Record<string, number> = {
  verbose: 0,
  debug: 0,
  log: 1,
  info: 1,
  dir: 1,
  dirxml: 1,
  table: 1,
  trace: 1,
  count: 1,
  timeEnd: 1,
  warning: 2,
  error: 3,
  assert: 3,
};

const LOG_ENTRY_LEVEL: Record<string, number> = {
  verbose: 0,
  info: 1,
  warning: 2,
  error: 3,
};

const serializeRemoteArg = (arg: unknown): string => {
  if (arg === null || arg === undefined) {
    return String(arg);
  }
  if (typeof arg !== "object") {
    return String(arg);
  }
  const remote = arg as {
    type?: unknown;
    value?: unknown;
    unserializableValue?: unknown;
    description?: unknown;
  };
  if (typeof remote.unserializableValue === "string") {
    return remote.unserializableValue;
  }
  if (remote.value !== undefined) {
    if (typeof remote.value === "string") {
      return remote.value;
    }
    if (
      typeof remote.value === "number" ||
      typeof remote.value === "boolean" ||
      typeof remote.value === "bigint"
    ) {
      return String(remote.value);
    }
    try {
      return JSON.stringify(remote.value);
    } catch {
      return String(remote.type ?? "value");
    }
  }
  if (typeof remote.description === "string") {
    return remote.description;
  }
  if (typeof remote.type === "string") {
    return `<${remote.type}>`;
  }
  return "";
};

const readStackFrames = (
  value: unknown,
): BrowserConsoleStackFrame[] | undefined => {
  const frames = (value as { callFrames?: unknown } | null)?.callFrames;
  if (!Array.isArray(frames) || frames.length === 0) {
    return undefined;
  }
  const out: BrowserConsoleStackFrame[] = [];
  for (const frame of frames.slice(0, 10)) {
    const item = (frame ?? {}) as Record<string, unknown>;
    out.push({
      functionName:
        typeof item.functionName === "string" ? item.functionName : "",
      url: typeof item.url === "string" ? item.url : "",
      lineNumber: typeof item.lineNumber === "number" ? item.lineNumber + 1 : 0,
      columnNumber:
        typeof item.columnNumber === "number" ? item.columnNumber + 1 : 0,
    });
  }
  return out;
};

const handleConsoleAPICalled = (
  webContentsId: number,
  params: unknown,
): void => {
  const p = (params ?? {}) as Record<string, unknown>;
  const type = typeof p.type === "string" ? p.type.trim() : "log";
  if (type === "clear") {
    const state = states.get(webContentsId);
    if (state) {
      state.current = [];
    }
    return;
  }
  const args = Array.isArray(p.args) ? p.args.map(serializeRemoteArg) : [];
  pushEntry(webContentsId, {
    kind: "console",
    type,
    level: CONSOLE_TYPE_LEVEL[type] ?? 1,
    message: args.join(" "),
    args: args.length > 0 ? args : undefined,
    url: typeof p.url === "string" ? p.url : undefined,
    line: typeof p.lineNumber === "number" ? p.lineNumber + 1 : undefined,
    column: typeof p.columnNumber === "number" ? p.columnNumber + 1 : undefined,
    stackTrace: readStackFrames(p.stackTrace),
    timestamp: typeof p.timestamp === "number" ? p.timestamp : Date.now(),
  });
};

const handleExceptionThrown = (
  webContentsId: number,
  params: unknown,
): void => {
  const details = (
    (params ?? {}) as { exceptionDetails?: Record<string, unknown> }
  ).exceptionDetails;
  if (!details) {
    return;
  }
  const exception = (details.exception ?? {}) as Record<string, unknown>;
  const description =
    typeof exception.description === "string" ? exception.description : "";
  const text =
    typeof details.text === "string" ? details.text : "Uncaught exception";
  pushEntry(webContentsId, {
    kind: "exception",
    type: "exception",
    level: 3,
    message: description || text,
    url: typeof details.url === "string" ? details.url : undefined,
    line:
      typeof details.lineNumber === "number"
        ? details.lineNumber + 1
        : undefined,
    column:
      typeof details.columnNumber === "number"
        ? details.columnNumber + 1
        : undefined,
    stackTrace: readStackFrames(details.stackTrace),
    timestamp:
      typeof details.timestamp === "number" ? details.timestamp : Date.now(),
  });
};

const handleLogEntryAdded = (webContentsId: number, params: unknown): void => {
  const entry = ((params ?? {}) as { entry?: Record<string, unknown> }).entry;
  if (!entry) {
    return;
  }
  const level = typeof entry.level === "string" ? entry.level : "info";
  pushEntry(webContentsId, {
    kind: "log",
    type: typeof entry.source === "string" ? entry.source : "log",
    level: LOG_ENTRY_LEVEL[level] ?? 1,
    message: typeof entry.text === "string" ? entry.text : "",
    url: typeof entry.url === "string" ? entry.url : undefined,
    line: typeof entry.lineNumber === "number" ? entry.lineNumber : undefined,
    timestamp:
      typeof entry.timestamp === "number" ? entry.timestamp : Date.now(),
  });
};

const handleMessage = (
  webContentsId: number,
  method: string,
  params: unknown,
): void => {
  switch (method) {
    case "Runtime.consoleAPICalled":
      handleConsoleAPICalled(webContentsId, params);
      break;
    case "Runtime.exceptionThrown":
      handleExceptionThrown(webContentsId, params);
      break;
    case "Log.entryAdded":
      handleLogEntryAdded(webContentsId, params);
      break;
    case "Page.frameNavigated": {
      const frame = ((params ?? {}) as { frame?: { parentId?: unknown } })
        .frame;
      if (frame && frame.parentId == null) {
        archiveConsoleGeneration(webContentsId);
      }
      break;
    }
    default:
      break;
  }
};

export const initBrowserConsoleRecorder = (): void => {
  if (initialized) {
    return;
  }
  initialized = true;
  registerDebuggerMessageListener(handleMessage);
  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "webview") {
      return;
    }
    contents.once("destroyed", () => dropConsoleState(contents.id));
  });
};

export type ConsoleQueryOptions = {
  level?: number;
  types?: string[];
  pageIdx?: number;
  pageSize?: number;
  includePreserved?: boolean;
};

export type ConsoleQueryResult = {
  messages: BrowserConsoleEntry[];
  total: number;
  pageIdx: number;
  pageSize: number;
  hasMore: boolean;
  archivedGenerations: number;
};

export const queryConsoleRecords = (
  webContentsId: number,
  options: ConsoleQueryOptions = {},
): ConsoleQueryResult => {
  const state = states.get(webContentsId);
  const rows: BrowserConsoleEntry[] = [];
  if (state) {
    if (options.includePreserved) {
      for (let index = state.archived.length - 1; index >= 0; index--) {
        rows.push(...state.archived[index]);
      }
    }
    rows.push(...state.current);
  }
  let filtered = rows;
  if (typeof options.level === "number") {
    const minLevel = options.level;
    filtered = filtered.filter((row) => row.level >= minLevel);
  }
  if (options.types && options.types.length > 0) {
    const wanted = new Set(options.types);
    filtered = filtered.filter(
      (row) => wanted.has(row.type) || wanted.has(row.kind),
    );
  }
  const pageIdx = Math.max(0, options.pageIdx ?? 0);
  const pageSize = Math.max(
    1,
    options.pageSize ?? Math.max(filtered.length, 1),
  );
  const start = pageIdx * pageSize;
  const messages = filtered.slice(start, start + pageSize);
  return {
    messages,
    total: filtered.length,
    pageIdx,
    pageSize,
    hasMore: start + messages.length < filtered.length,
    archivedGenerations: state?.archived.length ?? 0,
  };
};

export const getConsoleRecord = (
  webContentsId: number,
  messageId: number,
): BrowserConsoleEntry | null => {
  const state = states.get(webContentsId);
  if (!state) {
    return null;
  }
  for (const entry of state.current) {
    if (entry.id === messageId) {
      return entry;
    }
  }
  for (const generation of state.archived) {
    for (const entry of generation) {
      if (entry.id === messageId) {
        return entry;
      }
    }
  }
  return null;
};

export const clearConsoleRecords = (webContentsId: number): number => {
  const state = states.get(webContentsId);
  if (!state) {
    return 0;
  }
  const count =
    state.current.length +
    state.archived.reduce((sum, generation) => sum + generation.length, 0);
  state.current = [];
  state.archived = [];
  return count;
};
