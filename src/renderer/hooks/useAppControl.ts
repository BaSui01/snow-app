import { useEffect, useRef } from "react";
import type { MainContentView } from "../components/mainContent/types";
import type {
  MemoRecord,
  MemoStatus,
  ProxyBrowserSettings,
  WorkspaceDirectoryRecord,
} from "../../preload";
import type {
  CreateScheduledTaskInput,
  ScheduledTaskSchedule,
} from "../../preload";
import {
  PROXY_BROWSER_SETTING_CODE,
  PROXY_BROWSER_SETTING_NAME,
  PROXY_BROWSER_SETTINGS_CHANGED_EVENT,
} from "../components/sidebar/proxyBrowserSettings/proxyBrowserSettingsConstants";
import { readProxyBrowserSettingsJson } from "../components/sidebar/proxyBrowserSettings/proxyBrowserSettingsUtils";
import { scheduledTasksStore } from "./scheduledTasksStore";

/** Fetches every memo of a project (paginated, with a hard page cap). */
const fetchAllMemos = async (
  directoryId: string,
  status?: MemoStatus
): Promise<MemoRecord[]> => {
  const PAGE_SIZE = 100;
  const MAX_PAGES = 10;
  const all: MemoRecord[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await window.snow.listMemos(
      directoryId,
      PAGE_SIZE,
      offset,
      status
    );
    all.push(...result.items);
    if (!result.hasMore) break;
    offset += result.items.length;
  }
  return all;
};

export const APP_CONTROL_OPEN_SETTINGS_EVENT = "app-control:open-settings";
export const APP_CONTROL_MEMO_CREATED_EVENT = "app-control:memo-created";
export const APP_CONTROL_SCHEDULED_TASK_CREATED_EVENT =
  "app-control:scheduled-task-created";
export const APP_CONTROL_PROJECT_CREATED_EVENT = "app-control:project-created";
/** Dispatched after app-control-setMode writes the global settings. The
 *  conversation layer listens for it and replays the change through the
 *  session-aware path (session ref + global defaults + per-conversation DB
 *  record) so AI-driven mode switches behave exactly like user toggles. */
export const APP_CONTROL_MODE_CHANGED_EVENT = "app-control:mode-changed";

type AppControlHandlers = {
  activeDirectory: WorkspaceDirectoryRecord | null;
  setActiveMainView: (view: MainContentView) => void;
};

