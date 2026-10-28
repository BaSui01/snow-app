// 输入区 WorkFlow 手动编排器的发送载荷（纯函数，无 React 依赖）。
//
// 编排图由用户画好，不再经模型转交：发送时直接落库一条用户消息（折叠的
// @@workflow 标签 + 备注）和一条带 workflow-workflow-generate 调用的助手消息，
// 复用既有 WorkflowToolCall 卡片、执行与结算链路。

import {
  encodeWorkflowTag,
  parseContentSegments,
  type WorkflowTag,
} from "../fileTagUtils";
import type { WorkflowComposerGraph } from "../types";

export const WORKFLOW_GENERATE_TOOL_NAME = "workflow-workflow-generate";

/** 节点 prompt 在概要里的截断长度。 */
const OUTLINE_PROMPT_MAX_CHARS = 120;

/** `workflow-workflow-generate` 工具的参数结构（与 Rust 侧校验保持一致）。 */
export type WorkflowGenerateArgs = {
  title: string;
  nodes: {
    id: string;
    name: string;
    label: string;
    prompt: string;
    description: string;
    apiProfile: string;
    model: string;
  }[];
  edges: { source: string; target: string }[];
};

/**
 * 把编排器画布的图转成 `workflow-workflow-generate` 的工具参数：
 * - 节点：`name` 缺省用 label 兜底（空 label 时用 id），可选字段填空字符串；
 * - 边：丢弃端点不存在的边、自环边与重复边，保持原有顺序。
 */
export function toWorkflowGenerateArgs(
  graph: WorkflowComposerGraph,
): WorkflowGenerateArgs {
  const nodes = graph.nodes.map((node) => ({
    id: node.id,
    name: node.label || node.id,
    label: node.label,
    prompt: node.prompt,
    description: node.description ?? "",
    apiProfile: node.apiProfile ?? "",
    model: node.model ?? "",
  }));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const seenEdges = new Set<string>();
  const edges = graph.edges.filter((edge) => {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      return false;
    }
    if (edge.source === edge.target) {
      return false;
    }
    const key = `${edge.source}->${edge.target}`;
    if (seenEdges.has(key)) {
      return false;
    }
    seenEdges.add(key);
    return true;
  });
  return { title: graph.title ?? "", nodes, edges };
}

/** 节点清单：`序号. 名称 <- 上游` + 缩进的 prompt 摘要（单行截断）。 */
const buildWorkflowOutline = (args: WorkflowGenerateArgs): string => {
  const nameById = new Map(args.nodes.map((node) => [node.id, node.name]));
  return args.nodes
    .map((node, index) => {
      const upstream = args.edges
        .filter((edge) => edge.target === node.id)
        .map((edge) => nameById.get(edge.source) ?? edge.source);
      const head = `${index + 1}. ${node.name}${
        upstream.length > 0 ? ` <- ${upstream.join(", ")}` : ""
      }`;
      const prompt = node.prompt.replace(/\s+/g, " ").trim();
      if (!prompt) {
        return head;
      }
      const clipped =
        prompt.length > OUTLINE_PROMPT_MAX_CHARS
          ? `${prompt.slice(0, OUTLINE_PROMPT_MAX_CHARS)}…`
          : prompt;
      return `${head}\n   ${clipped}`;
    })
    .join("\n");
};

/** 编排图对应的折叠标签数据。 */
export const buildWorkflowTag = (graph: WorkflowComposerGraph): WorkflowTag => {
  const args = toWorkflowGenerateArgs(graph);
  return {
    title: args.title.trim(),
    nodeCount: args.nodes.length,
    edgeCount: args.edges.length,
    outline: buildWorkflowOutline(args),
    graphJson: JSON.stringify(snapshotComposerGraph(graph)),
  };
};

/** 标签快照：去掉空字段，保留节点坐标，便于回滚还原画布。 */
const snapshotComposerGraph = (
  graph: WorkflowComposerGraph,
): WorkflowComposerGraph => ({
  title: graph.title.trim(),
  nodes: graph.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    prompt: node.prompt,
    ...(node.description ? { description: node.description } : {}),
    ...(node.apiProfile ? { apiProfile: node.apiProfile } : {}),
    ...(node.model ? { model: node.model } : {}),
    ...(node.position ? { position: node.position } : {}),
  })),
  edges: graph.edges.map((edge) => ({
    source: edge.source,
    target: edge.target,
  })),
});

