/**
 * In-memory scheduled task scheduler (renderer singleton).
 *
 * This is a process-lifetime store: tasks and their timers live only while the
 * Snow App process is alive. Nothing is persisted to disk. When the process
 * exits, all timers are destroyed and the tasks vanish — matching requirement
 * #4 ("tasks only execute while the Snow App process exists").
 *
 * Execution is delegated to a registered "executor" callback. The renderer
 * (which lives inside the ChatConversationProvider) registers buildFromContent
 * as the executor, so every task fires a fresh AI Loop with access to all
 * tools. If no executor is registered when a task fires, the run is marked as
 * error and retried on the next tick (for recurring tasks).
 *
 * The store is a tiny pub/sub singleton so React components can subscribe to
 * task-list changes. All mutation methods return the affected record (or void)
 * and notify subscribers synchronously.
 */

import type {
  CreateScheduledTaskInput,
  PreScriptResult,
  ScheduledTaskRecord,
  ScheduledTaskSchedule,
} from "../../preload";

/** Minimum interval for interval-mode recurring tasks. */
const MIN_INTERVAL_MS = 60_000;
/** Coarse tick used to wake the scheduler and check for due tasks. This keeps
 *  drift bounded and avoids one setTimeout per task (which would also leak if
 *  the renderer is throttled in the background). */
const TICK_MS = 5_000;

/** Placeholder inside a task prompt that the pre-script's JSON "output"
 *  field is injected into (replaced with "" when the script provides none). */
export const SCRIPT_OUTPUT_PLACEHOLDER = "{{SCRIPT_OUTPUT}}";
/** Default pre-script timeout (ms). */
export const PRE_SCRIPT_DEFAULT_TIMEOUT_MS = 60_000;
export const PRE_SCRIPT_MIN_TIMEOUT_MS = 1_000;
export const PRE_SCRIPT_MAX_TIMEOUT_MS = 300_000;

type Executor = (prompt: string, taskName: string) => void | Promise<void>;
/** Executes the task's pre-script. Registered by the React hook, which binds
 *  the project directory (cwd) and calls the Rust backend asynchronously. */
type ScriptRunner = (
  command: string,
  options: { timeoutMs: number; env: Record<string, string> }
) => Promise<PreScriptResult>;
type Listener = () => void;

/** Decision produced by parsing a pre-script result. */
export type PreScriptDecision =
  | { action: "run"; promptOverride?: string; output?: string }
  | { action: "skip"; reason: string; output?: string }
  | { action: "error"; errorMessage: string };

const isBrowser =
  typeof window !== "undefined" && typeof window.crypto !== "undefined";

