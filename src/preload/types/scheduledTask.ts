/**
 * Type model for scheduled tasks.
 *
 * Tasks are persisted to the backend SQLite database: definition, status,
 * pause state and run history all survive app restarts. The scheduler itself
 * (timers, the tick loop) runs in the renderer process, so tasks only execute
 * while the app is running; a task whose fire time passes while the app is
 * closed is skipped and its schedule advances to the next plan point, unless
 * schedule.wakeWhenClosed is set (the OS scheduler relaunches the app and a
 * missed run is caught up once).
 *
 * A task wraps a user-configured prompt that is sent to the existing AI Loop
 * (via buildFromContent, which creates a new chat conversation and auto-sends,
 * giving the task access to all tools). Schedules are either:
 *  - "once":   executes one time at a chosen start time (ISO timestamp)
 *  - "recurring": repeats either at a fixed interval (intervalMs) or every
 *                day at a fixed hour:minute (daily mode)
 */

export type ScheduledTaskType = "once" | "recurring";

export type ScheduledTaskSchedule = {
  /** "once" = execute a single time at executeAt; "recurring" = repeat */
  type: ScheduledTaskType;
  /** ISO 8601 timestamp (UTC). Required when type === "once". */
  executeAt?: string;
  /** Recurring mode: "interval" = every intervalMs; "daily" = every day at hour:minute */
  mode?: "interval" | "daily";
  /** Milliseconds between executions. Required when mode === "interval". Min 60000 (1 min). */
  intervalMs?: number;
  /** Hour of day (0-23) for daily schedule. Required when mode === "daily". */
  hour?: number;
  /** Minute of hour (0-59) for daily schedule. Required when mode === "daily". */
  minute?: number;
  /** 应用关闭后仍执行：由系统调度在到点前拉起应用，错过的执行启动后补跑一次。 */
  wakeWhenClosed?: boolean;
};

/** Internal runtime status of a task (derived from the scheduler, not stored). */
export type ScheduledTaskStatus =
  | "pending" // scheduled, waiting to fire
  | "running" // currently executing (AI Loop running for this task)
  | "completed" // once-task that already fired
  | "error"; // last execution failed

/** One entry of the task's execution history (in-memory ring buffer). */
export type ScheduledTaskRunRecord = {
  /** ISO timestamp (UTC) when this run started. */
  runAt: string;
  /** Outcome: "running" = in progress (only the newest entry), "completed" /
   *  "error" = finished run. */
  status: "running" | "completed" | "error";
  /** Elapsed milliseconds of the finished run. */
  durationMs?: number;
  /** Error message when status === "error". */
  error?: string;
};

export type ScheduledTaskRecord = {
  id: string;
  /** The workspace directory this task belongs to. Empty string = a global
   *  task not bound to any project (visible from every project's panel and
   *  executed in the currently active project). */
  directoryId: string;
  name: string;
  /** The user-configured prompt sent to the AI Loop on each execution.
   *  May contain the {{SCRIPT_OUTPUT}} placeholder, replaced with the
   *  pre-script's JSON "output" field (or empty) before sending. */
  prompt: string;
  schedule: ScheduledTaskSchedule;
  status: ScheduledTaskStatus;
  /** Whether the task is paused (timers cleared, not firing). */
  paused: boolean;
  /** Optional shell command executed before the AI Loop. The script decides
   *  whether the prompt is sent: exit 0 = run, exit 1 = skip; or the last
   *  stdout line may be a JSON object {"run":bool,"reason":string,"output":string}. */
  preScript?: string;
  /** Timeout for the pre-script in ms (default 60000, range 1000-300000). */
  preScriptTimeoutMs?: number;
  /** When true, a pre-script failure (non-zero/other exit, timeout, spawn
   *  error) still proceeds to the AI Loop. Default false. */
  runOnScriptError?: boolean;
  createdAt: string;
  /** ISO timestamp of the last modification (also touched by runs). */
  updatedAt?: string;
  /** ISO timestamp of the last execution, if any. */
  lastRunAt?: string;
  /** ISO timestamp of the next scheduled execution, if known. */
  nextRunAt?: string;
  /** Error message from the last execution, if status === "error". */
  lastError?: string;
  /** How many times this task has executed the AI Loop. */
  runCount: number;
  /** How many times the pre-script skipped the AI Loop. */
  skipCount: number;
  /** ISO timestamp of the last skip, if any. */
  lastSkippedAt?: string;
  /** Reason from the last skip (script JSON "reason" or exit-code summary). */
  lastSkipReason?: string;
  /** Recent execution history (ring buffer, newest last, max 20 entries).
   *  Persisted in the backend database and restored after a restart. */
  history?: ScheduledTaskRunRecord[];
  /** Optional per-task API configuration overrides (see ScheduledTaskRunOptions). */
  apiProfile?: string;
  /** Basic model snapshot used only for the fired conversation's first title
   *  generation. The conversation itself continues to run on `model`. */
  basicModel?: string;
  /** Advanced model id used for the task's conversation. */
  model?: string;
  thinkingStrength?: string;
  /** 工作流运行模式：存在时由画布节点取代单提示词执行。 */
  workflow?: ScheduledTaskWorkflow;
  /** 当前/最近一次工作流运行状态（持久化，重启后恢复）。 */
  workflowRun?: ScheduledTaskWorkflowRun;
};

