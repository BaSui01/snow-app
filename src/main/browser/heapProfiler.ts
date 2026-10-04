import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ensureWebContentsDebugger,
  getBrowserWebContents,
  registerDebuggerMessageListener,
} from "../ipc/handlers/browserNetworkRecorder";

/**
 * 堆快照：CDP 采集（.heapsnapshot）+ 文件解析分析（summary / 对象查询 /
 * 引用关系 / 保留路径 / 重复字符串 / 双快照对比）。
 * 解析结果按文件（mtime + size）缓存，总量受限；反向索引与边偏移惰性构建。
 */

type SnapshotCollector = { chunks: string[] };
const collectors = new Map<number, SnapshotCollector>();

const handleHeapMessage = (
  webContentsId: number,
  method: string,
  params: unknown,
): void => {
  if (method !== "HeapProfiler.addHeapSnapshotChunk") {
    return;
  }
  const collector = collectors.get(webContentsId);
  if (!collector) {
    return;
  }
  const chunk = (params as { chunk?: unknown } | null)?.chunk;
  if (typeof chunk === "string") {
    collector.chunks.push(chunk);
  }
};

registerDebuggerMessageListener(handleHeapMessage);

const withTimeout = async <T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

export const takeHeapSnapshot = async (
  webContentsId: number,
  filePath: string,
): Promise<{ file: string; bytes: number }> => {
  if (collectors.has(webContentsId)) {
    throw new Error(
      "A heap snapshot is already being captured for this browser tab",
    );
  }
  const contents = getBrowserWebContents(webContentsId);
  await ensureWebContentsDebugger(contents);
  if (!contents.debugger.isAttached()) {
    throw new Error(
      "Browser debugger is unavailable; close the page DevTools and retry",
    );
  }
  await contents.debugger.sendCommand("HeapProfiler.enable");
  const collector: SnapshotCollector = { chunks: [] };
  collectors.set(webContentsId, collector);
  try {
    await withTimeout(
      contents.debugger.sendCommand("HeapProfiler.takeHeapSnapshot", {
        reportProgress: false,
      }),
      120_000,
      "Heap snapshot capture timed out after 120 seconds",
    );
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    collectors.delete(webContentsId);
  }
  const json = collector.chunks.join("");
  if (!json) {
    throw new Error("Heap snapshot produced no data");
  }
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, json, "utf8");
  return { file: filePath, bytes: Buffer.byteLength(json, "utf8") };
};

type ParsedSnapshot = {
  file: string;
  nodeFieldCount: number;
  edgeFieldCount: number;
  nodeCount: number;
  edgeCount: number;
  nodes: number[];
  edges: number[];
  strings: string[];
  nodeTypes: string[];
  edgeTypes: string[];
  nodeTypeOffset: number;
  nameOffset: number;
  idOffset: number;
  selfSizeOffset: number;
  edgeCountOffset: number;
  detachednessOffset: number;
  edgeTypeOffset: number;
  edgeNameOffset: number;
  edgeToOffset: number;
  edgeOffsets?: Uint32Array;
  reverseEdges?: { offsets: Uint32Array; values: Uint32Array };
};

const MAX_SNAPSHOT_FILE_BYTES = 512 * 1024 * 1024;
const CACHE_TOTAL_BYTES = 320 * 1024 * 1024;
const MAX_QUERY_ROWS = 200_000;

type CacheEntry = {
  file: string;
  mtimeMs: number;
  size: number;
  parsed: ParsedSnapshot;
};

const snapshotCache: CacheEntry[] = [];

