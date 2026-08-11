import {
  AlertCircle,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Clock,
  FileCode2,
  Loader2,
  Pause,
  Play,
  Plus,
  Repeat,
  RotateCw,
  SkipForward,
  Trash2,
  Zap,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import { useI18n } from "../../i18n";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { Modal } from "../common/Modal";
import { useScheduledTasks } from "../../hooks/useScheduledTasks";
import { validateSchedule } from "../../hooks/scheduledTasksStore";
import type {
  ScheduledTaskRecord,
  ScheduledTaskSchedule,
  ScheduledTaskType,
} from "../../../preload";

type RecurringMode = "interval" | "daily";

type ScheduledTasksModalProps = {
  open: boolean;
  directoryId: string;
  directoryPath: string;
  onClose: () => void;
};

const PREVIEW_MAX_LEN = 100;

const previewPrompt = (prompt: string): string => {
  const plain = prompt.replace(/\s+/g, " ").trim();
  if (plain.length <= PREVIEW_MAX_LEN) return plain;
  return plain.slice(0, PREVIEW_MAX_LEN) + "...";
};

/** Formats an ISO timestamp (or epoch ms) into a localized relative/absolute label. */
const formatRunTime = (iso: string | undefined): string => {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const date = new Date(ms);
  const now = Date.now();
  const diffMs = ms - now;
  const absMin = Math.abs(Math.round(diffMs / 60000));
  if (absMin < 1) return date.toLocaleTimeString();
  if (absMin < 60) {
    return diffMs >= 0
      ? `in ${absMin}m`
      : `${absMin}m ago`;
  }
  const absHr = Math.round(absMin / 60);
  if (absHr < 24) {
    return diffMs >= 0 ? `in ${absHr}h` : `${absHr}h ago`;
  }
  return date.toLocaleString();
};

const formatSchedule = (
  schedule: ScheduledTaskSchedule,
  t: (key: string, opts?: { defaultValue?: string; values?: Record<string, string | number> }) => string
): string => {
  if (schedule.type === "once") {
    const ms = schedule.executeAt ? Date.parse(schedule.executeAt) : NaN;
    if (Number.isNaN(ms)) return t("scheduledTask.invalidSchedule", { defaultValue: "Invalid" });
    return new Date(ms).toLocaleString();
  }
  if (schedule.mode === "interval") {
    const interval = schedule.intervalMs ?? 0;
    const minutes = Math.round(interval / 60000);
    if (minutes >= 60 && minutes % 60 === 0) {
      const hours = minutes / 60;
      return t("scheduledTask.everyHours", {
        values: { hours },
        defaultValue: `Every ${hours}h`,
      });
    }
    return t("scheduledTask.everyMinutes", {
      values: { minutes },
      defaultValue: `Every ${minutes}m`,
    });
  }
  // daily
  const hour = schedule.hour ?? 0;
  const minute = schedule.minute ?? 0;
  const time = `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
  return t("scheduledTask.dailyAt", {
    values: { time },
    defaultValue: `Daily at ${time}`,
  });
};

const pad2 = (n: number): string => n.toString().padStart(2, "0");

/** Builds a local datetime-local string (yyyy-MM-ddThh:mm) from epoch ms. */
const toLocalDateTimeInput = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(
    d.getDate()
  )}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

export function ScheduledTasksModal({
  open,
  directoryId,
  directoryPath,
  onClose,
}: ScheduledTasksModalProps): React.JSX.Element {
  const { t } = useI18n();
  const {
    tasks,
    createTask,
    removeTask,
    clearTasks,
    togglePauseTask,
    runTaskNow,
    isExecutorReady,
  } = useScheduledTasks(directoryId, directoryPath);

  // Form state
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [taskType, setTaskType] = useState<ScheduledTaskType>("once");
  const [recurringMode, setRecurringMode] = useState<RecurringMode>("interval");
  // once: datetime-local string
  const [executeAtLocal, setExecuteAtLocal] = useState<string>(() =>
    toLocalDateTimeInput(Date.now() + 60_000)
  );
  // interval: value + unit
  const [intervalValue, setIntervalValue] = useState("5");
  const [intervalUnit, setIntervalUnit] = useState<"minutes" | "hours">(
    "minutes"
  );
  // daily: hour/minute
  const [dailyHour, setDailyHour] = useState("9");
  const [dailyMinute, setDailyMinute] = useState("0");
  // pre-script (optional)
  const [preScriptOpen, setPreScriptOpen] = useState(false);
  const [preScript, setPreScript] = useState("");
  const [preScriptTimeout, setPreScriptTimeout] = useState("60");
  const [runOnScriptError, setRunOnScriptError] = useState(false);

  const [formError, setFormError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ScheduledTaskRecord | null>(
    null
  );
  const [clearOpen, setClearOpen] = useState(false);

  // Reset form fields when modal opens
  useEffect(() => {
    if (open) {
      setFormError(null);
    }
  }, [open]);

  const buildSchedule = useCallback((): ScheduledTaskSchedule => {
    if (taskType === "once") {
      const ms = Date.parse(`${executeAtLocal}:00`);
      return {
        type: "once",
        executeAt: Number.isNaN(ms)
          ? executeAtLocal
          : new Date(ms).toISOString(),
      };
    }
    if (recurringMode === "interval") {
      const value = Number.parseFloat(intervalValue);
      const unitMs = intervalUnit === "hours" ? 3_600_000 : 60_000;
      return {
        type: "recurring",
        mode: "interval",
        intervalMs: Number.isFinite(value) ? value * unitMs : 0,
      };
    }
    return {
      type: "recurring",
      mode: "daily",
      hour: Number.parseInt(dailyHour, 10),
      minute: Number.parseInt(dailyMinute, 10),
    };
  }, [
    taskType,
    recurringMode,
    executeAtLocal,
    intervalValue,
    intervalUnit,
    dailyHour,
    dailyMinute,
  ]);

  const handleCreate = useCallback(async (): Promise<void> => {
    setFormError(null);
    if (!directoryId) {
      setFormError(t("scheduledTask.errorNoProject", { defaultValue: "No active project directory" }));
      return;
    }
    const trimmedName = name.trim();
    const trimmedPrompt = prompt.trim();
    if (!trimmedName) {
      setFormError(t("scheduledTask.errorNameRequired", { defaultValue: "Name is required" }));
      return;
    }
    if (!trimmedPrompt) {
      setFormError(t("scheduledTask.errorPromptRequired", { defaultValue: "Prompt is required" }));
      return;
    }
    const schedule = buildSchedule();
    try {
      validateSchedule(schedule);
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : t("scheduledTask.errorInvalidSchedule", {
              defaultValue: "Invalid schedule",
            })
      );
      return;
    }
    const trimmedPreScript = preScript.trim();
    const timeoutValue = Number.parseFloat(preScriptTimeout);
    if (trimmedPreScript && !Number.isFinite(timeoutValue)) {
      setFormError(
        t("scheduledTask.errorInvalidTimeout", {
          defaultValue: "Pre-script timeout must be a number",
        })
      );
      return;
    }
    setIsCreating(true);
    try {
      createTask({
        name: trimmedName,
        prompt: trimmedPrompt,
        schedule,
        preScript: trimmedPreScript || undefined,
        preScriptTimeoutMs: trimmedPreScript
          ? Math.round(timeoutValue * 1000)
          : undefined,
        runOnScriptError: trimmedPreScript ? runOnScriptError : undefined,
      });
      // Reset form for next entry
      setName("");
      setPrompt("");
      setPreScript("");
      setPreScriptTimeout("60");
      setRunOnScriptError(false);
      setPreScriptOpen(false);
      setFormError(null);
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : t("scheduledTask.errorCreateFailed", {
              defaultValue: "Failed to create task",
            })
      );
    } finally {
      setIsCreating(false);
    }
  }, [directoryId, name, prompt, buildSchedule, createTask, t]);

  const confirmDelete = useCallback((): void => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (target) removeTask(target.id);
  }, [deleteTarget, removeTask]);

  const confirmClear = useCallback((): void => {
    setClearOpen(false);
    clearTasks();
  }, [clearTasks]);

  const sortedTasks = useMemo(() => tasks, [tasks]);

  const renderTaskItem = (task: ScheduledTaskRecord): React.JSX.Element => {
    const statusKey =
      task.status === "running"
        ? "running"
        : task.status === "completed"
        ? "completed"
        : task.status === "error"
        ? "error"
        : task.paused
        ? "paused"
        : "pending";

    const statusLabel = t(`scheduledTask.status_${statusKey}`, {
      defaultValue: task.status,
    });

    return (
      <div className="scheduled-task-item" key={task.id}>
        <div className="scheduled-task-item-main">
          <div className="scheduled-task-item-header">
            <span className="scheduled-task-item-name">{task.name}</span>
            <span
              className={`scheduled-task-item-status-badge ${statusKey}`}
            >
              {statusLabel}
            </span>
          </div>
          <div className="scheduled-task-item-prompt">
            {previewPrompt(task.prompt)}
          </div>
          {task.preScript && (
            <div
              className="scheduled-task-item-script"
              title={task.preScript}
            >
              <FileCode2 size={12} strokeWidth={1.8} />
              {previewPrompt(task.preScript)}
            </div>
          )}
          <div className="scheduled-task-item-meta">
            <span className="scheduled-task-item-schedule" title={formatSchedule(task.schedule, t)}>
              {task.schedule.type === "once" ? (
                <CalendarClock size={12} strokeWidth={1.8} />
              ) : task.schedule.mode === "daily" ? (
                <Clock size={12} strokeWidth={1.8} />
              ) : (
                <Repeat size={12} strokeWidth={1.8} />
              )}
              {formatSchedule(task.schedule, t)}
            </span>
            {task.nextRunAt && (
              <span className="scheduled-task-item-next">
                <Zap size={12} strokeWidth={1.8} />
                {t("scheduledTask.nextRun")}: {formatRunTime(task.nextRunAt)}
              </span>
            )}
          </div>
          {(task.lastRunAt || task.runCount > 0 || task.lastError || task.skipCount > 0) && (
            <div className="scheduled-task-item-meta sub">
              {task.lastRunAt && (
                <span className="scheduled-task-item-last">
                  {t("scheduledTask.lastRun")}: {formatRunTime(task.lastRunAt)}
                </span>
              )}
              {task.runCount > 0 && (
                <span className="scheduled-task-item-runs">
                  {t("scheduledTask.runCount", {
                    values: { count: task.runCount },
                    defaultValue: `${task.runCount} runs`,
                  })}
                </span>
              )}
              {task.skipCount > 0 && (
                <span
                  className="scheduled-task-item-skipped"
                  title={task.lastSkipReason}
                >
                  <SkipForward size={12} strokeWidth={1.8} />
                  {t("scheduledTask.skipCount", {
                    values: { count: task.skipCount },
                    defaultValue: `${task.skipCount} skipped`,
                  })}
                  {task.lastSkipReason
                    ? ` · ${previewPrompt(task.lastSkipReason)}`
                    : ""}
                </span>
              )}
              {task.lastError && (
                <span
                  className="scheduled-task-item-error"
                  title={task.lastError}
                >
                  <AlertCircle size={12} strokeWidth={1.8} />
                  {task.lastError}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="scheduled-task-item-actions">
          <button
            aria-label={t("scheduledTask.runNow", { defaultValue: "Run now" })}
            className="scheduled-task-icon-btn"
            disabled={task.status === "running" || task.status === "completed"}
            onClick={() => void runTaskNow(task.id)}
            title={t("scheduledTask.runNow", { defaultValue: "Run now" })}
            type="button"
          >
            {task.status === "running" ? (
              <Loader2 className="spin" size={14} strokeWidth={2} />
            ) : (
              <RotateCw size={14} strokeWidth={1.8} />
            )}
          </button>
          {task.schedule.type === "recurring" && (
            <button
              aria-label={
                task.paused
                  ? t("scheduledTask.resume", { defaultValue: "Resume" })
                  : t("scheduledTask.pause", { defaultValue: "Pause" })
              }
              className="scheduled-task-icon-btn"
              onClick={() => togglePauseTask(task.id)}
              title={
                task.paused
                  ? t("scheduledTask.resume", { defaultValue: "Resume" })
                  : t("scheduledTask.pause", { defaultValue: "Pause" })
              }
              type="button"
            >
              {task.paused ? (
                <Play size={14} strokeWidth={1.8} />
              ) : (
                <Pause size={14} strokeWidth={1.8} />
              )}
            </button>
          )}
          <button
            aria-label={t("scheduledTask.delete", { defaultValue: "Delete" })}
            className="scheduled-task-icon-btn danger"
            onClick={() => setDeleteTarget(task)}
            title={t("scheduledTask.delete", { defaultValue: "Delete" })}
            type="button"
          >
            <Trash2 size={14} strokeWidth={1.8} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <Modal
      className="scheduled-tasks-modal"
      closeLabel={t("scheduledTask.close", { defaultValue: "Close" })}
      onClose={onClose}
      open={open}
      size="large"
      title={t("scheduledTask.title", { defaultValue: "Scheduled Tasks" })}
    >
      <div className="scheduled-tasks-modal-layout">
        {/* Left: task list */}
        <div className="scheduled-tasks-sidebar">
          <div className="scheduled-tasks-sidebar-header">
            <div className="scheduled-tasks-count">
              {t("scheduledTask.taskCount", {
                values: { count: tasks.length },
                defaultValue: `${tasks.length} tasks`,
              })}
            </div>
            {tasks.length > 0 && (
              <button
                className="scheduled-tasks-clear-btn"
                onClick={() => setClearOpen(true)}
                title={t("scheduledTask.clearAll", { defaultValue: "Clear all" })}
                type="button"
              >
                <Trash2 size={13} strokeWidth={1.8} />
              </button>
            )}
          </div>
          <div className="scheduled-tasks-list-scroll">
            {tasks.length === 0 ? (
              <div className="scheduled-tasks-empty">
                <Clock size={28} strokeWidth={1.4} />
                <span>
                  {t("scheduledTask.emptyHint", {
                    defaultValue:
                      "No scheduled tasks yet. Create one on the right.",
                  })}
                </span>
              </div>
            ) : (
              sortedTasks.map(renderTaskItem)
            )}
          </div>
          {!isExecutorReady && (
            <div className="scheduled-tasks-warning">
              <AlertCircle size={13} strokeWidth={1.8} />
              <span>
                {t("scheduledTask.executorUnavailable", {
                  defaultValue:
                    "AI Loop unavailable — tasks will not run until the chat is ready.",
                })}
              </span>
            </div>
          )}
          <div className="scheduled-tasks-lifetime-hint">
            {t("scheduledTask.lifetimeHint", {
              defaultValue:
                "Tasks run only while the app is open and are cleared on exit.",
            })}
          </div>
        </div>

        {/* Right: create form */}
        <div className="scheduled-tasks-content">
          <div className="scheduled-tasks-form">
            <div className="scheduled-tasks-form-header">
              <Plus size={16} strokeWidth={2} />
              <span>{t("scheduledTask.createNew", { defaultValue: "New scheduled task" })}</span>
            </div>

            <label className="scheduled-tasks-field">
              <span>{t("scheduledTask.name", { defaultValue: "Name" })}</span>
              <input
                onChange={(e) => setName(e.target.value)}
                placeholder={t("scheduledTask.namePlaceholder", {
                  defaultValue: "e.g. Daily code review reminder",
                })}
                type="text"
                value={name}
              />
            </label>

            <div className="scheduled-tasks-pre-script">
              <button
                className="scheduled-tasks-pre-script-toggle"
                onClick={() => setPreScriptOpen((open) => !open)}
                type="button"
              >
                {preScriptOpen ? (
                  <ChevronDown size={13} strokeWidth={1.9} />
                ) : (
                  <ChevronRight size={13} strokeWidth={1.9} />
                )}
                <FileCode2 size={13} strokeWidth={1.9} />
                <span>
                  {t("scheduledTask.preScript", {
                    defaultValue: "Pre-script (optional)",
                  })}
                </span>
              </button>
              {preScriptOpen && (
                <div className="scheduled-tasks-pre-script-body">
                  <label className="scheduled-tasks-field">
                    <span>
                      {t("scheduledTask.preScriptCommand", {
                        defaultValue: "Shell command",
                      })}
                    </span>
                    <textarea
                      className="scheduled-tasks-script-textarea"
                      onChange={(e) => setPreScript(e.target.value)}
                      placeholder={t("scheduledTask.preScriptPlaceholder", {
                        defaultValue:
                          "e.g. git diff --quiet || exit 1",
                      })}
                      rows={3}
                      value={preScript}
                    />
                  </label>
                  <div className="scheduled-tasks-pre-script-hint">
                    {t("scheduledTask.preScriptHint", {
                      defaultValue:
                        "Exit 0 = run AI, exit 1 = skip. Or print a JSON line: {\\\"run\\\":false,\\\"reason\\\":\\\"...\\\",\\\"output\\\":\\\"...\\\"} — \\\"output\\\" fills the {{SCRIPT_OUTPUT}} placeholder in the prompt.",
                    })}
                  </div>
                  <div className="scheduled-tasks-field-row">
                    <label className="scheduled-tasks-field">
                      <span>
                        {t("scheduledTask.preScriptTimeout", {
                          defaultValue: "Timeout (s)",
                        })}
                      </span>
                      <input
                        min="1"
                        max="300"
                        onChange={(e) => setPreScriptTimeout(e.target.value)}
                        type="number"
                        value={preScriptTimeout}
                      />
                    </label>
                    <label className="toggle-switch scheduled-tasks-switch-field">
                      <input
                        checked={runOnScriptError}
                        onChange={(e) => setRunOnScriptError(e.target.checked)}
                        type="checkbox"
                      />
                      <span className="toggle-slider" />
                      <span>
                        {t("scheduledTask.runOnScriptError", {
                          defaultValue: "Run AI even if the script fails",
                        })}
                      </span>
                    </label>
                  </div>
                </div>
              )}
            </div>

            <label className="scheduled-tasks-field">
              <span>{t("scheduledTask.prompt", { defaultValue: "Prompt" })}</span>
              <textarea
                className="scheduled-tasks-prompt-textarea"
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={t("scheduledTask.promptPlaceholder", {
                  defaultValue:
                    "Prompt sent to the AI Loop on each run. The task has access to all tools.",
                })}
                rows={5}
                value={prompt}
              />
            </label>

            <div className="scheduled-tasks-field">
              <span>{t("scheduledTask.taskType", { defaultValue: "Task type" })}</span>
              <div className="scheduled-tasks-segmented">
                <button
                  className={`scheduled-tasks-segmented-btn${taskType === "once" ? " active" : ""}`}
                  onClick={() => setTaskType("once")}
                  type="button"
                >
                  <CalendarClock size={13} strokeWidth={1.9} />
                  {t("scheduledTask.typeOnce", { defaultValue: "Once" })}
                </button>
                <button
                  className={`scheduled-tasks-segmented-btn${taskType === "recurring" ? " active" : ""}`}
                  onClick={() => setTaskType("recurring")}
                  type="button"
                >
                  <Repeat size={13} strokeWidth={1.9} />
                  {t("scheduledTask.typeRecurring", { defaultValue: "Recurring" })}
                </button>
              </div>
            </div>

            {taskType === "once" ? (
              <label className="scheduled-tasks-field">
                <span>
                  {t("scheduledTask.startTime", { defaultValue: "Start time" })}
                </span>
                <input
                  onChange={(e) => setExecuteAtLocal(e.target.value)}
                  type="datetime-local"
                  value={executeAtLocal}
                />
              </label>
            ) : (
              <>
                <div className="scheduled-tasks-field">
                  <span>
                    {t("scheduledTask.recurringMode", {
                      defaultValue: "Repeat mode",
                    })}
                  </span>
                  <div className="scheduled-tasks-segmented">
                    <button
                      className={`scheduled-tasks-segmented-btn${recurringMode === "interval" ? " active" : ""}`}
                      onClick={() => setRecurringMode("interval")}
                      type="button"
                    >
                      <Repeat size={13} strokeWidth={1.9} />
                      {t("scheduledTask.modeInterval", { defaultValue: "Interval" })}
                    </button>
                    <button
                      className={`scheduled-tasks-segmented-btn${recurringMode === "daily" ? " active" : ""}`}
                      onClick={() => setRecurringMode("daily")}
                      type="button"
                    >
                      <Clock size={13} strokeWidth={1.9} />
                      {t("scheduledTask.modeDaily", { defaultValue: "Daily" })}
                    </button>
                  </div>
                </div>

                {recurringMode === "interval" ? (
                  <div className="scheduled-tasks-field-row">
                    <label className="scheduled-tasks-field">
                      <span>
                        {t("scheduledTask.intervalValue", {
                          defaultValue: "Every",
                        })}
                      </span>
                      <input
                        min="1"
                        onChange={(e) => setIntervalValue(e.target.value)}
                        type="number"
                        value={intervalValue}
                      />
                    </label>
                    <label className="scheduled-tasks-field">
                      <span>
                        {t("scheduledTask.intervalUnit", {
                          defaultValue: "Unit",
                        })}
                      </span>
                      <select
                        onChange={(e) =>
                          setIntervalUnit(e.target.value as "minutes" | "hours")
                        }
                        value={intervalUnit}
                      >
                        <option value="minutes">
                          {t("scheduledTask.unitMinutes", { defaultValue: "minutes" })}
                        </option>
                        <option value="hours">
                          {t("scheduledTask.unitHours", { defaultValue: "hours" })}
                        </option>
                      </select>
                    </label>
                  </div>
                ) : (
                  <div className="scheduled-tasks-field-row">
                    <label className="scheduled-tasks-field">
                      <span>
                        {t("scheduledTask.dailyHour", { defaultValue: "Hour" })}
                      </span>
                      <select
                        onChange={(e) => setDailyHour(e.target.value)}
                        value={dailyHour}
                      >
                        {Array.from({ length: 24 }, (_, h) => h).map((h) => (
                          <option key={h} value={h.toString()}>
                            {pad2(h)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="scheduled-tasks-field">
                      <span>
                        {t("scheduledTask.dailyMinute", {
                          defaultValue: "Minute",
                        })}
                      </span>
                      <select
                        onChange={(e) => setDailyMinute(e.target.value)}
                        value={dailyMinute}
                      >
                        {[0, 15, 30, 45].map((m) => (
                          <option key={m} value={m.toString()}>
                            {pad2(m)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}
              </>
            )}

            {formError && (
              <div className="scheduled-tasks-form-error">
                <AlertCircle size={14} strokeWidth={1.8} />
                <span>{formError}</span>
              </div>
            )}

            <button
              className="scheduled-tasks-create-btn"
              disabled={isCreating || !directoryId}
              onClick={() => void handleCreate()}
              type="button"
            >
              {isCreating ? (
                <Loader2 className="spin" size={15} strokeWidth={2.2} />
              ) : (
                <Plus size={15} strokeWidth={2.2} />
              )}
              {t("scheduledTask.create", { defaultValue: "Create task" })}
            </button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        cancelLabel={t("scheduledTask.cancelDelete", { defaultValue: "Cancel" })}
        confirmLabel={t("scheduledTask.delete", { defaultValue: "Delete" })}
        message={t("scheduledTask.confirmDelete", {
          defaultValue: "Delete this scheduled task?",
          values: { name: deleteTarget?.name ?? "" },
        })}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        open={deleteTarget !== null}
        title={t("scheduledTask.delete", { defaultValue: "Delete" })}
        variant="danger"
      />
      <ConfirmDialog
        cancelLabel={t("scheduledTask.cancelDelete", { defaultValue: "Cancel" })}
        confirmLabel={t("scheduledTask.clearAll", { defaultValue: "Clear all" })}
        message={t("scheduledTask.confirmClearAll", {
          defaultValue: "Remove all scheduled tasks? This cannot be undone.",
        })}
        onCancel={() => setClearOpen(false)}
        onConfirm={confirmClear}
        open={clearOpen}
        title={t("scheduledTask.clearAll", { defaultValue: "Clear all" })}
        variant="danger"
      />
    </Modal>
  );
}
