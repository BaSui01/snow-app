import { gzipSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ensureWebContentsDebugger,
  getBrowserWebContents,
  registerDebuggerMessageListener,
} from "./browserNetworkRecorder";

/**
 * 页面性能 trace：基于 CDP Tracing 域。
 *
 * start → Tracing.start(ReportEvents) → 事件经 Tracing.dataCollected 累积
 * → stop → Tracing.end → tracingComplete → 分析（Core Web Vitals + 洞察）。
 */

export type TraceEvent = {
  name?: string;
  dur?: number;
  ph?: string;
  cat?: string;
  ts?: number;
  args?: { data?: Record<string, unknown>; [key: string]: unknown };
};

export type TraceMetrics = {
  fcpMs: number | null;
  lcp: { timeMs: number; size: number } | null;
  cls: number;
  loadMs: number | null;
  domContentLoadedMs: number | null;
  firstResponseMs: number | null;
};

export type TraceInsight = {
  id: string;
  title: string;
  summary: string;
};

export type TraceStats = {
  ok: boolean;
  error?: string;
  durationMs: number;
  eventCount: number;
  metrics: TraceMetrics;
  longTasks: { count: number; totalMs: number; longestMs: number };
  topEventTypes: { name: string; count: number }[];
  insights: TraceInsight[];
  savedTo?: string;
  note?: string;
};

const TRACE_CATEGORIES = [
  "devtools.timeline",
  "v8.execute",
  "blink.user_timing",
  "loading",
  "latencyInfo",
];

type ActiveTrace = {
  chunks: string[];
  startedAt: number;
  completeResolve: (() => void) | null;
};

const activeTraces = new Map<number, ActiveTrace>();
const lastInsightDetails = new Map<
  number,
  Map<string, Record<string, unknown>>
>();

const emptyMetrics = (): TraceMetrics => ({
  fcpMs: null,
  lcp: null,
  cls: 0,
  loadMs: null,
  domContentLoadedMs: null,
  firstResponseMs: null,
});

export const handleTraceMessage = (
  webContentsId: number,
  method: string,
  params: unknown,
): void => {
  const active = activeTraces.get(webContentsId);
  if (!active) {
    return;
  }
  if (method === "Tracing.dataCollected") {
    const value = (params as { value?: unknown } | null)?.value;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string") {
          active.chunks.push(entry);
        } else if (entry !== null && typeof entry === "object") {
          try {
            active.chunks.push(JSON.stringify(entry));
          } catch {
            // 忽略不可序列化条目。
          }
        }
      }
    }
  } else if (method === "Tracing.tracingComplete") {
    active.completeResolve?.();
  }
};

registerDebuggerMessageListener(handleTraceMessage);

export const startBrowserTrace = async (
  webContentsId: number,
  categories?: string[],
): Promise<{ started: boolean; startedAt: string; categories: string[] }> => {
  if (activeTraces.has(webContentsId)) {
    throw new Error(
      "A performance trace is already running for this browser tab; call performance_stop_trace first",
    );
  }
  const contents = getBrowserWebContents(webContentsId);
  await ensureWebContentsDebugger(contents);
  if (!contents.debugger.isAttached()) {
    throw new Error(
      "Browser debugger is unavailable; close the page DevTools and retry",
    );
  }
  const usedCategories =
    categories && categories.length > 0 ? categories : TRACE_CATEGORIES;
  activeTraces.set(webContentsId, {
    chunks: [],
    startedAt: Date.now(),
    completeResolve: null,
  });
  try {
    await contents.debugger.sendCommand("Tracing.start", {
      categories: usedCategories,
      transferMode: "ReportEvents",
    });
  } catch (error) {
    activeTraces.delete(webContentsId);
    throw error;
  }
  return {
    started: true,
    startedAt: new Date().toISOString(),
    categories: usedCategories,
  };
};

