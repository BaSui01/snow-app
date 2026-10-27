// 输入区 WorkFlow 手动编排器的发送载荷（纯函数，无 React 依赖）。
//
// 现有 IPC 没有「追加 assistant 消息 / 合成 tool call」的能力，因此手动编排
// 的图不能凭空注入一条带工具调用的助手消息。这里的做法是：把编排图作为
// 结构化 JSON 载荷内嵌进本次用户消息文本，并在本回合强制启用 WorkFlow 模式，
// 让模型把载荷原样交给 `workflow-workflow-generate` 工具——从而完全复用既有
// 的 WorkflowToolCall 卡片、runner、落库与结算链路。

import type { WorkflowComposerGraph, WorkflowComposerNode } from "../types";

/** 用户消息里包裹编排载荷的标签名（开闭标签成对出现）。 */
export const WORKFLOW_COMPOSER_TAG = "workflow-composer";

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
 * - 边：丢弃端点不存在的边、自环边与重复边，保持原有顺序；
 * - `title` 为空时回退为空字符串（与 `parseWorkflowGraph` 的口径一致）。
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

/**
 * 生成随用户消息发送的编排提交文本：一段中英双语指令 + 载荷块（+ 可选备注）。
 * 指令文本是给模型看的（不参与 i18n），标签内必须是合法 JSON。
 */
export function buildWorkflowComposerMessage(
  graph: WorkflowComposerGraph,
  note: string,
): string {
  const payload = JSON.stringify(toWorkflowGenerateArgs(graph), null, 2);
  const lines = [
    "用户已使用聊天输入区的 WorkFlow 编排器手动绘制好本流程，下面的编排图必须原样提交。",
    "The user has already drawn this workflow with the WorkFlow composer; submit the graph below verbatim.",
    "",
    `请把下方 ${WORKFLOW_COMPOSER_TAG} 载荷块内的 JSON 原样作为 workflow-workflow-generate 的参数传入：不要重新设计流程，不要增删节点，不要改动任何节点的 prompt / model / 依赖关系，也不要改变节点顺序。`,
    "Submit the JSON below verbatim via the workflow-workflow-generate tool. Do not redesign, add, remove, or reorder nodes, and do not modify any node prompt, model, or dependency.",
    "",
    "本回合只调用 workflow-workflow-generate，不要调用其它任何工具；工具返回后按工具结果继续（等待用户在卡片上确认执行，或按用户的修改意见重新提交）。",
    "In this turn call only workflow-workflow-generate — no other tools. After the tool returns, follow the tool result: wait for the user to confirm execution on the card, or resubmit according to the user's feedback.",
    "",
    `<${WORKFLOW_COMPOSER_TAG}>`,
    payload,
    `</${WORKFLOW_COMPOSER_TAG}>`,
  ];
  const trimmedNote = note.trim();
  if (trimmedNote) {
    lines.push("", `用户备注：${trimmedNote}`);
  }
  return lines.join("\n");
}

/** 判断文本中是否含编排载荷标签。 */
export function hasWorkflowComposerPayload(text: string): boolean {
  return text.includes(`<${WORKFLOW_COMPOSER_TAG}>`);
}

/**
 * 从载荷标签内的 JSON 反解回编排图（供验证与后续复用）。
 * 标签缺失、JSON 损坏或结构不符时一律返回 null，绝不抛错；节点 prompt 里若
 * 恰好出现标签文本，会继续尝试下一对标签，只接受真正能解析成图的那一段。
 */
export function parseWorkflowComposerPayload(
  text: string,
): WorkflowComposerGraph | null {
  const openTag = `<${WORKFLOW_COMPOSER_TAG}>`;
  const closeTag = `</${WORKFLOW_COMPOSER_TAG}>`;
  let cursor = 0;
  while (cursor <= text.length) {
    const start = text.indexOf(openTag, cursor);
    if (start < 0) {
      return null;
    }
    const end = text.indexOf(closeTag, start + openTag.length);
    if (end > start) {
      const graph = parseWorkflowComposerGraphJson(
        text.slice(start + openTag.length, end).trim(),
      );
      if (graph) {
        return graph;
      }
    }
    // 这一段不是合法载荷：跳过本开标签，继续找下一对。
    cursor = start + openTag.length;
  }
  return null;
}

/** 解析载荷 JSON 文本；任何异常或结构不符都返回 null。 */
function parseWorkflowComposerGraphJson(
  raw: string,
): WorkflowComposerGraph | null {
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

  const rawNodes: unknown[] = Array.isArray(source.nodes) ? source.nodes : [];
  const nodes: WorkflowComposerNode[] = [];
  for (const rawNode of rawNodes) {
    if (!rawNode || typeof rawNode !== "object") {
      continue;
    }
    const node = rawNode as Record<string, unknown>;
    const id = typeof node.id === "string" ? node.id : "";
    const name = typeof node.name === "string" ? node.name : "";
    const label = typeof node.label === "string" ? node.label : "";
    nodes.push({
      id,
      label: label || name || id,
      prompt: typeof node.prompt === "string" ? node.prompt : "",
      description: typeof node.description === "string" ? node.description : "",
      apiProfile: typeof node.apiProfile === "string" ? node.apiProfile : "",
      model: typeof node.model === "string" ? node.model : "",
    });
  }

  const nodeIds = new Set(nodes.map((node) => node.id));
  const rawEdges: unknown[] = Array.isArray(source.edges) ? source.edges : [];
  const seenEdges = new Set<string>();
  const edges: { source: string; target: string }[] = [];
  for (const rawEdge of rawEdges) {
    if (!rawEdge || typeof rawEdge !== "object") {
      continue;
    }
    const edge = rawEdge as Record<string, unknown>;
    const edgeSource = typeof edge.source === "string" ? edge.source : "";
    const edgeTarget = typeof edge.target === "string" ? edge.target : "";
    if (!nodeIds.has(edgeSource) || !nodeIds.has(edgeTarget)) {
      continue;
    }
    if (edgeSource === edgeTarget) {
      continue;
    }
    const key = `${edgeSource}->${edgeTarget}`;
    if (seenEdges.has(key)) {
      continue;
    }
    seenEdges.add(key);
    edges.push({ source: edgeSource, target: edgeTarget });
  }

  return {
    title: typeof source.title === "string" ? source.title : "",
    nodes,
    edges,
  };
}