const parseSnapshotFile = async (filePath: string): Promise<ParsedSnapshot> => {
  const info = await stat(filePath);
  const cached = snapshotCache.find(
    (entry) =>
      entry.file === filePath &&
      entry.mtimeMs === info.mtimeMs &&
      entry.size === info.size,
  );
  if (cached) {
    snapshotCache.splice(snapshotCache.indexOf(cached), 1);
    snapshotCache.push(cached);
    return cached.parsed;
  }
  if (info.size > MAX_SNAPSHOT_FILE_BYTES) {
    throw new Error(
      `Heap snapshot file is too large to analyze (${info.size} bytes, maximum ${MAX_SNAPSHOT_FILE_BYTES})`,
    );
  }
  const text = await readFile(filePath, "utf8");
  let raw: {
    snapshot?: {
      meta?: {
        node_fields?: unknown;
        node_types?: unknown;
        edge_fields?: unknown;
        edge_types?: unknown;
      };
    };
    nodes?: unknown;
    edges?: unknown;
    strings?: unknown;
  };
  try {
    raw = JSON.parse(text) as typeof raw;
  } catch {
    throw new Error("Heap snapshot file is not valid JSON");
  }
  const meta = raw.snapshot?.meta;
  if (
    !meta ||
    !Array.isArray(meta.node_fields) ||
    !Array.isArray(meta.edge_fields) ||
    !Array.isArray(raw.nodes) ||
    !Array.isArray(raw.edges) ||
    !Array.isArray(raw.strings)
  ) {
    throw new Error("Heap snapshot file has an unexpected format");
  }
  const nodeFields = meta.node_fields as string[];
  const edgeFields = meta.edge_fields as string[];
  const typeTable = (tables: unknown, index: number): string[] => {
    if (!Array.isArray(tables)) {
      return [];
    }
    const entry = (tables as unknown[])[index];
    return Array.isArray(entry) ? (entry as string[]) : [];
  };
  const nodeTypeOffset = nodeFields.indexOf("type");
  const edgeTypeOffset = edgeFields.indexOf("type");
  const parsed: ParsedSnapshot = {
    file: filePath,
    nodeFieldCount: nodeFields.length,
    edgeFieldCount: edgeFields.length,
    nodeCount: Math.floor((raw.nodes as number[]).length / nodeFields.length),
    edgeCount: Math.floor((raw.edges as number[]).length / edgeFields.length),
    nodes: raw.nodes as number[],
    edges: raw.edges as number[],
    strings: raw.strings as string[],
    nodeTypes: typeTable(meta.node_types, nodeTypeOffset),
    edgeTypes: typeTable(meta.edge_types, edgeTypeOffset),
    nodeTypeOffset,
    nameOffset: nodeFields.indexOf("name"),
    idOffset: nodeFields.indexOf("id"),
    selfSizeOffset: nodeFields.indexOf("self_size"),
    edgeCountOffset: nodeFields.indexOf("edge_count"),
    detachednessOffset: nodeFields.indexOf("detachedness"),
    edgeTypeOffset,
    edgeNameOffset: edgeFields.indexOf("name_or_index"),
    edgeToOffset: edgeFields.indexOf("to_node"),
  };
  snapshotCache.push({
    file: filePath,
    mtimeMs: info.mtimeMs,
    size: info.size,
    parsed,
  });
  let total = snapshotCache.reduce((sum, entry) => sum + entry.size, 0);
  while (snapshotCache.length > 1 && total > CACHE_TOTAL_BYTES) {
    const removed = snapshotCache.shift();
    if (removed) {
      total -= removed.size;
    }
  }
  return parsed;
};

const readNodeField = (
  parsed: ParsedSnapshot,
  index: number,
  offset: number,
): number => parsed.nodes[index * parsed.nodeFieldCount + offset];

const nodeName = (parsed: ParsedSnapshot, index: number): string => {
  const nameIndex = readNodeField(parsed, index, parsed.nameOffset);
  return parsed.strings[nameIndex] ?? "?";
};

const nodeType = (parsed: ParsedSnapshot, index: number): string => {
  const typeIndex = readNodeField(parsed, index, parsed.nodeTypeOffset);
  return parsed.nodeTypes[typeIndex] ?? "unknown";
};

const nodeSelfSize = (parsed: ParsedSnapshot, index: number): number =>
  readNodeField(parsed, index, parsed.selfSizeOffset);

const nodeId = (parsed: ParsedSnapshot, index: number): number =>
  readNodeField(parsed, index, parsed.idOffset);

const nodeDetachedness = (parsed: ParsedSnapshot, index: number): number =>
  parsed.detachednessOffset >= 0
    ? readNodeField(parsed, index, parsed.detachednessOffset)
    : 0;

const buildEdgeOffsets = (parsed: ParsedSnapshot): Uint32Array => {
  if (parsed.edgeOffsets) {
    return parsed.edgeOffsets;
  }
  const offsets = new Uint32Array(parsed.nodeCount + 1);
  let cursor = 0;
  for (let index = 0; index < parsed.nodeCount; index++) {
    offsets[index] = cursor;
    cursor += readNodeField(parsed, index, parsed.edgeCountOffset);
  }
  offsets[parsed.nodeCount] = cursor;
  parsed.edgeOffsets = offsets;
  return offsets;
};

