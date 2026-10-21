/**
 * 子代理运行时执行预算：由渲染进程在每个工具派发前强制检查，不依赖模型
 * 自行计数。预算属于一次子代理会话的运行时状态（按 conversationId 注册），
 * 在工具递归、上下文压缩、send 循环之间保持；continue 时的追加/重置是主控
 * 的显式选择（见 parseSubAgentBudgetPatch），子代理自身无法续期。
 *
 * 语义约定：
 * - 工具调用数按实际派发计数，失败/重试同样计入；同一批并行调用按顺序逐次
 *   预留（排在预算之外的调用不派发）。
 * - maxRunMs 按墙钟计时，包含模型流式输出、工具执行以及等待用户授权/提问的
 *   时间。它只在「派发新工具」前检查，因此不会中断已发出的请求或正在执行的
 *   工具；这些调用的结果如实返回。
 * - 缺省不设置时上限为 null，完全保持原有运行行为。
 */

export type SubAgentBudgetSpec = {
  /** 最多允许派发的工具调用数；null = 不限制。 */
  maxToolCalls: number | null;
  /** 最多允许的运行时长（毫秒）；null = 不限制。 */
  maxRunMs: number | null;
};

export type SubAgentBudgetPatch = SubAgentBudgetSpec & {
  /** add = 在现有上限上追加（默认）；reset = 清零计数并重新计时。 */
  mode: "add" | "reset";
};

export type SubAgentBudgetBlockReason = "maxToolCalls" | "maxRunMs";

export type SubAgentBudgetSnapshot = {
  maxToolCalls: number | null;
  usedToolCalls: number;
  maxRunMs: number | null;
  elapsedMs: number;
  /** 已达到上限的具体维度（任务自然结束时也可能为真）。 */
  exceeded: SubAgentBudgetBlockReason | null;
  /** 运行时是否真的拦截了后续工具派发（仅此时才应判定为超限终止）。 */
  blocked: SubAgentBudgetBlockReason | null;
};

export type SubAgentBudgetTracker = {
  /** 激活时设定初始预算（reset 语义：计数与计时归零）。 */
  initialize: (spec: SubAgentBudgetSpec) => void;
  /** continue 的显式预算变更。 */
  apply: (patch: SubAgentBudgetPatch) => void;
  /** 剩余可派发次数（用于授权前裁剪；不消耗计数，超时时返回 0）。 */
  remainingToolCalls: () => number;
  /** 派发前检查时长是否已超限（不消耗计数）。 */
  canDispatch: () => boolean;
  /** 派发前预留一次工具调用；返回 false 表示已超限、不得派发。 */
  reserveToolCall: () => boolean;
  /** 标记本回合确实因预算中止（由运行循环在阻断派发时调用）。 */
  markStop: () => void;
  /** 读取并清除「本回合因预算中止」标记（收尾时判定终态专用）。 */
  consumeStop: () => boolean;
  /** 回执/列表展示用快照。 */
  snapshot: () => SubAgentBudgetSnapshot;
};

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const createTracker = (): SubAgentBudgetTracker => {
  let maxToolCalls: number | null = null;
  let usedToolCalls = 0;
  let maxRunMs: number | null = null;
  let startedAt = Date.now();
  let blocked: SubAgentBudgetBlockReason | null = null;
  let stopRequested = false;

  const elapsedMs = (): number => Math.max(0, Date.now() - startedAt);

  const exceededReason = (): SubAgentBudgetBlockReason | null => {
    if (maxRunMs !== null && elapsedMs() >= maxRunMs) {
      return "maxRunMs";
    }
    if (maxToolCalls !== null && usedToolCalls >= maxToolCalls) {
      return "maxToolCalls";
    }
    return null;
  };

  const canDispatch = (): boolean => exceededReason() === null;

  const snapshot = (): SubAgentBudgetSnapshot => ({
    maxToolCalls,
    usedToolCalls,
    maxRunMs,
    elapsedMs: elapsedMs(),
    exceeded: exceededReason(),
    blocked,
  });

  return {
    initialize: (spec) => {
      maxToolCalls = spec.maxToolCalls;
      maxRunMs = spec.maxRunMs;
      usedToolCalls = 0;
      startedAt = Date.now();
      blocked = null;
      stopRequested = false;
    },
    apply: (patch) => {
      stopRequested = false;
      if (patch.mode === "reset") {
        usedToolCalls = 0;
        startedAt = Date.now();
        blocked = null;
        // reset 只重置计数/计时；未提供的维度上限保持不变，不放宽既有约束。
        if (patch.maxToolCalls !== null) maxToolCalls = patch.maxToolCalls;
        if (patch.maxRunMs !== null) maxRunMs = patch.maxRunMs;
        return;
      }
      // add 语义：在现有上限上追加。原本不限制的维度保持不限制（追加不会
      // 把无上限收窄成有限额度）。
      if (patch.maxToolCalls !== null && maxToolCalls !== null) {
        maxToolCalls += patch.maxToolCalls;
      }
      if (patch.maxRunMs !== null && maxRunMs !== null) {
        // 追加时长：从当前已用时长起再给一段额度，而不是累加两个独立上限。
        maxRunMs = elapsedMs() + patch.maxRunMs;
      }
      if (patch.maxToolCalls !== null || patch.maxRunMs !== null) {
        blocked = null;
      }
    },
    remainingToolCalls: () => {
      if (!canDispatch()) return 0;
      return maxToolCalls === null
        ? Number.POSITIVE_INFINITY
        : Math.max(0, maxToolCalls - usedToolCalls);
    },
    canDispatch,
    reserveToolCall: () => {
      if (!canDispatch()) {
        blocked = exceededReason();
        return false;
      }
      usedToolCalls += 1;
      return true;
    },
    markStop: () => {
      stopRequested = true;
    },
    consumeStop: () => {
      const stopped = stopRequested;
      stopRequested = false;
      return stopped;
    },
    snapshot,
  };
};