export const useAppControl = ({
  activeDirectory,
  setActiveMainView,
}: AppControlHandlers): void => {
  const activeDirectoryRef = useRef(activeDirectory);
  const setActiveMainViewRef = useRef(setActiveMainView);

  useEffect(() => {
    activeDirectoryRef.current = activeDirectory;
  }, [activeDirectory]);

  useEffect(() => {
    setActiveMainViewRef.current = setActiveMainView;
  }, [setActiveMainView]);

  useEffect(() => {
    const unregister = window.snow.registerAppControlHandler(
      async (request) => {
        const payload = JSON.parse(request.payloadJson) as Record<
          string,
          unknown
        >;

        switch (request.action) {
          case "create_memo": {
            const directory = activeDirectoryRef.current;
            if (!directory) {
              throw new Error("No active project directory");
            }
            const content = (payload.content as string) ?? "";
            const memo = await window.snow.createMemo(
              directory.directoryId,
              content
            );
            window.dispatchEvent(
              new CustomEvent(APP_CONTROL_MEMO_CREATED_EVENT)
            );
            return JSON.stringify({
              success: true,
              memoId: memo.memoId,
              content: memo.content,
              status: memo.status,
            });
          }

          case "list_memos": {
            const directory = activeDirectoryRef.current;
            if (!directory) {
              throw new Error("No active project directory");
            }
            const rawStatus = payload.status as string | undefined;
            const status =
              rawStatus === "pending" || rawStatus === "done"
                ? rawStatus
                : undefined;
            const memos = await fetchAllMemos(directory.directoryId, status);
            return JSON.stringify({
              success: true,
              total: memos.length,
              memos,
            });
          }

          case "get_memo": {
            const directory = activeDirectoryRef.current;
            if (!directory) {
              throw new Error("No active project directory");
            }
            const memoId = (payload.memoId as string) ?? "";
            if (!memoId.trim()) {
              throw new Error("memoId is required");
            }
            // Project isolation: only memos of the current project are visible.
            const memos = await fetchAllMemos(directory.directoryId);
            const memo = memos.find((item) => item.memoId === memoId);
            if (!memo) {
              throw new Error(
                `Memo not found in the current project: ${memoId}`
              );
            }
            return JSON.stringify({ success: true, memo });
          }

          case "update_memo_status": {
            const directory = activeDirectoryRef.current;
            if (!directory) {
              throw new Error("No active project directory");
            }
            const memoId = (payload.memoId as string) ?? "";
            const status = payload.status as string;
            if (!memoId.trim()) {
              throw new Error("memoId is required");
            }
            if (status !== "pending" && status !== "done") {
              throw new Error(
                `status must be "pending" or "done", received "${status}"`
              );
            }
            // Project isolation: refuse to mutate a memo that does not belong
            // to the current project.
            const memos = await fetchAllMemos(directory.directoryId);
            const memo = memos.find((item) => item.memoId === memoId);
            if (!memo) {
              throw new Error(
                `Memo not found in the current project: ${memoId}`
              );
            }
            const updated = await window.snow.updateMemoStatus(
              memoId,
              status
            );
            return JSON.stringify({ success: true, memo: updated });
          }

          case "get_blocked_patterns": {
            const raw = await window.snow.getSystemSettingValue(
              PROXY_BROWSER_SETTING_CODE
            );
            const settings = readProxyBrowserSettingsJson(raw);
            return JSON.stringify({
              success: true,
              blockedPatterns: settings.blockedPatterns,
              count: settings.blockedPatterns.length,
            });
          }

          case "update_blocked_patterns": {
            const operation = payload.operation as string;
            const rawPatterns = payload.patterns;
            if (
              operation !== "add" &&
              operation !== "remove" &&
              operation !== "replace"
            ) {
              throw new Error(
                `operation must be "add", "remove", or "replace", received "${operation}"`
              );
            }
            if (!Array.isArray(rawPatterns)) {
              throw new Error("patterns must be an array");
            }

            const patterns = rawPatterns.map((value) => {
              if (typeof value !== "string" || !value.trim()) {
                throw new Error("patterns must contain non-empty strings");
              }
              const pattern = value.trim();
              try {
                new RegExp(pattern);
              } catch {
                throw new Error(`Invalid regex: ${pattern}`);
              }
              return pattern;
            });

            const raw = await window.snow.getSystemSettingValue(
              PROXY_BROWSER_SETTING_CODE
            );
            const settings = readProxyBrowserSettingsJson(raw);
            let blockedPatterns: string[];

            if (operation === "add") {
              blockedPatterns = [...settings.blockedPatterns];
              for (const pattern of patterns) {
                if (!blockedPatterns.includes(pattern)) {
                  blockedPatterns.push(pattern);
                }
              }
            } else if (operation === "remove") {
              blockedPatterns = settings.blockedPatterns.filter(
                (pattern) => !patterns.includes(pattern)
              );
            } else {
              blockedPatterns = patterns;
            }

            const nextSettings: ProxyBrowserSettings = {
              ...settings,
              blockedPatterns,
            };
            await window.snow.setSystemSetting(
              PROXY_BROWSER_SETTING_NAME,
              PROXY_BROWSER_SETTING_CODE,
              JSON.stringify(nextSettings)
            );
            await window.snow.applyProxySettings();
            window.dispatchEvent(
              new CustomEvent(PROXY_BROWSER_SETTINGS_CHANGED_EVENT, {
                detail: { blockedPatterns },
              })
            );
            return JSON.stringify({
              success: true,
              operation,
              blockedPatterns,
              count: blockedPatterns.length,
            });
          }

          case "set_mode": {
            const mode = payload.mode as string;
            const enabled = payload.enabled as boolean;
            // Plan/Goal Mode is strictly per-conversation: the persisted
            // global settings are never written here. Replaying through the
            // session-aware path applies the change to the ACTIVE
            // conversation only (its session ref + per-conversation DB
            // record) — other conversations never inherit the toggle.
            window.dispatchEvent(
              new CustomEvent(APP_CONTROL_MODE_CHANGED_EVENT, {
                detail: { mode, enabled },
              })
            );
            return JSON.stringify({ success: true, mode, enabled });
          }

          case "open_settings": {
            const page = payload.page as string;
            setActiveMainViewRef.current(page as MainContentView);
            window.dispatchEvent(
              new CustomEvent(APP_CONTROL_OPEN_SETTINGS_EVENT)
            );
            return JSON.stringify({ success: true, page });
          }

          case "create_scheduled_task": {
            // Bind to the currently active project when one exists; with no
            // active project the task degrades to a GLOBAL task (empty
            // directoryId) instead of failing.
            const directory = activeDirectoryRef.current;
            const name = (payload.name as string) ?? "";
            const prompt = (payload.prompt as string) ?? "";
            const schedule = payload.schedule as
              | ScheduledTaskSchedule
              | undefined;
            if (!name.trim()) {
              throw new Error("name is required");
            }
            if (!prompt.trim()) {
              throw new Error("prompt is required");
            }
            if (!schedule) {
              throw new Error("schedule is required");
            }
            // The store validates the schedule strictly; an invalid schedule
            // throws here and the error propagates back to the MCP tool caller.
            const input: CreateScheduledTaskInput = {
              directoryId: directory?.directoryId ?? "",
              name,
              prompt,
              schedule,
              preScript:
                typeof payload.preScript === "string"
                  ? payload.preScript.trim() || undefined
                  : undefined,
              preScriptTimeoutMs:
                typeof payload.preScriptTimeoutMs === "number"
                  ? payload.preScriptTimeoutMs
                  : undefined,
              runOnScriptError:
                typeof payload.runOnScriptError === "boolean"
                  ? payload.runOnScriptError
                  : undefined,
              // Optional per-task run overrides (validated on the Rust MCP
              // side; normalized again by the store's create()).
              apiProfile:
                typeof payload.apiProfile === "string" &&
                payload.apiProfile.trim()
                  ? payload.apiProfile
                  : undefined,
              model:
                typeof payload.model === "string" && payload.model.trim()
                  ? payload.model
                  : undefined,
              basicModel:
                typeof payload.basicModel === "string" &&
                payload.basicModel.trim()
                  ? payload.basicModel
                  : undefined,
              thinkingStrength:
                typeof payload.thinkingStrength === "string" &&
                payload.thinkingStrength.trim()
                  ? payload.thinkingStrength
                  : undefined,
            };
            const created = scheduledTasksStore.create(input);
            window.dispatchEvent(
              new CustomEvent(APP_CONTROL_SCHEDULED_TASK_CREATED_EVENT, {
                detail: { taskId: created.id, name: created.name },
              })
            );
            return JSON.stringify({
              success: true,
              taskId: created.id,
              name: created.name,
              status: created.status,
              nextRunAt: created.nextRunAt,
            });
          }

          case "create_project": {
            const name = (payload.name as string) ?? "";
            if (!name.trim()) {
              throw new Error("name is required");
            }
            const providedParentPath = (
              payload.parentPath as string | undefined
            )?.trim();
            // 未提供父目录时弹出目录选择框，让用户指定保存位置。
            const parentPath =
              providedParentPath ??
              (await window.snow.selectWorkspaceDirectory(
                "Choose a folder to save the new project"
              ));
            if (!parentPath) {
              return JSON.stringify({ success: false, cancelled: true });
            }
            const directories = await window.snow.createWorkspaceProject(
              parentPath,
              name.trim()
            );
            const created = directories.find(
              (directory) => directory.isActive
            );
            window.dispatchEvent(
              new CustomEvent(APP_CONTROL_PROJECT_CREATED_EVENT, {
                detail: created
                  ? {
                      directoryId: created.directoryId,
                      name: created.name,
                      path: created.path,
                    }
                  : undefined,
              })
            );
            return JSON.stringify({
              success: true,
              directoryId: created?.directoryId,
              name: created?.name,
              path: created?.path,
            });
          }

          default:
            throw new Error(`Unknown app control action: ${request.action}`);
        }
      }
    );

    return () => {
      unregister();
    };
  }, []);
};