/** 解析标签快照；结构不符时返回 null。 */
const parseComposerGraphSnapshot = (
  raw: string,
): WorkflowComposerGraph | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const source = parsed as {
    title?: unknown;
    nodes?: unknown;
    edges?: unknown;
  };
  const nodes: WorkflowComposerGraph["nodes"] = [];
  for (const item of Array.isArray(source.nodes) ? source.nodes : []) {
    if (!item || typeof item !== "object") continue;
    const node = item as Record<string, unknown>;
    const id = typeof node.id === "string" ? node.id : "";
    if (!id) continue;
    const position =
      node.position &&
      typeof node.position === "object" &&
      typeof (node.position as { x?: unknown }).x === "number" &&
      typeof (node.position as { y?: unknown }).y === "number"
        ? {
            x: (node.position as { x: number }).x,
            y: (node.position as { y: number }).y,
          }
        : undefined;
    nodes.push({
      id,
      label: typeof node.label === "string" ? node.label : id,
      prompt: typeof node.prompt === "string" ? node.prompt : "",
      ...(typeof node.description === "string" && node.description
        ? { description: node.description }
        : {}),
      ...(typeof node.apiProfile === "string"
        ? { apiProfile: node.apiProfile }
        : {}),
      ...(typeof node.model === "string" ? { model: node.model } : {}),
      ...(position ? { position } : {}),
    });
  }
  if (nodes.length === 0) {
    return null;
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: WorkflowComposerGraph["edges"] = [];
  for (const item of Array.isArray(source.edges) ? source.edges : []) {
    if (!item || typeof item !== "object") continue;
    const edge = item as Record<string, unknown>;
    const edgeSource = typeof edge.source === "string" ? edge.source : "";
    const edgeTarget = typeof edge.target === "string" ? edge.target : "";
    if (
      !nodeIds.has(edgeSource) ||
      !nodeIds.has(edgeTarget) ||
      edgeSource === edgeTarget
    ) {
      continue;
    }
    edges.push({ source: edgeSource, target: edgeTarget });
  }
  return {
    title: typeof source.title === "string" ? source.title : "",
    nodes,
    edges,
  };
};

/**
 * 从一条已发送的用户消息内容里还原编排图与备注（回滚编排提交时用）。
 * 内容里没有 `@@workflow` 标签时返回 null；旧数据缺少图快照时 graph 为 null，
 * 调用方只回填备注（绝不把标签原文塞进输入框）。
 */
export function parseWorkflowComposerContent(
  content: string,
): { graph: WorkflowComposerGraph | null; note: string } | null {
  let graph: WorkflowComposerGraph | null = null;
  let hasWorkflowTag = false;
  const noteParts: string[] = [];
  for (const segment of parseContentSegments(content)) {
    if (segment.type === "text") {
      const text = segment.content.trim();
      if (text) noteParts.push(text);
    } else if (segment.type === "workflow") {
      hasWorkflowTag = true;
      if (!graph && segment.tag.graphJson) {
        graph = parseComposerGraphSnapshot(segment.tag.graphJson);
      }
    }
  }
  if (!hasWorkflowTag) {
    return null;
  }
  return { graph, note: noteParts.join("\n").trim() };
}

/** 写入会话的用户消息：折叠标签在前，备注（可空）另起一行。 */
export function buildWorkflowComposerContent(
  graph: WorkflowComposerGraph,
  note: string,
): string {
  const tag = encodeWorkflowTag(buildWorkflowTag(graph));
  const trimmedNote = note.trim();
  return trimmedNote ? `${tag}\n${trimmedNote}` : tag;
}

/** 合成工具调用的参数 JSON。 */
export const buildWorkflowGenerateArgumentsJson = (
  graph: WorkflowComposerGraph,
): string => JSON.stringify(toWorkflowGenerateArgs(graph));
