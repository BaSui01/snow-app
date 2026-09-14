/**
 * 手机远控 · WorkFlow 桥接。
 *
 * 桌面卡片的运行态来自组件自身状态；远控桥没有组件，这里按 flow 组装与
 * 卡片等价的快照供 /api/state 下发：
 * - 节点图：DB 持久化画布（桌面编辑后的权威图）优先，回退 generate 卡片
 *   arguments 解析图；
 * - 节点运行态：活跃 run 的内存实时状态优先（事件瞬发，DB 落盘滞后），
 *   否则读 workflow_node_sessions / workflow_runs 记录；
 * - 节点顺序：复用 Rust validateWorkflowGraph（与 runner / MCP 工具同一
 *   拓扑实现），校验失败保持画布顺序。
 *
 * 动作（执行 / 反馈）与桌面卡片按钮同语义：均在渲染进程执行并结算挂起的
 * 工具调用；执行在后台运行，进度由移动端轮询 /api/state 的 workflow 快照。
 */

import type {
  ChatConversationRecord,
  WorkflowNodeSessionRecord,
  WorkflowRunRecord,
} from "../../preload";
import type {
  SnowRemoteWorkflow,
  SnowRemoteWorkflowNode,
  SnowRemoteWorkflowNodeStatus,
} from "../types/remoteControl";
import { getErrorMessage } from "./mainContent/chatMessages/utils/conversationHelpers";
import type {
  ChatConversationMessage,
  ToolCallInfo,
  UseChatConversationResult,
} from "./mainContent/chatMessages/utils/conversationTypes";
import {
  buildWorkflowSettlePayload,
  getActiveRunNodeStates,
  getActiveWorkflowRun,
  getWorkflowRunner,
  isWorkflowPending,
  isWorkflowRunActive,
  parseWorkflowCanvasPayload,
  parseWorkflowGraph,
  settleWorkflow,
  type WorkflowEdgeItem,
  type WorkflowGraph,
  type WorkflowNodeData,
  type WorkflowNodeItem,
} from "./mainContent/chatMessages/workflow/workflowRunner";

/** workflow-generate / workflow-resume 工具名（MCP server 前缀 + 工具名）。 */
export const WORKFLOW_GENERATE_TOOL_NAME = "workflow-workflow-generate";
export const WORKFLOW_RESUME_TOOL_NAME = "workflow-workflow-resume";

/** 反馈文本长度上限（与移动端输入框、Rust 侧校验一致）。 */
export const MAX_WORKFLOW_REPLY_LENGTH = 2_000;

const MAX_FLOW_ID_LENGTH = 200;
/** 单张卡片下发的最大节点数（防御异常大图撑爆快照）。 */
const MAX_WORKFLOW_NODES = 60;
const MAX_NODE_LABEL_LENGTH = 240;
const MAX_NODE_DESCRIPTION_LENGTH = 300;
const MAX_NODE_ERROR_LENGTH = 300;

/** 挂起 / 运行中的快照缓存时长：/api/state 每秒轮询，避免重复读 DB。 */
const ACTIVE_SNAPSHOT_TTL_MS = 1_000;
/** 终态快照缓存时长（数据不再变化，只兜底周期性重查）。 */
const SETTLED_SNAPSHOT_TTL_MS = 10_000;
/** 挂起期间画布可被桌面编辑：短 TTL 保证手机看到最新节点。 */
const EDITABLE_GRAPH_TTL_MS = 2_000;
/** 节点记录（workflow_node_sessions）缓存时长。 */
const NODE_RECORDS_TTL_MS = 1_000;
/** run 记录（workflow_runs）缓存时长（终态长缓存）。 */
const RUN_RECORD_TTL_MS = 10_000;

const clip = (value: string | undefined, maxLength: number): string => {
  const text = value ?? "";
  return text.length > maxLength ? text.slice(0, maxLength) : text;
};