const buildReverseEdges = (
  parsed: ParsedSnapshot,
): { offsets: Uint32Array; values: Uint32Array } => {
  if (parsed.reverseEdges) {
    return parsed.reverseEdges;
  }
  const offsets = new Uint32Array(parsed.nodeCount + 1);
  for (let edge = 0; edge < parsed.edgeCount; edge++) {
    const to = parsed.edges[edge * parsed.edgeFieldCount + parsed.edgeToOffset];
    if (to >= 0 && to < parsed.nodeCount) {
      offsets[to + 1] += 1;
    }
  }
  for (let index = 1; index <= parsed.nodeCount; index++) {
    offsets[index] += offsets[index - 1];
  }
  const values = new Uint32Array(parsed.edgeCount);
  const cursor = Uint32Array.from(offsets.subarray(0, parsed.nodeCount));
  const edgeOffsets = buildEdgeOffsets(parsed);
  for (let from = 0; from < parsed.nodeCount; from++) {
    const start = edgeOffsets[from];
    const end = edgeOffsets[from + 1];
    for (let edge = start; edge < end; edge++) {
      const to =
        parsed.edges[edge * parsed.edgeFieldCount + parsed.edgeToOffset];
      if (to >= 0 && to < parsed.nodeCount) {
        values[cursor[to]] = from;
        cursor[to] += 1;
      }
    }
  }
  parsed.reverseEdges = { offsets, values };
  return parsed.reverseEdges;
};

const edgeName = (
  parsed: ParsedSnapshot,
  edgeIndex: number,
): string | number => {
  const raw =
    parsed.edges[edgeIndex * parsed.edgeFieldCount + parsed.edgeNameOffset];
  const typeIndex =
    parsed.edges[edgeIndex * parsed.edgeFieldCount + parsed.edgeTypeOffset];
  const typeName = parsed.edgeTypes[typeIndex] ?? "";
  if (typeName === "element" || typeName === "hidden") {
    return raw;
  }
  return parsed.strings[raw] ?? String(raw);
};

const buildNameMatcher = (
  pattern?: string,
): ((name: string) => boolean) | null => {
  if (!pattern) {
    return null;
  }
  if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
    try {
      const regex = new RegExp(pattern.slice(1, pattern.lastIndexOf("/")));
      return (name) => regex.test(name);
    } catch {
      // 非法正则回退子串匹配。
    }
  }
  return (name) => name.includes(pattern);
};

export const getHeapSnapshotSummary = async (
  filePath: string,
  topN = 30,
): Promise<Record<string, unknown>> => {
  const parsed = await parseSnapshotFile(filePath);
  const byName = new Map<string, { count: number; selfSize: number }>();
  const byType = new Map<string, { count: number; selfSize: number }>();
  let totalSelfSize = 0;
  let detachedCount = 0;
  for (let index = 0; index < parsed.nodeCount; index++) {
    const selfSize = nodeSelfSize(parsed, index);
    totalSelfSize += selfSize;
    const name = nodeName(parsed, index);
    const nameEntry = byName.get(name) ?? { count: 0, selfSize: 0 };
    nameEntry.count += 1;
    nameEntry.selfSize += selfSize;
    byName.set(name, nameEntry);
    const type = nodeType(parsed, index);
    const typeEntry = byType.get(type) ?? { count: 0, selfSize: 0 };
    typeEntry.count += 1;
    typeEntry.selfSize += selfSize;
    byType.set(type, typeEntry);
    if (nodeDetachedness(parsed, index) === 2) {
      detachedCount += 1;
    }
  }
  return {
    file: filePath,
    nodeCount: parsed.nodeCount,
    edgeCount: parsed.edgeCount,
    totalSelfSize,
    detachedCount,
    topConstructors: [...byName.entries()]
      .sort((left, right) => right[1].selfSize - left[1].selfSize)
      .slice(0, topN)
      .map(([name, entry]) => ({
        name,
        count: entry.count,
        selfSize: entry.selfSize,
      })),
    topTypes: [...byType.entries()]
      .sort((left, right) => right[1].selfSize - left[1].selfSize)
      .slice(0, 10)
      .map(([name, entry]) => ({
        name,
        count: entry.count,
        selfSize: entry.selfSize,
      })),
  };
};

