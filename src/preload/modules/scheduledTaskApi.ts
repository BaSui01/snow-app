import { ipcRenderer } from "electron";

import type { PreScriptResult } from "../types";

/**
 * Scheduled-task bridge: executes the task's pre-script in the Rust backend.
 * The script runs as a shell command in the task's project directory and
 * decides whether the AI Loop should fire this round.
 */
export const scheduledTaskApi = {
  /** Runs a pre-script shell command in the given cwd. Never blocks: the
   *  Rust backend spawns the process on the tokio runtime. */
  runPreScript: (
    command: string,
    cwd: string,
    timeoutMs: number,
    envJson: string
  ): Promise<PreScriptResult> =>
    ipcRenderer.invoke(
      "scheduled-task:run-pre-script",
      command,
      cwd,
      timeoutMs,
      envJson
    ),
};
