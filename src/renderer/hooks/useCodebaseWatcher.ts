import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Codebase watcher sync status.
 *
 * - `idle`: The watcher is not running (codebase disabled / no project).
 * - `watching`: The watcher is active and listening for file changes. No
 *   relevant changes have been detected since the last sync.
 * - `syncing`: An incremental sync is in progress (embedding new/changed
 *   files and/or deleting vectors for removed files).
 */
export type CodebaseSyncStatus = "idle" | "watching" | "syncing";

type UseCodebaseWatcherParams = {
  /** The project (workspace directory) id, or undefined if no project is active. */
  projectId?: string;
  /** The project filesystem path (needed to start the watcher). */
  projectPath?: string;
  /**
   * Whether the codebase feature is enabled for this project. When false,
   * the watcher is stopped and the status is `idle`.
   */
  enabled: boolean;
  /**
   * Called after an incremental sync finishes for the currently watched
   * project (done / no_changes / error). Used as a fallback refresh signal
   * in addition to the broadcast progress events, so the UI can re-read
   * index stats even if a progress event was missed.
   */
  onSyncFinished?: () => void;
};

type UseCodebaseWatcherResult = {
  /** Current sync status, used by the UI to show an indicator. */
  syncStatus: CodebaseSyncStatus;
  /**
   * The project id that the status currently reflects. Useful for the UI to
   * determine whether to show the indicator (only for the active project).
   */
  watchedProjectId: string | undefined;
};

/**
 * Manages the codebase file watcher lifecycle and automatically triggers
 * incremental sync when changes are detected.
 *
 * Lifecycle:
 * 1. When `enabled` becomes true (and projectId/projectPath are set), the
 *    watcher is started AND an initial sync is triggered to catch changes
 *    that happened while the app was closed (offline changes).
 * 2. When the watcher fires a `files-changed` event (after the 3s Rust
 *    debounce), an incremental sync is automatically triggered.
 * 3. The sync compares files on disk with indexed files: deletes vectors for
 *    removed files, embeds new/changed files, skips unchanged files.
 * 4. While a sync is running, subsequent `files-changed` events are
 *    coalesced — only one sync runs at a time. If another change arrives
 *    during sync, another sync is queued to run after the current one.
 * 5. When `enabled` becomes false or the project changes, the watcher is
 *    stopped and the status resets to `idle`.
 *
 * The watcher and sync both run in the Rust backend (notify crate + tokio
 * runtime). This hook only manages the IPC subscription and React state.
 */