export type HeapQuery = {
  className?: string;
  nodeType?: string;
  minSelfSize?: number;
  isDetached?: boolean;
  sortBy?: "selfSize" | "id";
  pageIdx?: number;
  pageSize?: number;
};

export const queryHeapObjects = async (
  filePath: string,
  query: HeapQuery,
): Promise<Record<string, unknown>> => {
  const parsed = await parseSnapshotFile(filePath);
  const matcher = buildNameMatcher(query.className);
  const sortBy = query.sortBy === "id" ? "id" : "selfSize";
  const pageIdx = Math.max(0, query.pageIdx ?? 0);
  const pageSize = Math.max(1, query.pageSize ?? 20);
  const rows: {
    index: number;
    id: number;
    name: string;
    type: string;
    selfSize: number;
    detachedness: number;
  }[] = [];
  let total = 0;
  let truncated = false;
  for (let index = 0; index < parsed.nodeCount; index++) {
    const name = nodeName(parsed, index);
    if (matcher && !matcher(name)) {
      continue;
    }
    if (query.nodeType && nodeType(parsed, index) !== query.nodeType) {
      continue;
    }
    const selfSize = nodeSelfSize(parsed, index);
    if (query.minSelfSize !== undefined && selfSize < query.minSelfSize) {
      continue;
    }
    const detachedness = nodeDetachedness(parsed, index);
    if (query.isDetached === true && detachedness !== 2) {
      continue;
    }
    total += 1;
    if (rows.length < MAX_QUERY_ROWS) {
      rows.push({
        index,
        id: nodeId(parsed, index),
        name,
        type: nodeType(parsed, index),
        selfSize,
        detachedness,
      });
    } else {
      truncated = true;
    }
  }
  rows.sort((left, right) =>
    sortBy === "id"
      ? left.id - right.id
      : right.selfSize - left.selfSize || left.id - right.id,
  );
  const start = pageIdx * pageSize;
  const page = rows.slice(start, start + pageSize);
  return {
    file: filePath,
    rows: page,
    total,
    pageIdx,
    pageSize,
    hasMore: start + page.length < total,
    ...(truncated
      ? {
          note: `Result set truncated at ${MAX_QUERY_ROWS} rows for memory safety; narrow the filters to see accurate ordering`,
        }
      : {}),
  };
};

const describeNode = (
  parsed: ParsedSnapshot,
  index: number,
): Record<string, unknown> => ({
  index,
  id: nodeId(parsed, index),
  name: nodeName(parsed, index),
  type: nodeType(parsed, index),
  selfSize: nodeSelfSize(parsed, index),
  edgeCount: readNodeField(parsed, index, parsed.edgeCountOffset),
  detachedness: nodeDetachedness(parsed, index),
});

export const getHeapObjectDetails = async (
  filePath: string,
  nodeIndex: number,
): Promise<Record<string, unknown>> => {
  const parsed = await parseSnapshotFile(filePath);
  if (nodeIndex < 0 || nodeIndex >= parsed.nodeCount) {
    throw new Error(
      `nodeIndex ${nodeIndex} is out of range (0-${parsed.nodeCount - 1})`,
    );
  }
  const reverse = buildReverseEdges(parsed);
  return {
    ...describeNode(parsed, nodeIndex),
    retainerCount: reverse.offsets[nodeIndex + 1] - reverse.offsets[nodeIndex],
    nodeCount: parsed.nodeCount,
  };
};

export const getHeapSnapshotEdges = async (
  filePath: string,
  nodeIndex: number,
  limit = 50,
): Promise<Record<string, unknown>> => {
  const parsed = await parseSnapshotFile(filePath);
  if (nodeIndex < 0 || nodeIndex >= parsed.nodeCount) {
    throw new Error(
      `nodeIndex ${nodeIndex} is out of range (0-${parsed.nodeCount - 1})`,
    );
  }
  const edgeOffsets = buildEdgeOffsets(parsed);
  const start = edgeOffsets[nodeIndex];
  const end = edgeOffsets[nodeIndex + 1];
  const rows: Record<string, unknown>[] = [];
  for (let edge = start; edge < Math.min(end, start + limit); edge++) {
    const typeIndex =
      parsed.edges[edge * parsed.edgeFieldCount + parsed.edgeTypeOffset];
    const to = parsed.edges[edge * parsed.edgeFieldCount + parsed.edgeToOffset];
    rows.push({
      type: parsed.edgeTypes[typeIndex] ?? String(typeIndex),
      name: edgeName(parsed, edge),
      toIndex: to,
      toName: to < parsed.nodeCount ? nodeName(parsed, to) : "?",
      toType: to < parsed.nodeCount ? nodeType(parsed, to) : "unknown",
    });
  }
  const total = end - start;
  return {
    file: filePath,
    nodeIndex,
    rows,
    total,
    hasMore: total > rows.length,
  };
};

