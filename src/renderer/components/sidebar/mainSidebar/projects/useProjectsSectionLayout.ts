import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { WorkspaceDirectoryRecord } from "../../../../../preload";
import { shortcutEvents } from "../../../shortcutEvents";

const PROJECTS_COLLAPSED_KEY = "projects-section-collapsed";

type UseProjectsSectionLayoutOptions = {
  isChatsCollapsed: boolean;
  workspaceDirectories: WorkspaceDirectoryRecord[];
  activeDirectory?: WorkspaceDirectoryRecord | null;
  isActionLocked: boolean;
  onActivateDirectory: (directoryId: string) => void;
  onCollapseChange: () => void;
};

export function useProjectsSectionLayout({
  isChatsCollapsed,
  workspaceDirectories,
  activeDirectory,
  isActionLocked,
  onActivateDirectory,
  onCollapseChange,
}: UseProjectsSectionLayoutOptions) {
  const [isProjectsCollapsed, setIsProjectsCollapsed] = useState(() => {
    try {
      return localStorage.getItem(PROJECTS_COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });
  const sectionRef = useRef<HTMLDivElement | null>(null);
  const isChatsCollapsedRef = useRef(isChatsCollapsed);
  isChatsCollapsedRef.current = isChatsCollapsed;

  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!section) {
      return;
    }
    const recordNaturalHeight = (): void => {
      if (isChatsCollapsedRef.current) {
        return;
      }
      section.style.setProperty(
        "--projects-natural-h",
        `${section.getBoundingClientRect().height}px`,
      );
    };
    recordNaturalHeight();
    const observer = new ResizeObserver(recordNaturalHeight);
    observer.observe(section);
    return () => {
      observer.disconnect();
    };
  }, []);

  const toggleProjectsCollapsed = (): void => {
    setIsProjectsCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(PROJECTS_COLLAPSED_KEY, String(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
    // 收起时关闭可能打开的添加菜单，避免菜单残留在界面上
    if (!isProjectsCollapsed) {
      onCollapseChange();
    }
  };

  // 基于当前位置自上而下循环切换项目。
  // 找到当前激活目录的索引，切换到下一个（末尾则回到第一个）。
  const handleCycleProject = useCallback(() => {
    if (workspaceDirectories.length === 0) return;
    // 切换中或保存中时不响应，避免状态混乱
    if (isActionLocked) {
      return;
    }

    const currentIndex = activeDirectory
      ? workspaceDirectories.findIndex(
          (d) => d.directoryId === activeDirectory.directoryId,
        )
      : -1;

    // 无当前激活目录时切换到第一个
    if (currentIndex === -1) {
      onActivateDirectory(workspaceDirectories[0].directoryId);
      return;
    }

    const nextIndex = (currentIndex + 1) % workspaceDirectories.length;
    const nextDirectory = workspaceDirectories[nextIndex];
    if (
      nextDirectory &&
      nextDirectory.directoryId !== activeDirectory?.directoryId
    ) {
      onActivateDirectory(nextDirectory.directoryId);
    }
  }, [workspaceDirectories, activeDirectory, isActionLocked, onActivateDirectory]);

  // 订阅快捷键事件：Ctrl/Cmd+` 循环切换项目
  useEffect(() => {
    return shortcutEvents.on("cycle-project", () => {
      handleCycleProject();
    });
  }, [handleCycleProject]);

  return {
    sectionRef,
    isProjectsCollapsed,
    toggleProjectsCollapsed,
  };
}