import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WorkspaceDirectoryRecord } from "../../../../../preload";

const DIRECTORY_PAGE_SIZE = 12;
// 距底部该像素范围内触发加载下一页（纯前端切片，无异步，直接滚动即可）
const LOAD_MORE_DISTANCE = 40;

type UseDirectoryPaginationOptions = {
  topLevelDirectories: WorkspaceDirectoryRecord[];
  isProjectsCollapsed: boolean;
  isChatsCollapsed: boolean;
};

export function useDirectoryPagination({
  topLevelDirectories,
  isProjectsCollapsed,
  isChatsCollapsed,
}: UseDirectoryPaginationOptions) {
  const [directoryPage, setDirectoryPage] = useState(1);
  const directoryListRef = useRef<HTMLDivElement | null>(null);
  const directoryLoadMoreRef = useRef<HTMLDivElement | null>(null);

  const visibleDirectoryCount = directoryPage * DIRECTORY_PAGE_SIZE;
  const visibleDirectories = useMemo(
    () => topLevelDirectories.slice(0, visibleDirectoryCount),
    [topLevelDirectories, visibleDirectoryCount],
  );
  const hasMoreDirectories = visibleDirectoryCount < topLevelDirectories.length;

  const loadNextDirectoryPage = useCallback((): void => {
    setDirectoryPage((currentPage) => {
      const maxPage = Math.ceil(
        topLevelDirectories.length / DIRECTORY_PAGE_SIZE,
      );

      return Math.min(currentPage + 1, Math.max(maxPage, 1));
    });
  }, [topLevelDirectories.length]);

  useEffect(() => {
    setDirectoryPage(1);
  }, [topLevelDirectories.length]);

  useEffect(() => {
    if (!hasMoreDirectories || isProjectsCollapsed) {
      return;
    }

    const scrollRoot = directoryListRef.current;
    if (!scrollRoot) {
      return;
    }

    const check = (): void => {
      const distance =
        scrollRoot.scrollHeight -
        scrollRoot.scrollTop -
        scrollRoot.clientHeight;
      if (distance <= LOAD_MORE_DISTANCE) {
        loadNextDirectoryPage();
      }
    };

    check();
    scrollRoot.addEventListener("scroll", check, { passive: true });

    return () => {
      scrollRoot.removeEventListener("scroll", check);
    };
  }, [
    hasMoreDirectories,
    loadNextDirectoryPage,
    isProjectsCollapsed,
    isChatsCollapsed,
  ]);

  return {
    directoryListRef,
    directoryLoadMoreRef,
    visibleDirectories,
    hasMoreDirectories,
  };
}