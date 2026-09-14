import type {
  SnowRemoteWorkflow,
  SnowRemoteWorkflowNode,
  SnowRemoteWorkflowNodeStatus,
} from "../renderer/types/remoteControl";
import { t } from "./i18n";
import { iconMarkup, type MobileIconName } from "./icons";

/**
 * WorkFlow 画布（移动端）：与桌面 React Flow 画布语义一致，但不引入 React ——
 * 节点是绝对定位的 HTML 按钮，连线是同一变换层内的 SVG 贝塞尔曲线。
 *
 * - 布局：按边做分层（最长路径）自动排布，列 = 深度、行 = 同层顺序；节点可在
 *   画布内拖动调整，但只改本地视图（不回写桌面画布：桌面卡片的防抖落盘会与
 *   远端写入互相覆盖，桌面端仍是画布布局的唯一持久化来源）；
 * - 手势：空白处拖动平移、双指捏合缩放、轻点空白两次或点按钮「适应视图」回到
 *   全览；拖动 / 缩放发生后短时间内抑制点击，避免误跳节点会话；
 * - 状态：卡片元素在时间线重建与轮询之间复用，画布视图（平移 / 缩放 / 拖动
 *   结果）挂在元素上，不因进度刷新跳回原样。
 */

const SVG_NS = "http://www.w3.org/2000/svg";
/** 节点尺寸（图坐标；外观规则在 CSS，实际尺寸由本模块内联写入）。 */
const NODE_WIDTH = 150;
const NODE_HEIGHT = 74;
/** 分层布局的列 / 行间距。 */
const COLUMN_GAP = 196;
const ROW_GAP = 92;
/** 画布内容四周留白（用于连线与阴影）。 */
const CANVAS_PADDING = 33;
/** 适应视图的缩放下限（再小文字不可读，宁可让用户手动平移）。 */
const MIN_FIT_SCALE = 0.5;
const MIN_SCALE = 0.3;
const MAX_SCALE = 2;
/** 位移超过该值（px）视为拖动而非点击。 */
const DRAG_THRESHOLD = 8;
/** 拖动 / 缩放结束后抑制点击的时长。 */
const TAP_SUPPRESS_MS = 250;
/** 轻点空白处两次（适应视图）的判定间隔。 */
const DOUBLE_TAP_MS = 300;

const NODE_STATUS_ICONS: Record<SnowRemoteWorkflowNodeStatus, MobileIconName> =
  {
    pending: "circle",
    running: "loader-circle",
    completed: "circle-check",
    failed: "circle-x",
  };

type Point = { x: number; y: number };
type EdgeItem = { source: string; target: string };

type CanvasBounds = {
  minX: number;
  minY: number;
  width: number;
  height: number;
};

type CanvasState = {
  /** 节点 id → 图坐标（分层布局基线；拖动在本地覆盖）。 */
  positions: Map<string, Point>;
  /** 节点集合签名：变化时重建布局、节点元素与连线元素。 */
  nodeSignature: string;
  nodes: SnowRemoteWorkflowNode[];
  edges: EdgeItem[];
  nodeEls: Map<string, HTMLButtonElement>;
  edgeEls: Map<string, SVGPathElement>;
  view: { k: number; tx: number; ty: number };
  /** 需要重新计算「适应视图」（首帧 / 节点集合变化）。 */
  needsFit: boolean;
};

type Gesture = {
  mode: "pan" | "node" | "pinch";
  pointers: Map<number, Point>;
  startPointer: Point;
  startView: { k: number; tx: number; ty: number };
  /** 拖动节点：起始位置（图坐标）。 */
  node?: { nodeId: string; position: Point };
  pinch?: { distance: number; view: { k: number; tx: number; ty: number } };
  moved: boolean;
  lastBackgroundTapAt: number;
};

const canvasStates = new WeakMap<HTMLElement, CanvasState>();
const canvasGestures = new WeakMap<HTMLElement, Gesture>();
/** 进行中的手势所在画布：window 级 move / up 监听按此派发。 */
const activeCanvases = new Set<HTMLElement>();
let windowPointerTrackingBound = false;
let suppressTapUntil = 0;
let markerSeq = 0;