/** 节点间上下文衔接方式。 */
export type ScheduledTaskWorkflowContextMode =
  /** 每个节点新会话，上游最终回复注入下游提示词 */
  | "handoff"
  /** 每个节点新会话，不传递内容 */
  | "none"
  /** 所有节点在同一会话依次发送 */
  | "shared";

export type ScheduledTaskWorkflowNode = {
  id: string;
  label: string;
  prompt: string;
  apiProfile?: string;
  basicModel?: string;
  model?: string;
  thinkingStrength?: string;
  position: { x: number; y: number };
};

export type ScheduledTaskWorkflowEdge = {
  source: string;
  target: string;
  /** 上游完成后等待多久再触发下游（毫秒）。 */
  delayMs: number;
};

export type ScheduledTaskWorkflow = {
  contextMode: ScheduledTaskWorkflowContextMode;
  nodes: ScheduledTaskWorkflowNode[];
  edges: ScheduledTaskWorkflowEdge[];
};

export type ScheduledTaskWorkflowNodeStatus =
  "waiting" | "scheduled" | "running" | "completed" | "failed" | "cancelled";

export type ScheduledTaskWorkflowNodeState = {
  status: ScheduledTaskWorkflowNodeStatus;
  /** status === "scheduled" 时的触发时间（ISO）。 */
  dueAt?: string;
  startedAt?: string;
  finishedAt?: string;
  conversationId?: string;
  /** 节点最终回复（截断后保存，用于交接）。 */
  output?: string;
  error?: string;
};

export type ScheduledTaskWorkflowRun = {
  status: "running" | "completed" | "error";
  startedAt: string;
  finishedAt?: string;
  /** scheduled_task_runs 行 id，结束时据此收尾。 */
  runId?: string;
  /** 预脚本 output，注入节点提示词的 {{SCRIPT_OUTPUT}}。 */
  scriptOutput?: string;
  /** 预脚本失败但仍执行时附加到节点提示词的说明。 */
  scriptNote?: string;
  /** shared 模式共用的会话 id。 */
  sharedConversationId?: string;
  /** 启动时的工作流快照，运行中编辑任务不影响本次运行。 */
  definition: ScheduledTaskWorkflow;
  nodes: Record<string, ScheduledTaskWorkflowNodeState>;
  error?: string;
};

/**
 * Optional per-task run configuration. When a field is omitted/empty, the
 * fired conversation falls back to the app's current defaults exactly like a
 * task created before this feature existed (global active API profile,
 * profile/model default, profile-bound thinking strength).
 */
export type ScheduledTaskRunOptions = {
  /** API config profile name that serves this task's conversation. */
  apiProfile?: string;
  /** Basic model snapshot used only for the first conversation title. */
  basicModel?: string;
  /** Advanced model id used for the task's conversation. */
  model?: string;
  /** Thinking strength override ("none" | "low" | "medium" | "high" | custom).
   *  Applied per-request (in-memory), never mutates the profile config. */
  thinkingStrength?: string;
};

/** Input shape for creating a scheduled task (mirrors the MCP tool schema). */
export type CreateScheduledTaskInput = {
  /** The workspace directory this task belongs to. Optional: when omitted or
   *  empty, the task is created as a GLOBAL task (not bound to any project). */
  directoryId?: string;
  /**
   * Optional idempotency key. When provided and a task with this id already
   * exists, creation returns the existing task instead of creating a
   * duplicate — safe to reuse when retrying a timed-out tool call.
   */
  id?: string;
  name: string;
  prompt: string;
  schedule: ScheduledTaskSchedule;
  /** Optional per-task API configuration overrides (see ScheduledTaskRunOptions). */
  apiProfile?: string;
  /** Basic model snapshot used only for the fired conversation's first title. */
  basicModel?: string;
  model?: string;
  thinkingStrength?: string;
  preScript?: string;
  preScriptTimeoutMs?: number;
  runOnScriptError?: boolean;
  /** 工作流模式定义；缺省 = 单提示词任务。 */
  workflow?: ScheduledTaskWorkflow;
};

/** Result of running a scheduled-task pre-script in the Rust backend. */
export type PreScriptResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

/** Input shape for updating an existing task. name/prompt/schedule/directoryId
 *  are kept when omitted; run-config overrides are cleared when omitted/empty
 *  (same semantics as creation). */
export type UpdateScheduledTaskInput = {
  name?: string;
  prompt?: string;
  schedule?: ScheduledTaskSchedule;
  /** "" = global task. */
  directoryId?: string;
  apiProfile?: string;
  basicModel?: string;
  model?: string;
  thinkingStrength?: string;
  preScript?: string;
  preScriptTimeoutMs?: number;
  runOnScriptError?: boolean;
  /** 工作流定义；undefined = 保持不变，null = 切回单提示词模式。 */
  workflow?: ScheduledTaskWorkflow | null;
};
