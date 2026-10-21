/**
 * 定时任务工作流的纯函数：定义校验、运行状态推进、节点提示词组装。
 * 调度（定时器/执行器）在 scheduledTasksStore 中。
 */

import type {
  ScheduledTaskWorkflow,
  ScheduledTaskWorkflowContextMode,
  ScheduledTaskWorkflowEdge,
  ScheduledTaskWorkflowNode,
  ScheduledTaskWorkflowNodeState,
  ScheduledTaskWorkflowRun,
} from "../../preload";

/** 连线延时上限（366 天，与间隔调度上限一致）。 */
export const MAX_EDGE_DELAY_MS = 366 * 24 * 60 * 60 * 1000;
/** 节点输出保存上限（交接用）。 */
const MAX_NODE_OUTPUT_CHARS = 20_000;
const SCRIPT_OUTPUT_PLACEHOLDER = "{{SCRIPT_OUTPUT}}";

const CONTEXT_MODES: ScheduledTaskWorkflowContextMode[] = [
  "handoff",
  "none",
  "shared",
];

const trimOrUndefined = (value: string | undefined): string | undefined =>
  value?.trim() || undefined;

/** 校验并规范化工作流定义，非法时抛错。环检测由 UI 提交前走 Rust 校验。 */
export const normalizeWorkflow = (
  workflow: ScheduledTaskWorkflow,
): ScheduledTaskWorkflow => {
  const contextMode = CONTEXT_MODES.includes(workflow.contextMode)
    ? workflow.contextMode
    : "handoff";
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length === 0) {
    throw new Error("Workflow requires at least one node");
  }
  const ids = new Set<string>();
  const nodes: ScheduledTaskWorkflowNode[] = workflow.nodes.map((node) => {
    const id = node.id?.trim();
    if (!id || ids.has(id)) {
      throw new Error(`Invalid or duplicate workflow node id: "${node.id}"`);
    }
    ids.add(id);
    const prompt = (node.prompt ?? "").trim();
    const label = (node.label ?? "").trim() || id;
    if (!prompt) {
      throw new Error(`Workflow node "${label}" has an empty prompt`);
    }
    return {
      id,
      label,
      prompt,
      apiProfile: trimOrUndefined(node.apiProfile),
      basicModel: trimOrUndefined(node.basicModel),
      model: trimOrUndefined(node.model),
      thinkingStrength: trimOrUndefined(node.thinkingStrength),
      position: {
        x: Number.isFinite(node.position?.x) ? node.position.x : 0,
        y: Number.isFinite(node.position?.y) ? node.position.y : 0,
      },
    };
  });
  const seenEdges = new Set<string>();
  const edges: ScheduledTaskWorkflowEdge[] = [];
  for (const edge of workflow.edges ?? []) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      throw new Error("Workflow edge references an unknown node");
    }
    if (edge.source === edge.target) {
      throw new Error("Workflow edge cannot connect a node to itself");
    }
    const key = `${edge.source}->${edge.target}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    const delayMs = Number.isFinite(edge.delayMs)
      ? Math.round(edge.delayMs)
      : 0;
    if (delayMs < 0 || delayMs > MAX_EDGE_DELAY_MS) {
      throw new Error(
        `Edge delay must be between 0 and ${MAX_EDGE_DELAY_MS} ms, received ${edge.delayMs}`,
      );
    }
    edges.push({ source: edge.source, target: edge.target, delayMs });
  }
  return { contextMode, nodes, edges };
};

/** 任务 prompt 字段的摘要（列表预览/MCP 查看用）。 */
export const buildWorkflowPromptSummary = (
  workflow: ScheduledTaskWorkflow,
): string =>
  workflow.nodes
    .map((node) => `[${node.label}] ${node.prompt}`)
    .join("\n\n")
    .trim();

/** 直接前驱表（按定义中的节点顺序）。 */
const buildPredecessors = (
  workflow: ScheduledTaskWorkflow,
): Map<string, ScheduledTaskWorkflowEdge[]> => {
  const preds = new Map<string, ScheduledTaskWorkflowEdge[]>();
  for (const node of workflow.nodes) preds.set(node.id, []);
  for (const edge of workflow.edges) {
    preds.get(edge.target)?.push(edge);
  }
  return preds;
};

/** 新建运行状态：无前驱的节点立即就绪。 */
export const createWorkflowRun = (
  workflow: ScheduledTaskWorkflow,
  meta: {
    startedAt: string;
    runId?: string;
    scriptOutput?: string;
    scriptNote?: string;
  },
): ScheduledTaskWorkflowRun => {
  const preds = buildPredecessors(workflow);
  const nodes: Record<string, ScheduledTaskWorkflowNodeState> = {};
  for (const node of workflow.nodes) {
    nodes[node.id] =
      (preds.get(node.id) ?? []).length === 0
        ? { status: "scheduled", dueAt: meta.startedAt }
        : { status: "waiting" };
  }
  return {
    status: "running",
    startedAt: meta.startedAt,
    runId: meta.runId,
    scriptOutput: meta.scriptOutput,
    scriptNote: meta.scriptNote,
    definition: workflow,
    nodes,
  };
};

/** 到期可启动的节点 id（按定义顺序）。 */
export const collectDueNodeIds = (
  run: ScheduledTaskWorkflowRun,
  now: number,
): string[] =>
  run.definition.nodes
    .map((node) => node.id)
    .filter((id) => {
      const state = run.nodes[id];
      if (state?.status !== "scheduled") return false;
      const due = state.dueAt ? Date.parse(state.dueAt) : now;
      return Number.isNaN(due) || due <= now;
    });

/** 运行中最近一个待触发的时间（毫秒），无则 null。 */
export const nextWorkflowDueMs = (
  run: ScheduledTaskWorkflowRun,
): number | null => {
  let earliest: number | null = null;
  for (const state of Object.values(run.nodes)) {
    if (state.status !== "scheduled" || !state.dueAt) continue;
    const ms = Date.parse(state.dueAt);
    if (Number.isNaN(ms)) continue;
    if (earliest === null || ms < earliest) earliest = ms;
  }
  return earliest;
};

/** 节点结束后推进：成功则激活全部前驱已完成的后继；失败则取消剩余节点。 */
export const applyNodeResult = (
  run: ScheduledTaskWorkflowRun,
  nodeId: string,
  result: {
    success: boolean;
    output: string;
    conversationId: string;
    error?: string;
  },
  finishedAtMs: number,
): ScheduledTaskWorkflowRun => {
  const finishedAt = new Date(finishedAtMs).toISOString();
  const output =
    result.output.length > MAX_NODE_OUTPUT_CHARS
      ? result.output.slice(-MAX_NODE_OUTPUT_CHARS)
      : result.output;
  const nodes = { ...run.nodes };
  nodes[nodeId] = {
    ...nodes[nodeId],
    status: result.success ? "completed" : "failed",
    finishedAt,
    conversationId: result.conversationId || nodes[nodeId]?.conversationId,
    output,
    error: result.success ? undefined : result.error || "Node failed",
  };
  const next: ScheduledTaskWorkflowRun = { ...run, nodes };
  if (run.definition.contextMode === "shared" && result.conversationId) {
    next.sharedConversationId = result.conversationId;
  }
  // 运行已结束（失败/取消后迟到的节点）：只记录节点状态
  if (run.status !== "running") return next;

  if (!result.success) {
    for (const [id, state] of Object.entries(nodes)) {
      if (state.status === "waiting" || state.status === "scheduled") {
        nodes[id] = { status: "cancelled" };
      }
    }
    const label =
      run.definition.nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
    return {
      ...next,
      status: "error",
      finishedAt,
      error: `${label}: ${result.error || "Node failed"}`,
    };
  }

  const preds = buildPredecessors(run.definition);
  for (const edge of run.definition.edges) {
    if (edge.source !== nodeId) continue;
    const target = nodes[edge.target];
    if (target?.status !== "waiting") continue;
    // 汇合：全部上游完成后，取各上游完成时间 + 连线延时的最大值
    let dueMs = 0;
    let ready = true;
    for (const incoming of preds.get(edge.target) ?? []) {
      const source = nodes[incoming.source];
      if (source?.status !== "completed" || !source.finishedAt) {
        ready = false;
        break;
      }
      dueMs = Math.max(
        dueMs,
        Date.parse(source.finishedAt) + (incoming.delayMs || 0),
      );
    }
    if (ready) {
      nodes[edge.target] = {
        status: "scheduled",
        dueAt: new Date(dueMs).toISOString(),
      };
    }
  }

  const allDone = Object.values(nodes).every(
    (state) => state.status === "completed",
  );
  return allDone ? { ...next, status: "completed", finishedAt } : next;
};

/** 用户取消：剩余节点标记取消，运行置为 error。 */
export const cancelWorkflowRunState = (
  run: ScheduledTaskWorkflowRun,
  reason: string,
): ScheduledTaskWorkflowRun => {
  const nodes = { ...run.nodes };
  for (const [id, state] of Object.entries(nodes)) {
    if (state.status === "waiting" || state.status === "scheduled") {
      nodes[id] = { status: "cancelled" };
    }
  }
  return {
    ...run,
    nodes,
    status: "error",
    finishedAt: new Date().toISOString(),
    error: reason,
  };
};

/** 重启恢复：中断的运行中节点重新排队（立即执行）。 */
export const resumeWorkflowRunAfterRestart = (
  run: ScheduledTaskWorkflowRun,
  nowIso: string,
): ScheduledTaskWorkflowRun => {
  const nodes = { ...run.nodes };
  for (const [id, state] of Object.entries(nodes)) {
    if (state.status === "running") {
      nodes[id] = {
        ...state,
        status: "scheduled",
        dueAt: nowIso,
        startedAt: undefined,
      };
    }
  }
  return { ...run, nodes };
};

/** 组装节点提示词：脚本输出注入 + handoff 模式拼接上游输出。 */
export const buildWorkflowNodePrompt = (
  run: ScheduledTaskWorkflowRun,
  node: ScheduledTaskWorkflowNode,
): string => {
  let prompt = node.prompt.includes(SCRIPT_OUTPUT_PLACEHOLDER)
    ? node.prompt.split(SCRIPT_OUTPUT_PLACEHOLDER).join(run.scriptOutput ?? "")
    : node.prompt;
  if (run.scriptNote) {
    prompt = `${prompt}\n\n${run.scriptNote}`;
  }
  if (run.definition.contextMode !== "handoff") return prompt;

  const upstream = run.definition.edges
    .filter((edge) => edge.target === node.id)
    .map((edge) => {
      const source = run.definition.nodes.find(
        (item) => item.id === edge.source,
      );
      return {
        label: source?.label ?? edge.source,
        output: run.nodes[edge.source]?.output?.trim() ?? "",
      };
    })
    .filter((item) => item.output);
  if (upstream.length === 0) return prompt;
  if (upstream.length === 1) {
    return `${prompt}\n\n## 上一个节点「${upstream[0].label}」的输出\n\n${upstream[0].output}`;
  }
  const sections = upstream
    .map((item) => `### 节点「${item.label}」\n\n${item.output}`)
    .join("\n\n");
  return `${prompt}\n\n## 前置节点的输出\n\n本节点有多个前置节点，请综合以下全部输出后再执行。\n\n${sections}`;
};
