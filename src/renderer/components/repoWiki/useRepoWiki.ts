import { useCallback, useEffect, useRef, useState } from "react";
import type { RepoWikiEvent, RepoWikiRecord } from "../../../preload";

/** 与 Rust normalize_project_path 一致，用于匹配事件归属。 */
export const normalizeWikiPath = (path: string): string => {
  const trimmed = path.trim().replace(/\\/g, "/");
  return trimmed.replace(/\/+$/, "") || trimmed;
};

type UseRepoWikiResult = {
  wiki: RepoWikiRecord | null;
  isLoading: boolean;
  loadError: string | null;
  /** 最近一次工具活动（运行中有效） */
  activity: RepoWikiEvent | null;
  reload: () => Promise<void>;
};

export const useRepoWiki = (projectPath: string | null): UseRepoWikiResult => {
  const [wiki, setWiki] = useState<RepoWikiRecord | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activity, setActivity] = useState<RepoWikiEvent | null>(null);
  const requestIdRef = useRef(0);
  const reloadTimerRef = useRef<number | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    const requestId = ++requestIdRef.current;
    if (!projectPath) {
      setWiki(null);
      return;
    }
    try {
      const record = await window.snow.repoWikiLoad(projectPath);
      if (requestId === requestIdRef.current) {
        setWiki(record);
        setLoadError(null);
      }
    } catch (error) {
      if (requestId === requestIdRef.current) {
        setLoadError(error instanceof Error ? error.message : String(error));
      }
    }
  }, [projectPath]);

  useEffect(() => {
    setWiki(null);
    setActivity(null);
    setLoadError(null);
    setIsLoading(true);
    void reload().finally(() => setIsLoading(false));
  }, [reload]);

  useEffect(() => {
    if (!projectPath) {
      return;
    }
    const key = normalizeWikiPath(projectPath);
    const dispose = window.snow.onRepoWikiEvent((event) => {
      if (normalizeWikiPath(event.projectPath) !== key) {
        return;
      }
      if (event.kind === "activity") {
        setActivity(event);
        return;
      }
      if (event.status !== "running") {
        setActivity(null);
      }
      // 合并高频事件，减少整份 Wiki 的重复读取
      if (reloadTimerRef.current !== null) {
        window.clearTimeout(reloadTimerRef.current);
      }
      reloadTimerRef.current = window.setTimeout(() => {
        reloadTimerRef.current = null;
        void reload();
      }, 250);
    });
    return () => {
      dispose();
      if (reloadTimerRef.current !== null) {
        window.clearTimeout(reloadTimerRef.current);
        reloadTimerRef.current = null;
      }
    };
  }, [projectPath, reload]);

  return { wiki, isLoading, loadError, activity, reload };
};
