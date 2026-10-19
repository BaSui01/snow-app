import { useCallback, useEffect, useRef, useState } from "react";

import { useChatConversationContext } from "../components/mainContent/chatMessages";
import { scheduledTasksStore, validateSchedule } from "./scheduledTasksStore";
import type {
  CreateScheduledTaskInput,
  ScheduledTaskRecord,
  UpdateScheduledTaskInput,
} from "../../preload";

/** Create input with an optional project override: omitted = the current
 *  project; "" = global task. */
type CreateTaskInput = Omit<CreateScheduledTaskInput, "directoryId"> & {
  directoryId?: string;
};

/**
 * React bridge for the scheduled task scheduler.
 *
 * This hook does two jobs:
 *  1. Registers the AI Loop executor. When a task fires, its configured prompt
 *     is sent to startBackgroundConversation, which starts a new chat
 *     conversation in the background (the current view is left untouched) —
 *     giving the task full access to every tool (the existing AI Loop).
 *  2. Subscribes to the store so the component tree re-renders on task changes.
 *
 * The hook MUST be mounted inside a ChatConversationProvider (App.tsx mounts
 * it around the main content) so that startBackgroundConversation is
 * available. It is a
 * singleton concern, so it should be mounted exactly once for the lifetime of
 * the app (e.g. in MainSidebarContent, which is always rendered).
 *
 * Persistence: the store hydrates from the backend SQLite database on startup
 * (task definitions, pause state and run history survive restarts). Execution
 * still requires the renderer process to be alive — a task whose fire time
 * passes while the app is closed is skipped on the next launch, unless
 * schedule.wakeWhenClosed lets the OS scheduler relaunch the app.
 */
export const useScheduledTasks = (
  directoryId: string,
  directoryPath: string,
): {
  tasks: ScheduledTaskRecord[];
  createTask: (input: CreateTaskInput) => ScheduledTaskRecord;
  updateTask: (
    id: string,
    input: UpdateScheduledTaskInput,
  ) => ScheduledTaskRecord | null;
  removeTask: (id: string) => void;
  clearTasks: () => void;
  clearGlobalTasks: () => void;
  togglePauseTask: (id: string) => void;
  setTaskWakeWhenClosed: (id: string, enabled: boolean) => void;
  runTaskNow: (id: string) => Promise<void>;
  isExecutorReady: boolean;
} => {
  const { startBackgroundConversation } = useChatConversationContext();
  const [tasks, setTasks] = useState<ScheduledTaskRecord[]>(() =>
    scheduledTasksStore.list(directoryId),
  );
  const [isExecutorReady, setIsExecutorReady] = useState(false);

  // Keep the latest directoryId in a ref so the store subscription callback
  // always reads the current value without re-subscribing on every switch.
  const directoryIdRef = useRef(directoryId);
  useEffect(() => {
    directoryIdRef.current = directoryId;
  }, [directoryId]);

  // Subscribe to store changes (pub/sub singleton). Re-list whenever the
  // store notifies OR the active directory changes.
  useEffect(() => {
    const unsubscribe = scheduledTasksStore.subscribe(() => {
      setTasks(scheduledTasksStore.list(directoryIdRef.current));
    });
    // Ensure the list reflects the current directory immediately on mount/switch.
    setTasks(scheduledTasksStore.list(directoryId));
    return unsubscribe;
  }, [directoryId]);

  // Register startBackgroundConversation as the AI Loop executor.
  useEffect(() => {
    const unregister = scheduledTasksStore.setExecutor(
      (prompt, taskName, directoryId, options) =>
        // A fired task starts a NEW conversation in the background and kicks
        // off the existing AI Loop with all tools available — without
        // switching the view the user is currently on. The task's bound
        // project travels with the request so the conversation lands there
        // even when the user is viewing another one; an empty directoryId
        // (global task) falls back to the currently active project. Per-task
        // API overrides (apiProfile/basicModel/model/thinkingStrength) run the
        // conversation on the configured provider while its first title can
        // use the task's basic-model snapshot. The task name drives the
        // message list's "triggered by scheduled task" banner.
        startBackgroundConversation(
          prompt,
          directoryId || undefined,
          {
            apiProfile: options.apiProfile,
            basicModel: options.basicModel,
            model: options.model,
            thinkingStrength: options.thinkingStrength,
          },
          taskName,
        ),
    );
    setIsExecutorReady(true);
    return () => {
      unregister();
      setIsExecutorReady(false);
    };
  }, [startBackgroundConversation]);

  // Register the pre-script runner: binds the project directory as cwd and
  // delegates to the Rust backend via the preload bridge (fully async, the
  // tokio runtime spawns the shell process — never blocks the renderer).
  useEffect(() => {
    if (!directoryPath) return;
    const unregister = scheduledTasksStore.setScriptRunner(
      (command, options) => {
        const envJson = JSON.stringify({
          SNOW_DIRECTORY: directoryPath,
          ...options.env,
        });
        return window.snow.runPreScript(
          command,
          directoryPath,
          options.timeoutMs,
          envJson,
        );
      },
    );
    return unregister;
  }, [directoryPath]);

  const createTask = useCallback(
    (input: CreateTaskInput): ScheduledTaskRecord => {
      return scheduledTasksStore.create({
        ...input,
        directoryId: input.directoryId ?? directoryId,
      });
    },
    [directoryId],
  );

  const updateTask = useCallback(
    (
      id: string,
      input: UpdateScheduledTaskInput,
    ): ScheduledTaskRecord | null => {
      return scheduledTasksStore.update(id, input);
    },
    [],
  );

  const removeTask = useCallback((id: string): void => {
    scheduledTasksStore.remove(id);
  }, []);

  const clearTasks = useCallback((): void => {
    scheduledTasksStore.clear(directoryId);
  }, [directoryId]);

  const clearGlobalTasks = useCallback((): void => {
    scheduledTasksStore.clearGlobal();
  }, []);

  const togglePauseTask = useCallback((id: string): void => {
    scheduledTasksStore.togglePause(id);
  }, []);

  const setTaskWakeWhenClosed = useCallback(
    (id: string, enabled: boolean): void => {
      scheduledTasksStore.setWakeWhenClosed(id, enabled);
    },
    [],
  );

  const runTaskNow = useCallback((id: string): Promise<void> => {
    return scheduledTasksStore.runNow(id);
  }, []);

  return {
    tasks,
    createTask,
    updateTask,
    removeTask,
    clearTasks,
    clearGlobalTasks,
    togglePauseTask,
    setTaskWakeWhenClosed,
    runTaskNow,
    isExecutorReady,
  };
};

export { validateSchedule };