export const getHeapSnapshotRetainers = async (
  filePath: string,
  nodeIndex: number,
  limit = 50,
): Promise<Record<string, unknown>> => {
  const parsed = await parseSnapshotFile(filePath);
  if (nodeIndex < 0 || nodeIndex >= parsed.nodeCount) {
    throw new Error(
      `nodeIndex ${nodeIndex} is out of range (0-${parsed.nodeCount - 1})`,
    );
  }
  const reverse = buildReverseEdges(parsed);
  const start = reverse.offsets[nodeIndex];
  const end = reverse.offsets[nodeIndex + 1];
  const edgeOffsets = buildEdgeOffsets(parsed);
  const rows: Record<string, unknown>[] = [];
  for (let cursor = start; cursor < Math.min(end, start + limit); cursor++) {
    const from = reverse.values[cursor];
    let edgeTypeIndex = -1;
    for (let edge = edgeOffsets[from]; edge < edgeOffsets[from + 1]; edge++) {
      const to =
        parsed.edges[edge * parsed.edgeFieldCount + parsed.edgeToOffset];
      if (to === nodeIndex) {
        edgeTypeIndex =
          parsed.edges[edge * parsed.edgeFieldCount + parsed.edgeTypeOffset];
        break;
      }
    }
    rows.push({
      ...describeNode(parsed, from),
      via: edgeTypeIndex >= 0 ? (parsed.edgeTypes[edgeTypeIndex] ?? "") : "",
    });
  }
  const total = end - start;
  return {
    file: filePath,
    nodeIndex,
    rows,
    total,
    hasMore: total > rows.length,
  };
};

const ROOT_NAME_HINTS = ["GC roots", "(Root)", "Window", "global", "Global"];

const isRootLike = (name: string): boolean =>
  ROOT_NAME_HINTS.some((hint) => name.includes(hint));

export const getHeapSnapshotRetainingPaths = async (
  filePath: string,
  nodeIndex: number,
  maxDepth = 6,
  maxPaths = 5,
): Promise<Record<string, unknown>> => {
  const parsed = await parseSnapshotFile(filePath);
  if (nodeIndex < 0 || nodeIndex >= parsed.nodeCount) {
    throw new Error(
      `nodeIndex ${nodeIndex} is out of range (0-${parsed.nodeCount - 1})`,
    );
  }
  const reverse = buildReverseEdges(parsed);
  const visited = new Uint8Array(parsed.nodeCount);
  const parent = new Map<number, number>();
  const depth = new Map<number, number>();
  const queue: number[] = [nodeIndex];
  visited[nodeIndex] = 1;
  depth.set(nodeIndex, 0);
  const paths: { nodes: Record<string, unknown>[]; reachedRoot: boolean }[] =
    [];
  let visitedCount = 0;
  while (queue.length > 0 && visitedCount < 5000 && paths.length < maxPaths) {
    const current = queue.shift() as number;
    visitedCount += 1;
    const currentDepth = depth.get(current) ?? 0;
    if (currentDepth > 0 && isRootLike(nodeName(parsed, current))) {
      const chain: number[] = [current];
      let cursor = current;
      while (parent.has(cursor)) {
        cursor = parent.get(cursor) as number;
        chain.push(cursor);
      }
      paths.push({
        nodes: chain.map((index) => describeNode(parsed, index)),
        reachedRoot: true,
      });
      continue;
    }
    if (currentDepth >= maxDepth) {
      continue;
    }
    for (
      let cursor = reverse.offsets[current];
      cursor < reverse.offsets[current + 1];
      cursor++
    ) {
      const from = reverse.values[cursor];
      if (visited[from]) {
        continue;
      }
      visited[from] = 1;
      parent.set(from, current);
      depth.set(from, currentDepth + 1);
      queue.push(from);
    }
  }
  if (paths.length === 0) {
    for (const [index, nodeDepth] of depth) {
      if (nodeDepth === maxDepth) {
        const chain: number[] = [index];
        let cursor = index;
        while (parent.has(cursor)) {
          cursor = parent.get(cursor) as number;
          chain.push(cursor);
        }
        paths.push({
          nodes: chain.map((entry) => describeNode(parsed, entry)),
          reachedRoot: false,
        });
        if (paths.length >= maxPaths) {
          break;
        }
      }
    }
  }
  return {
    file: filePath,
    nodeIndex,
    maxDepth,
    paths,
    scanned: visitedCount,
    note:
      paths.length > 0 && paths.every((entry) => !entry.reachedRoot)
        ? "No GC root reached within maxDepth; increase maxDepth for a fuller chain"
        : undefined,
  };
};