/** 按子代理会话 id 注册的预算追踪器：跨回合、跨压缩、跨 continue 保持，
 *  只有显式 apply({ mode: "reset" }) 或新的激活会清零。 */
const budgetTrackers = new Map<string, SubAgentBudgetTracker>();

export const getSubAgentBudgetTracker = (
  conversationId: string,
): SubAgentBudgetTracker => {
  let tracker = budgetTrackers.get(conversationId);
  if (!tracker) {
    tracker = createTracker();
    budgetTrackers.set(conversationId, tracker);
  }
  return tracker;
};

/** 只读取已存在的追踪器（不会为历史记录新建），用于列表展示。 */
export const peekSubAgentBudgetSnapshot = (
  conversationId: string,
): SubAgentBudgetSnapshot | null =>
  budgetTrackers.get(conversationId)?.snapshot() ?? null;

const readBudgetObject = (
  raw: unknown,
): { value: Record<string, unknown> | null; errors: string[] } => {
  if (raw === undefined || raw === null) {
    return { value: null, errors: [] };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { value: null, errors: ["budget must be an object"] };
  }
  return { value: raw as Record<string, unknown>, errors: [] };
};

const readLimits = (
  value: Record<string, unknown> | null,
): { spec: SubAgentBudgetSpec; errors: string[] } => {
  if (!value) {
    return { spec: { maxToolCalls: null, maxRunMs: null }, errors: [] };
  }
  const errors: string[] = [];
  const read = (key: keyof SubAgentBudgetSpec): number | null => {
    const raw = value[key];
    if (raw === undefined || raw === null) return null;
    if (!isPositiveInteger(raw)) {
      errors.push(`${key} must be a positive integer`);
      return null;
    }
    return Math.floor(raw);
  };
  const spec: SubAgentBudgetSpec = {
    maxToolCalls: read("maxToolCalls"),
    maxRunMs: read("maxRunMs"),
  };
  return { spec, errors };
};

/** 解析 sub-agents-activate 的可选 budget 参数。 */
export const parseSubAgentBudgetSpec = (
  raw: unknown,
): { spec: SubAgentBudgetSpec; errors: string[] } => {
  const budget = readBudgetObject(raw);
  if (budget.errors.length) {
    return {
      spec: { maxToolCalls: null, maxRunMs: null },
      errors: budget.errors,
    };
  }
  return readLimits(budget.value);
};

/** 解析 sub-agents-continue 的可选 budget 参数；返回 null 表示未提供
 *  （保持现有计数与上限，不重置）。 */
export const parseSubAgentBudgetPatch = (
  raw: unknown,
): { patch: SubAgentBudgetPatch | null; errors: string[] } => {
  const budget = readBudgetObject(raw);
  if (budget.errors.length) {
    return { patch: null, errors: budget.errors };
  }
  if (!budget.value) {
    return { patch: null, errors: [] };
  }
  const { spec, errors } = readLimits(budget.value);
  const rawMode = budget.value.mode;
  if (rawMode !== undefined && rawMode !== "add" && rawMode !== "reset") {
    errors.push('budget.mode must be "add" or "reset"');
  }
  if (errors.length) {
    return { patch: null, errors };
  }
  return {
    patch: { ...spec, mode: rawMode === "reset" ? "reset" : "add" },
    errors: [],
  };
};