/** resume 卡片从 arguments 解析 flowId（指向 generate 卡片的 flow）。 */
const readResumeFlowId = (argsJson: string): string => {
  try {
    const parsed = JSON.parse(argsJson || "{}") as { flowId?: unknown };
    return typeof parsed.flowId === "string" ? parsed.flowId.trim() : "";
  } catch {
    return "";
  }
};

const flowKey = (parentConversationId: string, flowId: string): string =>
  `${parentConversationId}\u0001${flowId}`;

/** 执行 / 反馈动作的执行上下文（由远控桥按当前会话提供）。 */
export type WorkflowRemoteContext = {
  conversation: UseChatConversationResult;
  conversationId: string;
  /** 会话所在项目目录（record.directoryId 缺失时的兜底）。 */
  directoryId: string;
};

// ---------------------------------------------------------------------------
// 快照组装
// ---------------------------------------------------------------------------

const normalizeNodeStatus = (
  value: string | undefined,
): SnowRemoteWorkflowNodeStatus =>
  value === "running" || value === "completed" || value === "failed"
    ? value
    : "pending";

/** 画布图缓存：key = 会话 + flow。 */
const baseGraphCache = new Map<string, { at: number; graph: WorkflowGraph }>();

/**
 * 读取 flow 的节点图（含执行顺序）。画布只有挂起（可编辑）阶段会变化，
 * 因此挂起时短 TTL、其余时间永久复用（含"无画布记录"的结论）。
 */
const loadBaseGraph = async (
  parentConversationId: string,
  flowId: string,
  argsJson: string,
): Promise<WorkflowGraph> => {
  const argsGraph = parseWorkflowGraph(argsJson);
  const key = flowKey(parentConversationId, flowId);
  const cached = baseGraphCache.get(key);
  if (cached) {
    const ttl = isWorkflowPending(flowId)
      ? EDITABLE_GRAPH_TTL_MS
      : Number.POSITIVE_INFINITY;
    if (Date.now() - cached.at < ttl) {
      return cached.graph;
    }
  }

  let graph = argsGraph;
  try {
    const record = await window.snow.getWorkflowCanvas(
      parentConversationId,
      flowId,
    );
    const payload = record
      ? parseWorkflowCanvasPayload(record.canvasJson)
      : null;
    if (payload && payload.nodes.length > 0) {
      graph = {
        title: argsGraph.title,
        nodes: payload.nodes.map((node) => ({
          id: node.id,
          name: node.name ?? "",
          label: node.label ?? node.name ?? "",
          prompt: node.prompt ?? "",
          description: node.description ?? "",
          apiProfile: node.apiProfile ?? "",
          model: node.model ?? "",
        })),
        edges: payload.edges,
      };
    }
  } catch {
    // 画布读取失败：保持 args 解析基线
  }

  const ordered = await orderNodes(graph.nodes, graph.edges);
  const value: WorkflowGraph = {
    title: graph.title,
    nodes: ordered,
    edges: graph.edges,
  };
  baseGraphCache.set(key, { at: Date.now(), graph: value });
  return value;
};

/**
 * 按执行顺序排列节点：委托 Rust validateWorkflowGraph（拓扑收敛的唯一实现），
 * 校验失败（环 / 非法图）或桥不可用时保持画布顺序——与 runner 的降级一致。
 */
const orderNodes = async (
  nodes: WorkflowNodeData[],
  edges: WorkflowEdgeItem[],
): Promise<WorkflowNodeData[]> => {
  if (nodes.length <= 1) {
    return nodes;
  }
  try {
    const result = await window.snow.validateWorkflowGraph(
      JSON.stringify(nodes),
      JSON.stringify(edges),
    );
    if (result.errors.length === 0 && result.order.length === nodes.length) {
      const byId = new Map(nodes.map((node) => [node.id, node]));
      return result.order
        .map((nodeId) => byId.get(nodeId))
        .filter((node): node is WorkflowNodeData => Boolean(node));
    }
  } catch {
    // 桥不可用：保持画布顺序
  }
  return nodes;
};