export const stopBrowserTrace = async (
  webContentsId: number,
  options: { filePath?: string } = {},
): Promise<TraceStats> => {
  const active = activeTraces.get(webContentsId);
  if (!active) {
    throw new Error(
      "No active performance trace; call performance_start_trace first",
    );
  }
  const contents = getBrowserWebContents(webContentsId);
  if (!contents.debugger.isAttached()) {
    activeTraces.delete(webContentsId);
    throw new Error(
      "Browser debugger is unavailable; close the page DevTools and retry",
    );
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const completed = new Promise<void>((resolve, reject) => {
    active.completeResolve = resolve;
    timer = setTimeout(
      () => reject(new Error("Trace completion timed out after 30 seconds")),
      30_000,
    );
  });
  try {
    await contents.debugger.sendCommand("Tracing.end");
    await completed;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    activeTraces.delete(webContentsId);
  }
  const durationMs = Date.now() - active.startedAt;
  const events = parseChunks(active.chunks);
  let savedTo: string | undefined;
  if (options.filePath) {
    await saveTraceFile(options.filePath, events);
    savedTo = options.filePath;
  }
  const stats = analyzeTrace(events, durationMs);
  if (savedTo) {
    stats.savedTo = savedTo;
  }
  lastInsightDetails.set(webContentsId, buildInsightDetails(events, stats));
  return stats;
};

export const getTraceInsight = (
  webContentsId: number,
  insightId: string,
): { found: boolean; detail?: Record<string, unknown> } => {
  const detail = lastInsightDetails.get(webContentsId)?.get(insightId);
  if (!detail) {
    return { found: false };
  }
  return { found: true, detail };
};

/** devtools action=trace：固定时长录制的兼容入口（start → 等待 → stop）。 */
export const runBrowserTrace = async (
  webContentsId: number,
  durationMs: number,
): Promise<TraceStats> => {
  try {
    await startBrowserTrace(webContentsId);
  } catch (error) {
    return {
      ok: false,
      durationMs: 0,
      eventCount: 0,
      metrics: emptyMetrics(),
      longTasks: { count: 0, totalMs: 0, longestMs: 0 },
      topEventTypes: [],
      insights: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  try {
    return await stopBrowserTrace(webContentsId);
  } catch (error) {
    activeTraces.delete(webContentsId);
    return {
      ok: false,
      durationMs: 0,
      eventCount: 0,
      metrics: emptyMetrics(),
      longTasks: { count: 0, totalMs: 0, longestMs: 0 },
      topEventTypes: [],
      insights: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const parseChunks = (chunks: string[]): TraceEvent[] => {
  try {
    return JSON.parse(`[${chunks.join(",")}]`) as TraceEvent[];
  } catch {
    const valid: TraceEvent[] = [];
    for (const chunk of chunks) {
      try {
        valid.push(JSON.parse(chunk) as TraceEvent);
      } catch {
        // 跳过无效片段。
      }
    }
    return valid;
  }
};

const saveTraceFile = async (
  filePath: string,
  events: TraceEvent[],
): Promise<void> => {
  const json = JSON.stringify(events);
  await mkdir(dirname(filePath), { recursive: true });
  if (filePath.endsWith(".gz")) {
    await writeFile(filePath, gzipSync(json));
  } else {
    await writeFile(filePath, json, "utf8");
  }
};

const usToMs = (value: number): number => value / 1000;

const readEventData = (event: TraceEvent): Record<string, unknown> =>
  event.args?.data ?? {};

const analyzeTrace = (events: TraceEvent[], durationMs: number): TraceStats => {
  const navStarts = events
    .filter((event) => event.name === "navigationStart")
    .map((event) => event.ts ?? Number.POSITIVE_INFINITY);
  const eventTimes = events.map(
    (event) => event.ts ?? Number.POSITIVE_INFINITY,
  );
  const base = Math.min(...navStarts, ...eventTimes);
  const hasBase = Number.isFinite(base);
  const relMs = (ts?: number): number | null =>
    hasBase && typeof ts === "number" && Number.isFinite(ts)
      ? Math.round(usToMs(ts - base))
      : null;

  const metrics = emptyMetrics();

  const fcpEvent = events.find(
    (event) => event.name === "firstContentfulPaint",
  );
  metrics.fcpMs = fcpEvent ? relMs(fcpEvent.ts) : null;

  for (const event of events) {
    if (event.name !== "largestContentfulPaint::Candidate") {
      continue;
    }
    const data = readEventData(event);
    const size = typeof data.size === "number" ? data.size : 0;
    const rawTime =
      typeof data.renderTime === "number"
        ? data.renderTime
        : typeof data.loadTime === "number"
          ? data.loadTime
          : 0;
    let timeMs = Math.round(usToMs(rawTime));
    if (timeMs > durationMs * 2 && typeof event.ts === "number") {
      timeMs = Math.round(usToMs(event.ts - base));
    }
    if (!metrics.lcp || size > metrics.lcp.size) {
      metrics.lcp = { timeMs, size };
    }
  }

  const shifts: {
    startMs: number | null;
    score: number;
    hadRecentInput: boolean;
  }[] = [];
  let cls = 0;
  for (const event of events) {
    if (event.name !== "LayoutShift") {
      continue;
    }
    const data = readEventData(event);
    const score = typeof data.score === "number" ? data.score : 0;
    const hadRecentInput = data.hadRecentInput === true;
    if (!hadRecentInput) {
      cls += score;
    }
    shifts.push({ startMs: relMs(event.ts), score, hadRecentInput });
  }
  metrics.cls = Math.round(cls * 1000) / 1000;

  const loadEvent = events.find((event) => event.name === "MarkLoad");
  metrics.loadMs = loadEvent ? relMs(loadEvent.ts) : null;
  const dclEvent = events.find((event) => event.name === "MarkDOMContent");
  metrics.domContentLoadedMs = dclEvent ? relMs(dclEvent.ts) : null;

  let firstSend: TraceEvent | null = null;
  for (const event of events) {
    if (event.name !== "ResourceSendRequest") {
      continue;
    }
    if (
      !firstSend ||
      (event.ts ?? Number.POSITIVE_INFINITY) <
        (firstSend.ts ?? Number.POSITIVE_INFINITY)
    ) {
      firstSend = event;
    }
  }
  let firstRequestUrl: string | null = null;
  if (firstSend) {
    const data = readEventData(firstSend);
    const requestId = data.requestId;
    firstRequestUrl = typeof data.url === "string" ? data.url : null;
    if (typeof requestId === "string") {
      const response = events.find(
        (event) =>
          event.name === "ResourceReceiveResponse" &&
          readEventData(event).requestId === requestId,
      );
      if (
        response &&
        typeof response.ts === "number" &&
        typeof firstSend.ts === "number"
      ) {
        metrics.firstResponseMs = Math.round(
          usToMs(response.ts - firstSend.ts),
        );
      }
    }
  }

  const longTaskEvents = events.filter(
    (event) => event.name === "RunTask" && (event.dur ?? 0) > 50_000,
  );
  const totalLongMs = longTaskEvents.reduce(
    (sum, event) => sum + usToMs(event.dur ?? 0),
    0,
  );
  const longestMs = longTaskEvents.reduce(
    (max, event) => Math.max(max, usToMs(event.dur ?? 0)),
    0,
  );
  const topLongTasks = [...longTaskEvents]
    .sort((left, right) => (right.dur ?? 0) - (left.dur ?? 0))
    .slice(0, 20)
    .map((event) => ({
      startMs: relMs(event.ts),
      durationMs: Math.round(usToMs(event.dur ?? 0)),
    }));

  const fcpTs = fcpEvent?.ts ?? null;
  let blockingMs = 0;
  const blockingTasks: { startMs: number | null; durationMs: number }[] = [];
  if (typeof fcpTs === "number") {
    for (const event of events) {
      if (event.name !== "RunTask") {
        continue;
      }
      const start = event.ts ?? 0;
      const end = start + (event.dur ?? 0);
      if (end <= fcpTs) {
        blockingMs += usToMs(event.dur ?? 0);
        blockingTasks.push({
          startMs: relMs(event.ts),
          durationMs: Math.round(usToMs(event.dur ?? 0)),
        });
      }
    }
  }

  const requestStarts = new Map<string, { origin: string; ts: number }>();
  for (const event of events) {
    if (event.name !== "ResourceSendRequest") {
      continue;
    }
    const data = readEventData(event);
    const requestId = data.requestId;
    const url = data.url;
    if (
      typeof requestId === "string" &&
      typeof url === "string" &&
      typeof event.ts === "number"
    ) {
      let origin = "";
      try {
        origin = new URL(url).origin;
      } catch {
        origin = "";
      }
      if (origin) {
        requestStarts.set(requestId, { origin, ts: event.ts });
      }
    }
  }
  const mainOrigin = (() => {
    if (!firstRequestUrl) {
      return "";
    }
    try {
      return new URL(firstRequestUrl).origin;
    } catch {
      return "";
    }
  })();
  const originTotals = new Map<string, { count: number; totalMs: number }>();
  for (const event of events) {
    if (event.name !== "ResourceFinish") {
      continue;
    }
    const requestId = readEventData(event).requestId;
    if (typeof requestId !== "string" || typeof event.ts !== "number") {
      continue;
    }
    const start = requestStarts.get(requestId);
    if (!start) {
      continue;
    }
    const entry = originTotals.get(start.origin) ?? { count: 0, totalMs: 0 };
    entry.count += 1;
    entry.totalMs += usToMs(event.ts - start.ts);
    originTotals.set(start.origin, entry);
  }
  const thirdParties = [...originTotals.entries()]
    .filter(([origin]) => origin !== mainOrigin)
    .sort((left, right) => right[1].totalMs - left[1].totalMs)
    .slice(0, 10)
    .map(([origin, entry]) => ({
      origin,
      requests: entry.count,
      totalMs: Math.round(entry.totalMs),
    }));

  const typeCounts = new Map<string, number>();
  for (const event of events) {
    const name = event.name ?? event.cat ?? "unknown";
    typeCounts.set(name, (typeCounts.get(name) ?? 0) + 1);
  }
  const topEventTypes = [...typeCounts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  const insights: TraceInsight[] = [];
  insights.push({
    id: "long-tasks",
    title: "Main-thread long tasks",
    summary: `${longTaskEvents.length} task(s) over 50ms, totalling ${Math.round(totalLongMs)}ms (longest ${Math.round(longestMs)}ms)`,
  });
  if (typeof fcpTs === "number") {
    insights.push({
      id: "render-blocking",
      title: "Render-blocking time",
      summary: `Main thread busy for ${Math.round(blockingMs)}ms before first contentful paint (${blockingTasks.length} task(s))`,
    });
  }
  if (metrics.lcp) {
    insights.push({
      id: "lcp",
      title: "Largest Contentful Paint",
      summary: `Largest content paint candidate at ${metrics.lcp.timeMs}ms (${metrics.lcp.size} bytes)`,
    });
  }
  insights.push({
    id: "cls",
    title: "Cumulative Layout Shift",
    summary: `${metrics.cls.toFixed(3)} accumulated across ${shifts.length} layout shift(s)`,
  });
  if (metrics.firstResponseMs !== null) {
    insights.push({
      id: "document-latency",
      title: "Document latency",
      summary: `First resource response after ${metrics.firstResponseMs}ms`,
    });
  }
  if (thirdParties.length > 0) {
    insights.push({
      id: "third-parties",
      title: "Third-party origins",
      summary: `${thirdParties.length} third-party origin(s); busiest ${thirdParties[0].origin} (${thirdParties[0].totalMs}ms total)`,
    });
  }

  return {
    ok: true,
    durationMs,
    eventCount: events.length,
    metrics,
    longTasks: {
      count: longTaskEvents.length,
      totalMs: Math.round(totalLongMs),
      longestMs: Math.round(longestMs),
    },
    topEventTypes,
    insights,
    note: "Long tasks are main-thread tasks over 50ms (jank indicator). Metrics are derived from the trace and approximate until the page settles.",
  };
};

const buildInsightDetails = (
  events: TraceEvent[],
  stats: TraceStats,
): Map<string, Record<string, unknown>> => {
  const details = new Map<string, Record<string, unknown>>();
  const base = Math.min(
    ...events
      .filter((event) => event.name === "navigationStart")
      .map((event) => event.ts ?? Number.POSITIVE_INFINITY),
    ...events.map((event) => event.ts ?? Number.POSITIVE_INFINITY),
  );
  const relMs = (ts?: number): number | null =>
    Number.isFinite(base) && typeof ts === "number"
      ? Math.round((ts - base) / 1000)
      : null;

  const longTasks = events
    .filter((event) => event.name === "RunTask" && (event.dur ?? 0) > 50_000)
    .sort((left, right) => (right.dur ?? 0) - (left.dur ?? 0))
    .slice(0, 20)
    .map((event) => ({
      startMs: relMs(event.ts),
      durationMs: Math.round((event.dur ?? 0) / 1000),
    }));
  details.set("long-tasks", { tasks: longTasks });

  const fcpTs = events.find(
    (event) => event.name === "firstContentfulPaint",
  )?.ts;
  if (typeof fcpTs === "number") {
    const blocking = events
      .filter(
        (event) =>
          event.name === "RunTask" &&
          (event.ts ?? 0) + (event.dur ?? 0) <= fcpTs,
      )
      .sort((left, right) => (right.dur ?? 0) - (left.dur ?? 0))
      .slice(0, 20)
      .map((event) => ({
        startMs: relMs(event.ts),
        durationMs: Math.round((event.dur ?? 0) / 1000),
      }));
    details.set("render-blocking", {
      fcpMs: stats.metrics.fcpMs,
      tasks: blocking,
    });
  }

  if (stats.metrics.lcp) {
    details.set("lcp", { ...stats.metrics.lcp });
  }

  const shifts = events
    .filter((event) => event.name === "LayoutShift")
    .slice(0, 50)
    .map((event) => {
      const data = event.args?.data ?? {};
      return {
        startMs: relMs(event.ts),
        score: typeof data.score === "number" ? data.score : 0,
        hadRecentInput: data.hadRecentInput === true,
      };
    });
  details.set("cls", { score: stats.metrics.cls, shifts });

  if (stats.metrics.firstResponseMs !== null) {
    details.set("document-latency", {
      firstResponseMs: stats.metrics.firstResponseMs,
    });
  }
  details.set("third-parties", {
    note: "Aggregated from ResourceSendRequest/ResourceFinish events",
  });
  return details;
};