/** 画布刚平移 / 缩放 / 拖动过：抑制随后触发的 click（避免误跳节点会话）。 */
export const isCanvasTapSuppressed = (): boolean =>
  performance.now() < suppressTapUntil;

/**
 * 手势期间在 window 上跟踪指针，而不是 setPointerCapture —— 指针捕获会把
 * 后续兼容鼠标事件（含 click）重定向到画布本身，节点与画布内按钮的点击会
 * 失效。触摸指针自带隐式捕获，鼠标拖出画布也能靠 window 监听继续跟手。
 */
const ensureWindowPointerTracking = (): void => {
  if (windowPointerTrackingBound) return;
  windowPointerTrackingBound = true;
  window.addEventListener("pointermove", (event) => {
    for (const canvas of activeCanvases) {
      handlePointerMove(canvas, event);
    }
  });
  const end = (event: PointerEvent): void => {
    for (const canvas of [...activeCanvases]) {
      handlePointerEnd(canvas, event);
    }
  };
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * 分层布局：depth = 到该节点的最长路径长度（无前驱为 0），列 = depth、
 * 行 = 同层内按快照顺序（桥已按拓扑序下发），同层整体垂直居中。
 * 环内节点被深度上限截断（与 runner 的降级行为一致，不会死循环）。
 */
const layoutNodes = (
  nodes: SnowRemoteWorkflowNode[],
  edges: EdgeItem[],
): Map<string, Point> => {
  const positions = new Map<string, Point>();
  if (nodes.length === 0) {
    return positions;
  }
  const ids = new Set(nodes.map((node) => node.id));
  const validEdges = edges.filter(
    (edge) =>
      ids.has(edge.source) &&
      ids.has(edge.target) &&
      edge.source !== edge.target,
  );
  const depth = new Map<string, number>(nodes.map((node) => [node.id, 0]));
  for (let round = 0; round < nodes.length; round += 1) {
    let changed = false;
    for (const edge of validEdges) {
      const next = (depth.get(edge.source) ?? 0) + 1;
      if (next <= nodes.length && next > (depth.get(edge.target) ?? 0)) {
        depth.set(edge.target, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const columns = new Map<number, string[]>();
  for (const node of nodes) {
    const column = depth.get(node.id) ?? 0;
    const bucket = columns.get(column);
    if (bucket) {
      bucket.push(node.id);
    } else {
      columns.set(column, [node.id]);
    }
  }
  const maxRows = Math.max(
    1,
    ...[...columns.values()].map((bucket) => bucket.length),
  );
  for (const [column, bucket] of columns) {
    const offset = ((maxRows - bucket.length) * ROW_GAP) / 2;
    bucket.forEach((nodeId, index) => {
      positions.set(nodeId, {
        x: column * COLUMN_GAP,
        y: offset + index * ROW_GAP,
      });
    });
  }
  return positions;
};

const computeBounds = (state: CanvasState): CanvasBounds => {
  let minX = 0;
  let minY = 0;
  let maxX = NODE_WIDTH;
  let maxY = NODE_HEIGHT;
  let first = true;
  for (const position of state.positions.values()) {
    if (first) {
      minX = position.x;
      minY = position.y;
      maxX = position.x + NODE_WIDTH;
      maxY = position.y + NODE_HEIGHT;
      first = false;
      continue;
    }
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
    maxX = Math.max(maxX, position.x + NODE_WIDTH);
    maxY = Math.max(maxY, position.y + NODE_HEIGHT);
  }
  return {
    minX: minX - CANVAS_PADDING,
    minY: minY - CANVAS_PADDING,
    width: maxX - minX + CANVAS_PADDING * 2,
    height: maxY - minY + CANVAS_PADDING * 2,
  };
};

/** 连线路径：源节点右中 → 目标节点左中的三次贝塞尔（与桌面画布同形）。 */
const edgePath = (source: Point, target: Point): string => {
  const x1 = source.x + NODE_WIDTH;
  const y1 = source.y + NODE_HEIGHT / 2;
  const x2 = target.x;
  const y2 = target.y + NODE_HEIGHT / 2;
  const curve = Math.max(26, Math.abs(x2 - x1) * 0.5);
  return `M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`;
};

/** 连线状态：目标运行中 = 流动（虚线动画），源已完成 = 完成色。 */
const edgeStatusClass = (
  source: SnowRemoteWorkflowNode | undefined,
  target: SnowRemoteWorkflowNode | undefined,
): string => {
  if (target?.status === "running") return "is-running";
  if (source?.status === "completed") return "is-done";
  return "is-idle";
};

const edgeElementId = (edge: EdgeItem): string =>
  `${edge.source}\u0001${edge.target}`;

// ── 元素构建 ──────────────────────────────────────────────────────────────

const createNodeEl = (node: SnowRemoteWorkflowNode): HTMLButtonElement => {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "workflow-canvas-node";
  el.dataset.nodeId = node.id;
  el.style.width = `${NODE_WIDTH}px`;
  el.style.height = `${NODE_HEIGHT}px`;
  const head = document.createElement("span");
  head.className = "workflow-canvas-node-head";
  const icon = document.createElement("span");
  icon.className = "workflow-canvas-node-icon";
  const label = document.createElement("span");
  label.className = "workflow-canvas-node-label";
  head.append(icon, label);
  const desc = document.createElement("span");
  desc.className = "workflow-canvas-node-desc";
  el.append(head, desc);
  return el;
};

const patchNodeEl = (
  el: HTMLButtonElement,
  node: SnowRemoteWorkflowNode,
): void => {
  el.className = `workflow-canvas-node is-${node.status}`;
  const icon = el.querySelector(".workflow-canvas-node-icon");
  if (icon) icon.innerHTML = iconMarkup(NODE_STATUS_ICONS[node.status]);
  const label = el.querySelector(".workflow-canvas-node-label");
  if (label) label.textContent = node.label;
  const desc = el.querySelector<HTMLElement>(".workflow-canvas-node-desc");
  if (desc) {
    const failed = node.status === "failed" && Boolean(node.errorMessage);
    const text = failed ? node.errorMessage : node.description;
    desc.textContent = text;
    desc.classList.toggle("is-error", failed);
    desc.hidden = !text;
  }
  const linked = Boolean(node.conversationId);
  if (linked) {
    el.dataset.conversationId = node.conversationId;
  } else {
    delete el.dataset.conversationId;
  }
  el.classList.toggle("is-linked", linked);
  el.setAttribute("aria-disabled", linked ? "false" : "true");
  const dependencies = node.dependsOn.length
    ? `；${t("remote.workflow.dependsOn", {
        names: node.dependsOn.join(t("remote.listSeparator")),
      })}`
    : "";
  const title = `${node.label}${dependencies}`;
  el.title = title;
  el.setAttribute(
    "aria-label",
    linked ? `${title} · ${t("remote.workflow.nodeOpen")}` : title,
  );
  // 未创建会话的节点不可跳转：用 aria-disabled 表达，不能用 disabled ——
  // 禁用按钮不派发指针事件，会让节点无法在画布内拖动。
};

const createEdgeEl = (markerId: string): SVGPathElement => {
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("class", "workflow-edge is-idle");
  path.setAttribute("marker-end", `url(#${markerId})`);
  return path;
};

const createArrowMarker = (markerId: string): SVGMarkerElement => {
  const marker = document.createElementNS(SVG_NS, "marker");
  marker.setAttribute("id", markerId);
  marker.setAttribute("markerWidth", "10");
  marker.setAttribute("markerHeight", "10");
  marker.setAttribute("refX", "9");
  marker.setAttribute("refY", "3");
  marker.setAttribute("orient", "auto");
  marker.setAttribute("markerUnits", "userSpaceOnUse");
  const arrow = document.createElementNS(SVG_NS, "path");
  arrow.setAttribute("class", "workflow-edge-arrow");
  arrow.setAttribute("d", "M0,0 L6,3 L0,6 Z");
  marker.append(arrow);
  return marker;
};

// ── 渲染 ──────────────────────────────────────────────────────────────────

const applyView = (canvas: HTMLElement): void => {
  const state = canvasStates.get(canvas);
  const viewport = canvas.querySelector<HTMLElement>(
    ".workflow-canvas-viewport",
  );
  if (!state || !viewport) return;
  const { k, tx, ty } = state.view;
  viewport.style.transform = `translate(${tx}px, ${ty}px) scale(${k})`;
};

/** 节点位置 + 连线几何 + 连线层包围盒（节点拖动后同步更新）。 */
const applyGeometry = (canvas: HTMLElement): void => {
  const state = canvasStates.get(canvas);
  if (!state) return;
  for (const node of state.nodes) {
    const position = state.positions.get(node.id);
    const el = state.nodeEls.get(node.id);
    if (position && el) {
      el.style.left = `${position.x}px`;
      el.style.top = `${position.y}px`;
    }
  }
  const svg = canvas.querySelector<SVGSVGElement>(".workflow-canvas-edges");
  if (svg) {
    const bounds = computeBounds(state);
    svg.style.left = `${bounds.minX}px`;
    svg.style.top = `${bounds.minY}px`;
    svg.style.width = `${bounds.width}px`;
    svg.style.height = `${bounds.height}px`;
    svg.setAttribute(
      "viewBox",
      `${bounds.minX} ${bounds.minY} ${bounds.width} ${bounds.height}`,
    );
  }
  const nodeById = new Map(state.nodes.map((node) => [node.id, node]));
  for (const edge of state.edges) {
    const path = state.edgeEls.get(edgeElementId(edge));
    const source = state.positions.get(edge.source);
    const target = state.positions.get(edge.target);
    if (!path || !source || !target) continue;
    path.setAttribute("d", edgePath(source, target));
    path.setAttribute(
      "class",
      `workflow-edge ${edgeStatusClass(
        nodeById.get(edge.source),
        nodeById.get(edge.target),
      )}`,
    );
  }
};

/** 节点集合变化：重建节点元素与连线元素（顺序与快照一致）。 */
const rebuildElements = (canvas: HTMLElement, state: CanvasState): void => {
  const viewport = canvas.querySelector<HTMLElement>(
    ".workflow-canvas-viewport",
  );
  const svg = canvas.querySelector<SVGSVGElement>(".workflow-canvas-edges");
  if (!viewport || !svg) return;
  const markerId = svg.dataset.markerId ?? "";
  state.nodeEls.clear();
  state.edgeEls.clear();
  viewport
    .querySelectorAll(".workflow-canvas-node")
    .forEach((el) => el.remove());
  svg.querySelectorAll(".workflow-edge").forEach((el) => el.remove());
  for (const node of state.nodes) {
    const el = createNodeEl(node);
    patchNodeEl(el, node);
    viewport.append(el);
    state.nodeEls.set(node.id, el);
  }
  for (const edge of state.edges) {
    const path = createEdgeEl(markerId);
    svg.append(path);
    state.edgeEls.set(edgeElementId(edge), path);
  }
};

/** 节点状态 / 文本变化（节点集合未变）：原地更新，不重建元素。 */
const patchElements = (state: CanvasState): void => {
  for (const node of state.nodes) {
    const el = state.nodeEls.get(node.id);
    if (el) patchNodeEl(el, node);
  }
};

/** 适应视图：整图缩放到视口内（缩放下限保证文字可读），并居中。 */
export const fitWorkflowCanvas = (canvas: HTMLElement): void => {
  const state = canvasStates.get(canvas);
  if (!state || state.positions.size === 0) return;
  const viewportWidth = canvas.clientWidth;
  const viewportHeight = canvas.clientHeight;
  if (!viewportWidth || !viewportHeight) return;
  const bounds = computeBounds(state);
  const scale = clamp(
    Math.min(viewportWidth / bounds.width, viewportHeight / bounds.height) *
      0.96,
    MIN_FIT_SCALE,
    1,
  );
  state.view.k = scale;
  state.view.tx =
    (viewportWidth - bounds.width * scale) / 2 - bounds.minX * scale;
  state.view.ty =
    (viewportHeight - bounds.height * scale) / 2 - bounds.minY * scale;
  applyView(canvas);
};

/**
 * 创建画布骨架（节点 / 连线元素由 patchWorkflowCanvas 填充）。
 * 调用方插入 DOM 后再 patch —— 首帧适应视图依赖元素已有尺寸。
 */
export const createWorkflowCanvas = (): HTMLElement => {
  const canvas = document.createElement("div");
  canvas.className = "workflow-canvas";
  const viewport = document.createElement("div");
  viewport.className = "workflow-canvas-viewport";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "workflow-canvas-edges");
  const markerId = `wf-arrow-${(markerSeq += 1)}`;
  svg.dataset.markerId = markerId;
  const defs = document.createElementNS(SVG_NS, "defs");
  defs.append(createArrowMarker(markerId));
  svg.append(defs);
  viewport.append(svg);
  const fitButton = document.createElement("button");
  fitButton.type = "button";
  fitButton.className = "workflow-canvas-fit";
  fitButton.dataset.workflowFit = "1";
  fitButton.innerHTML = iconMarkup("maximize");
  fitButton.title = t("remote.workflow.fitView");
  fitButton.setAttribute("aria-label", t("remote.workflow.fitView"));
  const empty = document.createElement("div");
  empty.className = "workflow-canvas-empty";
  empty.textContent = t("remote.workflow.empty");
  empty.hidden = true;
  canvas.append(viewport, fitButton, empty);

  canvasStates.set(canvas, {
    positions: new Map(),
    nodeSignature: "",
    nodes: [],
    edges: [],
    nodeEls: new Map(),
    edgeEls: new Map(),
    view: { k: 1, tx: 0, ty: 0 },
    needsFit: true,
  });
  bindGestures(canvas);
  return canvas;
};

/** 用快照刷新画布：节点集合变化时重建并重新适应视图，否则只更新状态。 */
export const patchWorkflowCanvas = (
  canvas: HTMLElement,
  workflow: SnowRemoteWorkflow,
): void => {
  const state = canvasStates.get(canvas);
  if (!state) return;
  // 集合签名对顺序不敏感：只有节点集合真的变化才重建布局与节点元素。
  // 拓扑序由远端（Rust）下发，顺序抖动不该让用户眼前的节点位置互换。
  const nodeSignature = [...workflow.nodes.map((node) => node.id)]
    .sort()
    .join("|");
  state.nodes = workflow.nodes;
  state.edges = workflow.edges;
  if (state.nodeSignature !== nodeSignature) {
    state.nodeSignature = nodeSignature;
    state.positions = layoutNodes(workflow.nodes, workflow.edges);
    state.needsFit = true;
    rebuildElements(canvas, state);
  } else {
    patchElements(state);
  }
  applyGeometry(canvas);
  applyView(canvas);
  const empty = canvas.querySelector<HTMLElement>(".workflow-canvas-empty");
  if (empty) empty.hidden = workflow.nodes.length > 0;
  if (state.needsFit) {
    state.needsFit = false;
    // 首帧 / 重建后元素刚插入，尺寸要在下一帧才可读。
    requestAnimationFrame(() => fitWorkflowCanvas(canvas));
  }
};

// ── 手势 ──────────────────────────────────────────────────────────────────

const localPoint = (canvas: HTMLElement, event: PointerEvent): Point => {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
};

const applyPinch = (
  canvas: HTMLElement,
  gesture: Gesture,
  state: CanvasState,
): void => {
  const points = [...gesture.pointers.values()];
  if (points.length < 2 || !gesture.pinch) return;
  const [a, b] = points;
  const distance = Math.hypot(a.x - b.x, a.y - b.y);
  const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const ratio =
    gesture.pinch.distance > 0 ? distance / gesture.pinch.distance : 1;
  const origin = gesture.pinch.view;
  const k = clamp(origin.k * ratio, MIN_SCALE, MAX_SCALE);
  // 以捏合中点为锚点缩放：中点下的图坐标保持不动。
  const graphX = (midpoint.x - origin.tx) / origin.k;
  const graphY = (midpoint.y - origin.ty) / origin.k;
  state.view.k = k;
  state.view.tx = midpoint.x - graphX * k;
  state.view.ty = midpoint.y - graphY * k;
  gesture.moved = true;
  applyView(canvas);
};

/** 手势收尾：按剩余指针数决定重新开始平移或清理状态。 */
const finishGesture = (canvas: HTMLElement, gesture: Gesture): void => {
  if (gesture.moved) {
    suppressTapUntil = performance.now() + TAP_SUPPRESS_MS;
  }
  gesture.node = undefined;
  gesture.pinch = undefined;
  if (gesture.pointers.size === 0) {
    gesture.mode = "pan";
    canvas.classList.remove("is-interacting");
    return;
  }
  const state = canvasStates.get(canvas);
  const only = [...gesture.pointers.values()][0];
  gesture.mode = "pan";
  gesture.startPointer = only;
  gesture.startView = { ...(state?.view ?? { k: 1, tx: 0, ty: 0 }) };
};

const handlePointerMove = (canvas: HTMLElement, event: PointerEvent): void => {
  const state = canvasStates.get(canvas);
  const gesture = canvasGestures.get(canvas);
  if (!state || !gesture || !gesture.pointers.has(event.pointerId)) return;
  const point = localPoint(canvas, event);
  gesture.pointers.set(event.pointerId, point);
  if (gesture.mode === "pinch") {
    applyPinch(canvas, gesture, state);
    return;
  }
  const dx = point.x - gesture.startPointer.x;
  const dy = point.y - gesture.startPointer.y;
  if (Math.hypot(dx, dy) > DRAG_THRESHOLD) {
    gesture.moved = true;
    canvas.classList.add("is-interacting");
  }
  if (gesture.mode === "node" && gesture.node) {
    // 节点拖动：位移换算回图坐标（受当前缩放影响），只改本地视图。
    state.positions.set(gesture.node.nodeId, {
      x: gesture.node.position.x + dx / state.view.k,
      y: gesture.node.position.y + dy / state.view.k,
    });
    applyGeometry(canvas);
    return;
  }
  state.view.tx = gesture.startView.tx + dx;
  state.view.ty = gesture.startView.ty + dy;
  applyView(canvas);
};

const handlePointerEnd = (canvas: HTMLElement, event: PointerEvent): void => {
  const gesture = canvasGestures.get(canvas);
  if (!gesture || !gesture.pointers.has(event.pointerId)) return;
  const wasBackgroundTap =
    gesture.mode === "pan" && !gesture.moved && gesture.pointers.size === 1;
  gesture.pointers.delete(event.pointerId);
  if (wasBackgroundTap && event.type === "pointerup") {
    // 轻点空白处连续两次 = 适应视图（与按钮等效）。
    const now = performance.now();
    if (now - gesture.lastBackgroundTapAt < DOUBLE_TAP_MS) {
      gesture.lastBackgroundTapAt = 0;
      fitWorkflowCanvas(canvas);
    } else {
      gesture.lastBackgroundTapAt = now;
    }
  }
  finishGesture(canvas, gesture);
  if (gesture.pointers.size === 0) {
    activeCanvases.delete(canvas);
  }
};

const handlePointerDown = (canvas: HTMLElement, event: PointerEvent): void => {
  const state = canvasStates.get(canvas);
  if (!state) return;
  let gesture = canvasGestures.get(canvas);
  if (!gesture) {
    gesture = {
      mode: "pan",
      pointers: new Map(),
      startPointer: { x: 0, y: 0 },
      startView: { ...state.view },
      moved: false,
      lastBackgroundTapAt: 0,
    };
    canvasGestures.set(canvas, gesture);
  }
  const point = localPoint(canvas, event);
  gesture.pointers.set(event.pointerId, point);
  if (gesture.pointers.size === 1) {
    gesture.mode = "pan";
    gesture.node = undefined;
    gesture.pinch = undefined;
    gesture.moved = false;
    gesture.startPointer = point;
    gesture.startView = { ...state.view };
    const nodeEl = (event.target as HTMLElement).closest<HTMLElement>(
      ".workflow-canvas-node",
    );
    const nodeId = nodeEl?.dataset.nodeId ?? "";
    const position = nodeId ? state.positions.get(nodeId) : undefined;
    if (nodeId && position) {
      // 从节点上开始拖动 = 移动节点（其余位置 = 平移画布）。
      gesture.mode = "node";
      gesture.node = { nodeId, position: { ...position } };
    }
  } else if (gesture.pointers.size === 2) {
    gesture.mode = "pinch";
    gesture.node = undefined;
    const [a, b] = [...gesture.pointers.values()];
    gesture.pinch = {
      distance: Math.hypot(a.x - b.x, a.y - b.y),
      view: { ...state.view },
    };
    gesture.moved = true;
  }
  activeCanvases.add(canvas);
  ensureWindowPointerTracking();
};

const bindGestures = (canvas: HTMLElement): void => {
  canvas.addEventListener("pointerdown", (event) => {
    handlePointerDown(canvas, event);
  });
};