export const useCodebaseWatcher = ({
  projectId,
  projectPath,
  enabled,
  onSyncFinished,
}: UseCodebaseWatcherParams): UseCodebaseWatcherResult => {
  const [syncStatus, setSyncStatus] = useState<CodebaseSyncStatus>("idle");
  const [watchedProjectId, setWatchedProjectId] = useState<string | undefined>(
    undefined,
  );

  // Track the project id we're currently watching so we can stop it when
  // switching projects.
  const currentWatchIdRef = useRef<string | undefined>(undefined);

  // Track whether a sync is currently running and whether another sync is
  // pending (coalescing). This prevents multiple concurrent syncs for the
  // same project.
  const syncInProgressRef = useRef(false);
  const syncPendingRef = useRef(false);
  // Track the project id for which sync should run. This is read inside the
  // sync runner closure, so we use a ref to always get the latest value.
  const syncProjectIdRef = useRef<string | undefined>(undefined);

  // Keep the latest callback in a ref so the sync runner (registered once)
  // always calls the current one without re-subscribing.
  const onSyncFinishedRef = useRef(onSyncFinished);
  useEffect(() => {
    onSyncFinishedRef.current = onSyncFinished;
  }, [onSyncFinished]);

  /**
   * Run an incremental sync for the given project. If a sync is already
   * running, the request is coalesced — we set `syncPendingRef` so the
   * running sync will trigger another one when it finishes.
   */
  const triggerSync = useCallback((targetProjectId: string) => {
    // If a sync is already running, mark a pending sync and return.
    // The running sync will pick this up when it finishes.
    if (syncInProgressRef.current) {
      syncPendingRef.current = true;
      return;
    }

    syncInProgressRef.current = true;
    syncPendingRef.current = false;
    setSyncStatus("syncing");

    void window.snow
      .syncCodebaseChanges(targetProjectId)
      .catch(() => {
        // Silent fail — the error is communicated via the progress callback
        // and the result. We just reset to watching.
      })
      .finally(() => {
        syncInProgressRef.current = false;

        // Only transition to "watching" if we're still actively watching
        // the same project. If the project changed or the watcher was
        // disabled while the sync was running, the lifecycle effect will
        // have already set the status to "idle" — don't overwrite it.
        if (
          currentWatchIdRef.current === targetProjectId &&
          syncProjectIdRef.current === targetProjectId
        ) {
          setSyncStatus("watching");
          // Fallback refresh signal so the caller can re-read index stats
          // after the sync completes, independent of the broadcast events.
          onSyncFinishedRef.current?.();
        }

        // If another change arrived during sync, trigger another sync.
        // Only do this if we're still watching the same project.
        if (
          syncPendingRef.current &&
          syncProjectIdRef.current === targetProjectId
        ) {
          syncPendingRef.current = false;
          triggerSync(targetProjectId);
        }
      });
  }, []);

  // Manage the watcher lifecycle based on projectId / projectPath / enabled.
  useEffect(() => {
    syncProjectIdRef.current = projectId;

    if (!enabled || !projectId || !projectPath) {
      // Not watching — stop any active watcher and reset status.
      if (currentWatchIdRef.current) {
        void window.snow
          .stopCodebaseWatch(currentWatchIdRef.current)
          .catch(() => {
            // Silent fail — the watcher may have already been stopped.
          });
        currentWatchIdRef.current = undefined;
      }
      // Cancel any in-flight incremental sync for this project, so turning
      // the switch off (or losing the project) actually stops the embedding
      // work running in Rust. Also drop any coalesced pending sync so it
      // can't re-trigger from the running sync's `.finally()`.
      if (projectId) {
        void window.snow.cancelCodebaseSync(projectId).catch(() => {
          // Silent fail — the sync may have already finished.
        });
      }
      syncPendingRef.current = false;
      setSyncStatus("idle");
      setWatchedProjectId(undefined);
      return;
    }

    // If the project changed, stop the previous watcher and cancel its
    // in-flight sync first.
    if (currentWatchIdRef.current && currentWatchIdRef.current !== projectId) {
      const prevId = currentWatchIdRef.current;
      void window.snow.stopCodebaseWatch(prevId).catch(() => {
        // Silent fail
      });
      void window.snow.cancelCodebaseSync(prevId).catch(() => {
        // Silent fail — the sync may have already finished.
      });
      currentWatchIdRef.current = undefined;
    }

    // Start the new watcher.
    currentWatchIdRef.current = projectId;
    setWatchedProjectId(projectId);
    setSyncStatus("watching");

    void window.snow.startCodebaseWatch(projectId, projectPath).catch(() => {
      // If starting fails, fall back to idle.
      setSyncStatus("idle");
      currentWatchIdRef.current = undefined;
    });

    // Trigger an initial sync to catch offline changes (files that changed
    // while the app was closed). The watcher only detects changes that
    // happen while it's running.
    triggerSync(projectId);

    // Cleanup: stop the watcher when the effect re-runs or unmounts.
    return () => {
      if (currentWatchIdRef.current) {
        const idToStop = currentWatchIdRef.current;
        void window.snow.stopCodebaseWatch(idToStop).catch(() => {
          // Silent fail
        });
        currentWatchIdRef.current = undefined;
      }
    };
  }, [projectId, projectPath, enabled, triggerSync]);

  // Subscribe to `files-changed` events from the backend. When a change is
  // detected, automatically trigger an incremental sync.
  useEffect(() => {
    if (!enabled || !projectId) {
      return;
    }

    const dispose = window.snow.onCodebaseFilesChanged((changedProjectId) => {
      if (changedProjectId !== projectId) {
        return;
      }
      // Automatically trigger a sync. The sync will delete vectors for
      // removed files, embed new/changed files, and skip unchanged files.
      triggerSync(changedProjectId);
    });

    return () => {
      dispose();
    };
  }, [enabled, projectId, triggerSync]);

  return {
    syncStatus,
    watchedProjectId,
  };
};