/** 图的直接前驱 → 前置节点 label（跳过 dangling 与自环，去重）。 */
const buildDependencyLabels = (
  nodes: WorkflowNodeData[],
  edges: WorkflowEdgeItem[],
): Map<string, string[]> => {
  const labelById = new Map(
    nodes.map((node) => [node.id, node.label || node.name || node.id]),
  );
  const deps = new Map<string, string[]>();
  for (const node of nodes) {
    deps.set(node.id, []);
  }
  const seen = new Set<string>();
  for (const edge of edges) {
    if (
      !labelById.has(edge.source) ||
      !labelById.has(edge.target) ||
      edge.source === edge.target
    ) {
      continue;
    }
    const key = `${edge.source}\u0001${edge.target}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deps.get(edge.target)?.push(labelById.get(edge.source) ?? edge.source);
  }
  return deps;
};

/** 会话的节点记录缓存（一次查询覆盖该会话全部 flow）。 */
const nodeRecordsCache = new Map<
  string,
  { at: number; records: WorkflowNodeSessionRecord[] }
>();

const loadNodeRecords = async (
  parentConversationId: string,
): Promise<WorkflowNodeSessionRecord[]> => {
  const cached = nodeRecordsCache.get(parentConversationId);
  if (cached && Date.now() - cached.at < NODE_RECORDS_TTL_MS) {
    return cached.records;
  }
  try {
    const records =
      await window.snow.listWorkflowNodeSessions(parentConversationId);
    nodeRecordsCache.set(parentConversationId, {
      at: Date.now(),
      records,
    });
    return records;
  } catch {
    // 读取失败按空记录处理：卡片回退为「未开始」展示，不阻塞其它数据
    return [];
  }
};

/** run 记录缓存（key = 会话 + flow）。 */
const runRecordCache = new Map<
  string,
  { at: number; run: WorkflowRunRecord | null }
>();

const loadRunRecord = async (
  parentConversationId: string,
  flowId: string,
): Promise<WorkflowRunRecord | null> => {
  const key = flowKey(parentConversationId, flowId);
  const cached = runRecordCache.get(key);
  if (cached && Date.now() - cached.at < RUN_RECORD_TTL_MS) {
    return cached.run;
  }
  try {
    const run = await window.snow.getWorkflowRun(parentConversationId, flowId);
    runRecordCache.set(key, { at: Date.now(), run });
    return run;
  } catch {
    return null;
  }
};

/** 同一节点可能有多条记录（断点重跑会新建会话）：按状态优先级取最新一条
 *  （completed > running > failed；同状态取最后写入——查询按 created_at 升序）。 */
const pickNodeRecord = (
  records: WorkflowNodeSessionRecord[],
): WorkflowNodeSessionRecord | undefined => {
  const lastWithStatus = (
    status: string,
  ): WorkflowNodeSessionRecord | undefined => {
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (records[index].runStatus === status) {
        return records[index];
      }
    }
    return undefined;
  };
  return (
    lastWithStatus("completed") ??
    lastWithStatus("running") ??
    lastWithStatus("failed") ??
    records[records.length - 1]
  );
};

const buildSnapshot = async (params: {
  parentConversationId: string;
  argsJson: string;
  mode: "generate" | "resume";
  flowId: string;
  pending: boolean;
  activeRun: boolean;
}): Promise<SnowRemoteWorkflow> => {
  const { parentConversationId, flowId, mode } = params;
  const graph = await loadBaseGraph(
    parentConversationId,
    flowId,
    params.argsJson,
  );
  const [allRecords, run] = await Promise.all([
    loadNodeRecords(parentConversationId),
    loadRunRecord(parentConversationId, flowId),
  ]);
  const flowRecords = allRecords.filter((record) => record.flowId === flowId);
  const dependencyLabels = buildDependencyLabels(graph.nodes, graph.edges);
  const liveStates = params.activeRun
    ? getActiveRunNodeStates(parentConversationId, flowId)
    : undefined;

  const nodes: SnowRemoteWorkflowNode[] = graph.nodes
    .slice(0, MAX_WORKFLOW_NODES)
    .map((node) => {
      const records = flowRecords.filter((record) => record.nodeId === node.id);
      const record = pickNodeRecord(records);
      const live = liveStates?.get(node.id);
      const recordStatus = record
        ? normalizeNodeStatus(record.runStatus)
        : "pending";
      // 无活跃 run 时残留的 running 记录（应用重启）降级为 pending，
      // 与桌面卡片的恢复口径一致。
      const status: SnowRemoteWorkflowNodeStatus =
        live ??
        (recordStatus === "running" && !params.activeRun
          ? "pending"
          : recordStatus);
      return {
        id: node.id,
        label:
          clip(
            node.label || node.name || record?.nodeName || node.id,
            MAX_NODE_LABEL_LENGTH,
          ) || node.id,
        description: clip(node.description, MAX_NODE_DESCRIPTION_LENGTH),
        status,
        conversationId: record?.conversationId ?? "",
        errorMessage: clip(record?.errorMessage, MAX_NODE_ERROR_LENGTH),
        dependsOn: (dependencyLabels.get(node.id) ?? []).map(
          (label) => clip(label, MAX_NODE_LABEL_LENGTH) || label,
        ),
      };
    });

  const labelById = new Map(nodes.map((node) => [node.id, node.label]));
  // 边只保留两端都在下发节点集合内的（节点可能因上限被截断），供移动端
  // 画布绘制连线与分层布局。
  const nodeIdSet = new Set(nodes.map((node) => node.id));
  const edges = graph.edges
    .filter(
      (edge) =>
        nodeIdSet.has(edge.source) &&
        nodeIdSet.has(edge.target) &&
        edge.source !== edge.target,
    )
    .map((edge) => ({ source: edge.source, target: edge.target }));
  // run 记录是 flow 级权威：断点重跑成功后旧失败节点记录仍在 DB，不能据此
  // 把已完成的 flow 判成失败；没有 run 记录时才回落到节点记录聚合。
  let status: SnowRemoteWorkflow["status"];
  if (params.activeRun) {
    status = "running";
  } else if (run) {
    status =
      run.runStatus === "completed"
        ? "completed"
        : run.runStatus === "failed"
          ? "failed"
          : "idle";
  } else if (flowRecords.some((record) => record.runStatus === "failed")) {
    status = "failed";
  } else if (
    flowRecords.length > 0 &&
    flowRecords.every((record) => record.runStatus === "completed")
  ) {
    status = "completed";
  } else {
    status = "idle";
  }

  // 失败详情只对失败的 flow 下发（取最新一条失败记录：重跑后以本轮为准）。
  const failedRecord =
    status === "failed"
      ? [...flowRecords]
          .reverse()
          .find((record) => record.runStatus === "failed")
      : undefined;
  const failedNode = failedRecord
    ? {
        nodeId: failedRecord.nodeId,
        label: labelById.get(failedRecord.nodeId) ?? failedRecord.nodeName,
        conversationId: failedRecord.conversationId,
        error:
          clip(failedRecord.errorMessage, MAX_NODE_ERROR_LENGTH) ||
          clip(run?.errorMessage, MAX_NODE_ERROR_LENGTH) ||
          "Node failed",
      }
    : status === "failed" && run?.errorMessage
      ? {
          nodeId: "",
          label: "",
          conversationId: "",
          error: clip(run.errorMessage, MAX_NODE_ERROR_LENGTH),
        }
      : undefined;

  return {
    flowId,
    mode,
    title: clip(graph.title, MAX_NODE_LABEL_LENGTH),
    status,
    pending: params.pending,
    // 存在未完成的 run 进度（应用重启 / 中断 / 失败）：执行按钮变「继续执行」，
    // runner 会自动跳过已完成节点。
    resumeAvailable: Boolean(
      run && run.runStatus !== "completed" && run.currentNodeIndex > 0,
    ),
    nodes,
    edges,
    ...(failedNode ? { failedNode } : {}),
  };
};

/** 快照缓存：key = 会话 + flow。 */
const snapshotCache = new Map<
  string,
  { expiresAt: number; value: SnowRemoteWorkflow }
>();

/**
 * 解析某个 workflow 工具调用的卡片快照；非 workflow 工具返回 undefined。
 * 会话 / flow 不匹配（例如历史消息里的其它会话卡片）同样返回 undefined。
 */
export const resolveWorkflowSnapshot = async (
  parentConversationId: string,
  toolCall: Pick<ToolCallInfo, "name" | "interactionId" | "arguments">,
): Promise<SnowRemoteWorkflow | undefined> => {
  if (!parentConversationId) {
    return undefined;
  }
  const isGenerate = toolCall.name === WORKFLOW_GENERATE_TOOL_NAME;
  const isResume = toolCall.name === WORKFLOW_RESUME_TOOL_NAME;
  if (!isGenerate && !isResume) {
    return undefined;
  }
  const argsJson = toolCall.arguments ?? "{}";
  const mode: SnowRemoteWorkflow["mode"] = isGenerate ? "generate" : "resume";
  const flowId = isGenerate
    ? toolCall.interactionId
    : readResumeFlowId(argsJson);
  if (!flowId || flowId.length > MAX_FLOW_ID_LENGTH) {
    return undefined;
  }

  const key = flowKey(parentConversationId, flowId);
  const cached = snapshotCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const pending = isGenerate && isWorkflowPending(flowId);
  const activeRun = Boolean(getActiveWorkflowRun(parentConversationId, flowId));
  const value = await buildSnapshot({
    parentConversationId,
    argsJson,
    mode,
    flowId,
    pending,
    activeRun,
  });
  const active = pending || activeRun || value.status === "running";
  snapshotCache.set(key, {
    expiresAt:
      Date.now() + (active ? ACTIVE_SNAPSHOT_TTL_MS : SETTLED_SNAPSHOT_TTL_MS),
    value,
  });
  return value;
};

/** 失效某个 flow 的快照缓存（执行 / 反馈后调用，下一轮轮询立即重算）。 */
const invalidateWorkflowSnapshot = (
  parentConversationId: string,
  flowId: string,
): void => {
  snapshotCache.delete(flowKey(parentConversationId, flowId));
  nodeRecordsCache.delete(parentConversationId);
  runRecordCache.delete(flowKey(parentConversationId, flowId));
};

// ---------------------------------------------------------------------------
// 动作（与桌面卡片按钮同语义）
// ---------------------------------------------------------------------------

const findGenerateToolCall = (
  messages: ChatConversationMessage[],
  flowId: string,
): ToolCallInfo | undefined => {
  for (const message of messages) {
    const toolCall = message.toolCalls?.find(
      (item) =>
        item.interactionId === flowId &&
        item.name === WORKFLOW_GENERATE_TOOL_NAME,
    );
    if (toolCall) {
      return toolCall;
    }
  }
  return undefined;
};

/** 可执行节点：过滤空节点与无 prompt 的节点（与卡片执行口径一致）。 */
const toRunnableNodes = (graph: WorkflowGraph): WorkflowNodeItem[] =>
  graph.nodes
    .filter((node) => Boolean(node.id) && Boolean(node.prompt.trim()))
    .map((node) => ({
      ...node,
      runStatus: "pending" as const,
      errorMessage: "",
      conversationId: "",
      handoffContent: "",
    }));

/**
 * 执行挂起的 workflow-generate：与卡片「执行」按钮同一路径——节点图
 * 优先取桌面画布（用户编辑后的权威图），任务在后台运行并立即返回；
 * 完成后按卡片同一结算载荷结算挂起的工具调用（模型侧可见执行汇总）。
 */
export const runRemoteWorkflow = async (
  context: WorkflowRemoteContext,
  flowId: string,
): Promise<void> => {
  const normalized = flowId.trim();
  const { conversation, conversationId } = context;
  if (!normalized || normalized.length > MAX_FLOW_ID_LENGTH) {
    throw new Error("工作流标识无效");
  }
  const toolCall = findGenerateToolCall(conversation.messages, normalized);
  if (!toolCall) {
    throw new Error("工作流不存在或不属于当前会话");
  }
  if (isWorkflowRunActive(conversationId, normalized)) {
    throw new Error("工作流正在执行中");
  }
  if (!isWorkflowPending(normalized)) {
    throw new Error("工作流已结算，请让 Snow 重新生成流程");
  }
  const executor = getWorkflowRunner(conversationId, normalized);
  if (!executor) {
    throw new Error(
      "工作流执行器已失效（应用可能已重启），请让 Snow 重新生成流程后再执行",
    );
  }

  const graph = await loadBaseGraph(
    conversationId,
    normalized,
    toolCall.arguments ?? "{}",
  );
  const nodes = toRunnableNodes(graph);
  if (nodes.length === 0) {
    throw new Error("工作流没有可执行的节点，请先在电脑端补全节点内容");
  }

  const record: ChatConversationRecord | null = await window.snow
    .getChatConversation(conversationId)
    .catch(() => null);
  const runtime = conversation.getRuntimeInputState(conversationId);
  const directoryId = record?.directoryId?.trim() || context.directoryId || "";

  invalidateWorkflowSnapshot(conversationId, normalized);
  void executor
    .runWorkflow({
      parentConversationId: conversationId,
      interactionId: normalized,
      directoryId,
      // 空节点配置跟随会话自身的 API 配置 / 模型（会话可独立更改配置），
      // 会话也未设置时由 Rust 端回落全局默认。
      sessionApiProfile: runtime?.apiProfile || record?.apiProfileName || "",
      sessionModel: runtime?.model || record?.model || "",
      nodes,
      edges: graph.edges,
      onNodeConversationCreated: () => {
        // 节点会话写入 DB 后立即刷新桌面侧边栏会话列表。
        conversation.refreshConversations();
      },
    })
    .then((outcome) => {
      settleWorkflow(normalized, buildWorkflowSettlePayload(outcome));
    })
    .catch((error: unknown) => {
      settleWorkflow(
        normalized,
        JSON.stringify({ success: false, error: getErrorMessage(error) }),
      );
    });
};

/**
 * 提交对流程的修改意见：结算挂起的 workflow-generate（模型据此重新设计
 * 流程），与桌面卡片反馈入口同语义。
 */
export const replyRemoteWorkflow = async (
  context: WorkflowRemoteContext,
  flowId: string,
  message: string,
): Promise<void> => {
  const normalized = flowId.trim();
  const text = message.trim();
  const { conversation, conversationId } = context;
  if (!normalized || normalized.length > MAX_FLOW_ID_LENGTH) {
    throw new Error("工作流标识无效");
  }
  if (!text) {
    throw new Error("反馈内容不能为空");
  }
  if (text.length > MAX_WORKFLOW_REPLY_LENGTH) {
    throw new Error(`反馈内容不能超过 ${MAX_WORKFLOW_REPLY_LENGTH} 个字符`);
  }
  if (
    !findGenerateToolCall(conversation.messages, normalized) ||
    conversation.activeConversationId !== conversationId
  ) {
    throw new Error("工作流不存在或不属于当前会话");
  }
  if (isWorkflowRunActive(conversationId, normalized)) {
    throw new Error("工作流正在执行中，暂时无法提交反馈");
  }
  const settled = settleWorkflow(
    normalized,
    JSON.stringify({ userResponse: text }),
  );
  if (!settled) {
    throw new Error("工作流已结算，请让 Snow 重新生成流程");
  }
  invalidateWorkflowSnapshot(conversationId, normalized);
};