export const getHeapSnapshotDuplicateStrings = async (
  filePath: string,
  topN = 20,
): Promise<Record<string, unknown>> => {
  const parsed = await parseSnapshotFile(filePath);
  const counts = new Map<string, number>();
  for (const value of parsed.strings) {
    if (value.length >= 8) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  const duplicates = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort(
      (left, right) => right[1] * right[0].length - left[1] * left[0].length,
    )
    .slice(0, topN)
    .map(([value, count]) => ({
      value: value.length > 200 ? `${value.slice(0, 200)}…` : value,
      count,
      wastedBytes: (count - 1) * value.length,
    }));
  const totalWasted = duplicates.reduce(
    (sum, entry) => sum + entry.wastedBytes,
    0,
  );
  return {
    file: filePath,
    stringCount: parsed.strings.length,
    duplicates,
    topWastedBytes: totalWasted,
  };
};

const aggregateByName = (
  parsed: ParsedSnapshot,
): Map<string, { count: number; selfSize: number }> => {
  const byName = new Map<string, { count: number; selfSize: number }>();
  for (let index = 0; index < parsed.nodeCount; index++) {
    const name = nodeName(parsed, index);
    const entry = byName.get(name) ?? { count: 0, selfSize: 0 };
    entry.count += 1;
    entry.selfSize += nodeSelfSize(parsed, index);
    byName.set(name, entry);
  }
  return byName;
};

export const compareHeapSnapshots = async (
  baseFilePath: string,
  currentFilePath: string,
  topN = 30,
): Promise<Record<string, unknown>> => {
  const base = await parseSnapshotFile(baseFilePath);
  const current = await parseSnapshotFile(currentFilePath);
  const baseAgg = aggregateByName(base);
  const currentAgg = aggregateByName(current);
  const names = new Set([...baseAgg.keys(), ...currentAgg.keys()]);
  const diffs: {
    name: string;
    deltaCount: number;
    deltaSelfSize: number;
    baseCount: number;
    currentCount: number;
  }[] = [];
  for (const name of names) {
    const baseEntry = baseAgg.get(name) ?? { count: 0, selfSize: 0 };
    const currentEntry = currentAgg.get(name) ?? { count: 0, selfSize: 0 };
    const deltaCount = currentEntry.count - baseEntry.count;
    const deltaSelfSize = currentEntry.selfSize - baseEntry.selfSize;
    if (deltaCount !== 0 || deltaSelfSize !== 0) {
      diffs.push({
        name,
        deltaCount,
        deltaSelfSize,
        baseCount: baseEntry.count,
        currentCount: currentEntry.count,
      });
    }
  }
  diffs.sort(
    (left, right) =>
      Math.abs(right.deltaSelfSize) - Math.abs(left.deltaSelfSize),
  );
  return {
    baseFile: baseFilePath,
    currentFile: currentFilePath,
    base: { nodeCount: base.nodeCount, edgeCount: base.edgeCount },
    current: { nodeCount: current.nodeCount, edgeCount: current.edgeCount },
    growth: diffs.filter((entry) => entry.deltaSelfSize > 0).slice(0, topN),
    shrink: diffs
      .filter((entry) => entry.deltaSelfSize < 0)
      .sort((left, right) => left.deltaSelfSize - right.deltaSelfSize)
      .slice(0, topN),
  };
};