const generateId = (): string => {
  if (isBrowser && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  return `st_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
};

/** Validates and normalizes a schedule, throwing on invalid input. */
export const validateSchedule = (schedule: ScheduledTaskSchedule): void => {
  if (schedule.type !== "once" && schedule.type !== "recurring") {
    throw new Error(
      `Invalid schedule type: "${schedule.type}". Must be "once" or "recurring".`
    );
  }

  if (schedule.type === "once") {
    if (!schedule.executeAt) {
      throw new Error("executeAt is required for a once schedule");
    }
    const ms = Date.parse(schedule.executeAt);
    if (Number.isNaN(ms)) {
      throw new Error(`Invalid executeAt timestamp: "${schedule.executeAt}"`);
    }
    return;
  }

  // recurring
  if (schedule.mode !== "interval" && schedule.mode !== "daily") {
    throw new Error(
      `Invalid recurring mode: "${schedule.mode}". Must be "interval" or "daily".`
    );
  }

  if (schedule.mode === "interval") {
    const interval =
      typeof schedule.intervalMs === "number" ? schedule.intervalMs : NaN;
    if (!Number.isFinite(interval) || interval < MIN_INTERVAL_MS) {
      throw new Error(
        `intervalMs must be a number >= ${MIN_INTERVAL_MS} (1 minute), received ${schedule.intervalMs}`
      );
    }
  } else {
    // daily
    const hour =
      typeof schedule.hour === "number" ? schedule.hour : Number.NaN;
    const minute =
      typeof schedule.minute === "number" ? schedule.minute : Number.NaN;
    if (
      !Number.isInteger(hour) ||
      hour < 0 ||
      hour > 23 ||
      !Number.isInteger(minute) ||
      minute < 0 ||
      minute > 59
    ) {
      throw new Error(
        `hour (0-23) and minute (0-59) are required for a daily schedule, received hour=${schedule.hour}, minute=${schedule.minute}`
      );
    }
  }
};

/** Computes the next fire time (ms epoch) for a schedule, relative to "now". */
const computeNextRunMs = (
  schedule: ScheduledTaskSchedule,
  now: number
): number | null => {
  if (schedule.type === "once") {
    if (!schedule.executeAt) return null;
    const ms = Date.parse(schedule.executeAt);
    return Number.isNaN(ms) ? null : ms;
  }

  if (schedule.mode === "interval") {
    const interval = schedule.intervalMs ?? MIN_INTERVAL_MS;
    // next run = now + interval (aligned from creation for steadiness)
    return now + interval;
  }

  // daily: next occurrence of hour:minute today (or tomorrow if already passed)
  const hour = schedule.hour ?? 0;
  const minute = schedule.minute ?? 0;
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  let target = candidate.getTime();
  if (target <= now) {
    target += 24 * 60 * 60 * 1000;
  }
  return target;
};

/**
 * Pre-script output protocol:
 *  - The last stdout line, when it starts with "{", is parsed as JSON:
 *      {"run": false, "reason": "...", "output": "..."}
 *      {"run": true, "output": "...", "prompt": "..."}
 *    - "run": false -> skip the AI Loop this round (reason recorded)
 *    - "output": injected into the {{SCRIPT_OUTPUT}} placeholder
 *    - "prompt": fully overrides the task prompt (advanced)
 *  - Otherwise the exit code decides: 0 = run, 1 = skip, other = error.
 *  - A timeout always counts as an error.
 */
export const parsePreScriptResult = (
  result: PreScriptResult
): PreScriptDecision => {
  if (result.timedOut) {
    return {
      action: "error",
      errorMessage: `Pre-script timed out: ${result.stderr.trim() || "no output"}`,
    };
  }

  const lastLineJson = tryParseLastLineJson(result.stdout);
  if (lastLineJson) {
    const run = lastLineJson.run;
    const output =
      typeof lastLineJson.output === "string" ? lastLineJson.output : undefined;
    if (run === false) {
      const reason =
        typeof lastLineJson.reason === "string" && lastLineJson.reason.trim()
          ? lastLineJson.reason.trim()
          : "Script requested to skip";
      return { action: "skip", reason, output };
    }
    const promptOverride =
      typeof lastLineJson.prompt === "string" && lastLineJson.prompt.trim()
        ? lastLineJson.prompt.trim()
        : undefined;
    return { action: "run", promptOverride, output };
  }

  if (result.exitCode === 0) {
    return { action: "run" };
  }
  if (result.exitCode === 1) {
    return { action: "skip", reason: "Script exited with code 1" };
  }
  return {
    action: "error",
    errorMessage: `Pre-script exited with code ${result.exitCode}${
      result.stderr.trim() ? `: ${truncateText(result.stderr.trim(), 500)}` : ""
    }`,
  };
};

/** Replaces every {{SCRIPT_OUTPUT}} occurrence in the prompt with the script
 *  output (or "" when the script provided none). */
export const applyScriptOutput = (
  prompt: string,
  output: string | undefined
): string => {
  if (!prompt.includes(SCRIPT_OUTPUT_PLACEHOLDER)) return prompt;
  const injected = output ?? "";
  return prompt.split(SCRIPT_OUTPUT_PLACEHOLDER).join(injected);
};

/** Parses the last stdout line as a JSON object; returns null when absent or
 *  not an object (e.g. plain script output, parse failure). */
const tryParseLastLineJson = (
  stdout: string
): Record<string, unknown> | null => {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const lines = trimmed.split("\n");
  const lastLine = lines[lines.length - 1]?.trim() ?? "";
  if (!lastLine.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(lastLine) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
};

const truncateText = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}...`;

class ScheduledTasksStore {
  private tasks = new Map<string, ScheduledTaskRecord>();
  private listeners = new Set<Listener>();
  private executor: Executor | null = null;
  private scriptRunner: ScriptRunner | null = null;

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  /** Currently in-flight execution task ids, to prevent overlapping runs. */
  private runningIds = new Set<string>();

  /** Starts the coarse tick loop. Safe to call multiple times. */
  private ensureTick = (): void => {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      void this.dueTasks();
    }, TICK_MS);
    // Don't keep the Node/Electron process alive solely for the scheduler.
    if (this.tickTimer && typeof this.tickTimer.unref === "function") {
      this.tickTimer.unref();
    }
  };

  private stopTick = (): void => {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  };

  /** Registers the AI Loop executor (buildFromContent). */
  setExecutor = (executor: Executor): (() => void) => {
    this.executor = executor;
    return () => {
      if (this.executor === executor) {
        this.executor = null;
      }
    };
  };

  /** Registers the pre-script runner (Rust backend via preload). */
  setScriptRunner = (runner: ScriptRunner): (() => void) => {
    this.scriptRunner = runner;
    return () => {
      if (this.scriptRunner === runner) {
        this.scriptRunner = null;
      }
    };
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private notify = (): void => {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Listener errors must not break the scheduler.
      }
    }
  };

  list = (directoryId?: string): ScheduledTaskRecord[] => {
    return Array.from(this.tasks.values())
      .filter(
        (task) =>
          directoryId === undefined || task.directoryId === directoryId
      )
      .sort((a, b) => {
        // Sort: running/pending first, then by nextRunAt, then createdAt
        const aRank =
          a.status === "running" ? 0 : a.status === "pending" ? 1 : 2;
        const bRank =
          b.status === "running" ? 0 : b.status === "pending" ? 1 : 2;
        if (aRank !== bRank) return aRank - bRank;
        const aNext = a.nextRunAt ? Date.parse(a.nextRunAt) : Number.MAX_SAFE_INTEGER;
        const bNext = b.nextRunAt ? Date.parse(b.nextRunAt) : Number.MAX_SAFE_INTEGER;
        if (aNext !== bNext) return aNext - bNext;
        return Date.parse(a.createdAt) - Date.parse(b.createdAt);
      });
  };

  create = (input: CreateScheduledTaskInput): ScheduledTaskRecord => {
    const directoryId = (input.directoryId ?? "").trim();
    if (!directoryId) {
      throw new Error("directoryId is required");
    }
    const name = (input.name ?? "").trim();
    if (!name) {
      throw new Error("name is required");
    }
    const prompt = (input.prompt ?? "").trim();
    if (!prompt) {
      throw new Error("prompt is required");
    }
    validateSchedule(input.schedule);

    // Optional pre-script fields
    const preScript = (input.preScript ?? "").trim();
    const preScriptTimeoutMs =
      input.preScriptTimeoutMs ?? PRE_SCRIPT_DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(preScriptTimeoutMs)) {
      throw new Error("preScriptTimeoutMs must be a number");
    }
    if (
      preScriptTimeoutMs < PRE_SCRIPT_MIN_TIMEOUT_MS ||
      preScriptTimeoutMs > PRE_SCRIPT_MAX_TIMEOUT_MS
    ) {
      throw new Error(
        `preScriptTimeoutMs must be between ${PRE_SCRIPT_MIN_TIMEOUT_MS} and ${PRE_SCRIPT_MAX_TIMEOUT_MS} ms, received ${preScriptTimeoutMs}`
      );
    }
    const runOnScriptError = input.runOnScriptError === true;

    const now = Date.now();
    const nextRunMs = computeNextRunMs(input.schedule, now);
    const record: ScheduledTaskRecord = {
      id: generateId(),
      directoryId,
      name,
      prompt,
      schedule: input.schedule,
      status: "pending",
      paused: false,
      preScript: preScript || undefined,
      preScriptTimeoutMs,
      runOnScriptError,
      createdAt: new Date(now).toISOString(),
      nextRunAt:
        nextRunMs != null ? new Date(nextRunMs).toISOString() : undefined,
      runCount: 0,
      skipCount: 0,
    };
    this.tasks.set(record.id, record);
    this.ensureTick();
    this.notify();
    return record;
  };

  remove = (id: string): void => {
    if (this.tasks.delete(id)) {
      this.runningIds.delete(id);
      if (this.tasks.size === 0) {
        this.stopTick();
      }
      this.notify();
    }
  };

  clear = (directoryId?: string): void => {
    if (directoryId === undefined) {
      // Clear everything (e.g. process exit / global reset).
      this.tasks.clear();
      this.runningIds.clear();
      this.stopTick();
      this.notify();
      return;
    }
    // Clear only tasks belonging to the given project directory.
    let cleared = false;
    for (const [id, task] of this.tasks) {
      if (task.directoryId === directoryId) {
        this.tasks.delete(id);
        this.runningIds.delete(id);
        cleared = true;
      }
    }
    if (cleared) {
      if (this.tasks.size === 0) {
        this.stopTick();
      }
      this.notify();
    }
  };

  togglePause = (id: string): ScheduledTaskRecord | null => {
    const task = this.tasks.get(id);
    if (!task) return null;
    const updated: ScheduledTaskRecord = {
      ...task,
      paused: !task.paused,
      status: !task.paused ? "pending" : task.status,
      nextRunAt: !task.paused
        ? new Date(
            computeNextRunMs(task.schedule, Date.now()) ?? Date.now()
          ).toISOString()
        : undefined,
    };
    this.tasks.set(id, updated);
    this.notify();
    return updated;
  };

  /** Triggers all tasks whose nextRunAt is due and not paused/running. */
  private dueTasks = async (): Promise<void> => {
    const now = Date.now();
    const due: ScheduledTaskRecord[] = [];
    for (const task of this.tasks.values()) {
      if (task.paused) continue;
      if (task.status === "running") continue;
      if (task.status === "completed") continue; // once-task already fired
      if (!task.nextRunAt) continue;
      const nextMs = Date.parse(task.nextRunAt);
      if (Number.isNaN(nextMs) || nextMs > now) continue;
      due.push(task);
    }

    for (const task of due) {
      await this.execute(task.id).catch(() => undefined);
    }
  };

  /** Executes a single task immediately (used by scheduler tick + "run now"). */
  execute = async (id: string): Promise<void> => {
    const task = this.tasks.get(id);
    if (!task) return;
    if (this.runningIds.has(id)) return; // already running

    const executor = this.executor;
    this.runningIds.add(id);

    // Mark running
    this.tasks.set(id, {
      ...task,
      status: "running",
      lastRunAt: new Date().toISOString(),
    });
    this.notify();

    try {
      if (!executor) {
        throw new Error("No executor registered (AI Loop unavailable)");
      }

      let prompt = task.prompt;

      if (task.preScript) {
        let decision: PreScriptDecision;
        try {
          decision = await this.evaluatePreScript(task);
        } catch (error) {
          // Script infrastructure failure (no runner, IPC error, ...)
          decision = {
            action: "error",
            errorMessage:
              error instanceof Error
                ? `Pre-script failed to start: ${error.message}`
                : "Pre-script failed to start",
          };
        }

        if (decision.action === "skip") {
          this.logSkip(task, decision);
          const after = this.tasks.get(id);
          if (after) {
            this.tasks.set(id, this.advanceSchedule(after, undefined, decision));
          }
          return;
        }

        if (decision.action === "error" && !task.runOnScriptError) {
          this.logScriptError(task, decision);
          const after = this.tasks.get(id);
          if (after) {
            this.tasks.set(
              id,
              this.advanceSchedule(after, new Error(decision.errorMessage))
            );
          }
          return;
        }

        // run: apply placeholder injection / prompt override
        if (decision.action === "error") {
          // runOnScriptError: inform the AI Loop about the script failure
          prompt = `${task.prompt}\n\n[Pre-script failed: ${decision.errorMessage}]`;
        } else {
          prompt = applyScriptOutput(
            decision.promptOverride ?? task.prompt,
            decision.output
          );
        }
      }

      await executor(prompt, task.name);

      const after = this.tasks.get(id);
      if (after) {
        const next = this.advanceSchedule(after);
        this.tasks.set(id, next);
      }
    } catch (error) {
      const after = this.tasks.get(id);
      if (after) {
        const next = this.advanceSchedule(after, error);
        this.tasks.set(id, next);
      }
    } finally {
      this.runningIds.delete(id);
      this.notify();
    }
  };

  /** Runs the task's pre-script and parses its decision. */
  private evaluatePreScript = async (
    task: ScheduledTaskRecord
  ): Promise<PreScriptDecision> => {
    const runner = this.scriptRunner;
    if (!runner) {
      throw new Error("No script runner registered (pre-script unavailable)");
    }
    const result = await runner(task.preScript ?? "", {
      timeoutMs: task.preScriptTimeoutMs ?? PRE_SCRIPT_DEFAULT_TIMEOUT_MS,
      env: this.buildScriptEnv(task),
    });
    return parsePreScriptResult(result);
  };

  /** Builds the environment variables exposed to the pre-script. */
  private buildScriptEnv = (
    task: ScheduledTaskRecord
  ): Record<string, string> => {
    return {
      SNOW_TASK_NAME: task.name,
      SNOW_TASK_PROMPT: task.prompt,
      SNOW_RUN_COUNT: String(task.runCount),
      SNOW_SKIP_COUNT: String(task.skipCount),
      SNOW_LAST_RUN_AT: task.lastRunAt ?? "",
      SNOW_LAST_SKIP_REASON: task.lastSkipReason ?? "",
    };
  };

  /** Records a skipped run into app logs (script output preserved). */
  private logSkip = (
    task: ScheduledTaskRecord,
    decision: Extract<PreScriptDecision, { action: "skip" }>
  ): void => {
    this.writeTaskLog(task, {
      message: `Pre-script skipped the AI Loop for scheduled task "${task.name}"`,
      output: decision.output ?? "",
      context: decision.reason,
    });
  };

  /** Records a script failure into app logs. */
  private logScriptError = (
    task: ScheduledTaskRecord,
    decision: Extract<PreScriptDecision, { action: "error" }>
  ): void => {
    this.writeTaskLog(task, {
      message: `Pre-script failed for scheduled task "${task.name}": ${decision.errorMessage}`,
      context: decision.errorMessage,
    });
  };

  /** Best-effort app log write (window.snow.writeLog -> Rust app_logs). */
  private writeTaskLog = (
    task: ScheduledTaskRecord,
    entry: { message: string; output?: string; context?: string }
  ): void => {
    try {
      const writeLog = (window as unknown as {
        snow?: { writeLog?: (level: string, entry: unknown) => Promise<void> };
      })?.snow?.writeLog;
      if (!writeLog) return;
      void writeLog("INFO", {
        module: "scheduled-task",
        func: task.name,
        message: entry.message,
        input: task.preScript,
        output: entry.output,
        context: entry.context,
      });
    } catch {
      // Logging failures must never break the scheduler.
    }
  };

  /** Computes the next record state after a run (success, error or skip). */
  private advanceSchedule = (
    task: ScheduledTaskRecord,
    error?: unknown,
    skip?: Extract<PreScriptDecision, { action: "skip" }>
  ): ScheduledTaskRecord => {
    const now = new Date().toISOString();

    // skip: the AI Loop did not run; once-tasks are finished, recurring ones
    // advance to the next occurrence. runCount is NOT incremented.
    if (skip) {
      const skipCount = task.skipCount + 1;
      if (task.schedule.type === "once") {
        return {
          ...task,
          status: "completed",
          skipCount,
          lastSkippedAt: now,
          lastSkipReason: skip.reason,
          lastError: undefined,
          nextRunAt: undefined,
        };
      }
      const nextRunMs = computeNextRunMs(task.schedule, Date.now());
      return {
        ...task,
        status: "pending",
        skipCount,
        lastSkippedAt: now,
        lastSkipReason: skip.reason,
        lastError: undefined,
        nextRunAt:
          nextRunMs != null ? new Date(nextRunMs).toISOString() : undefined,
      };
    }

    const errorMessage =
      error instanceof Error
        ? error.message
        : typeof error === "string"
        ? error
        : "Unknown error";

    const runCount = task.runCount + 1;
    const lastRunAt = now;

    // once-task: after firing it's done regardless of success
    if (task.schedule.type === "once") {
      return {
        ...task,
        status: error ? "error" : "completed",
        runCount,
        lastRunAt,
        lastError: error ? errorMessage : undefined,
        nextRunAt: undefined,
      };
    }

    // recurring: schedule next run even on error (so transient failures recover)
    const nextRunMs = computeNextRunMs(task.schedule, Date.now());
    return {
      ...task,
      status: "pending",
      runCount,
      lastRunAt,
      lastError: error ? errorMessage : undefined,
      nextRunAt:
        nextRunMs != null ? new Date(nextRunMs).toISOString() : undefined,
    };
  };

  /** Manually trigger a task run now (UI "Run now" button). */
  runNow = (id: string): Promise<void> => {
    return this.execute(id);
  };
}

/**
 * Process-wide singleton. Because the store is module-level and holds timers,
 * it dies with the renderer process — satisfying requirement #4. We expose a
 * single instance to both the React hook layer and the app-control bridge.
 */
export const scheduledTasksStore = new ScheduledTasksStore();
