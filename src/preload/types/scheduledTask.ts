/**
 * Type model for in-memory scheduled tasks.
 *
 * Scheduled tasks exist ONLY while the Snow App process is alive. They are
 * never persisted to disk: when the process exits, all timers disappear. This
 * matches requirement #4 ("tasks only execute while the Snow App process
 * exists; if the process is gone, they do not execute").
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
};

/** Internal runtime status of a task (derived from the scheduler, not stored). */
export type ScheduledTaskStatus =
  | "pending" // scheduled, waiting to fire
  | "running" // currently executing (AI Loop running for this task)
  | "completed" // once-task that already fired
  | "error"; // last execution failed

export type ScheduledTaskRecord = {
  id: string;
  /** The workspace directory this task belongs to. Tasks are isolated per
   *  project, mirroring the memo project-isolation model. */
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
};

/** Input shape for creating a scheduled task (mirrors the MCP tool schema). */
export type CreateScheduledTaskInput = {
  /** The workspace directory this task belongs to. */
  directoryId: string;
  name: string;
  prompt: string;
  schedule: ScheduledTaskSchedule;
  preScript?: string;
  preScriptTimeoutMs?: number;
  runOnScriptError?: boolean;
};

/** Result of running a scheduled-task pre-script in the Rust backend. */
export type PreScriptResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};
