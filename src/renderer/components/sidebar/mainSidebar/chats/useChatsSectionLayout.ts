import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useI18n } from "../../../../i18n";
import type { TimeGroupKey } from "../chatTimeGroup";

const CHATS_COLLAPSED_KEY = "chats-section-collapsed";
const TIME_GROUPS_COLLAPSED_KEY = "chats-time-groups-collapsed";
const CROSS_PROJECT_COLLAPSED_KEY = "chats-cross-project-collapsed";

type UseChatsCollapseOptions = {
  onCollapsedChange?: (collapsed: boolean) => void;
};

/** 会话区域收起/展开（localStorage 持久化，与项目区域一致） */
export function useChatsCollapse({
  onCollapsedChange,
}: UseChatsCollapseOptions) {
  const [isCollapsed, setIsCollapsed] = useState(() => {
    try {
      return localStorage.getItem(CHATS_COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });

  // 向父组件同步收起状态：会话收起后剩余高度应让给上方项目区域
  useEffect(() => {
    onCollapsedChange?.(isCollapsed);
  }, [isCollapsed, onCollapsedChange]);

  const setCollapsedPersisted = (next: boolean): void => {
    setIsCollapsed(next);
    try {
      localStorage.setItem(CHATS_COLLAPSED_KEY, String(next));
    } catch {
      // ignore storage errors
    }
  };

  return { isCollapsed, setCollapsedPersisted };
}

type UseChatsSectionLayoutOptions = {
  isMultiSelectMode: boolean;
};

export function useChatsSectionLayout({
  isMultiSelectMode,
}: UseChatsSectionLayoutOptions) {
  const { t } = useI18n();
  // 会话拖拽悬停中：高亮提示可放置
  const [isChatDragOver, setIsChatDragOver] = useState(false);
  // 时间分组（运行中/今天/昨天/近7天/更早）收起状态（localStorage 持久化）
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<
    Record<string, boolean>
  >(() => {
    try {
      const raw = localStorage.getItem(TIME_GROUPS_COLLAPSED_KEY);
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });
  // 「其他项目」跨项目通知区块收起状态（localStorage 持久化）
  const [isCrossProjectCollapsed, setIsCrossProjectCollapsed] = useState(() => {
    try {
      return localStorage.getItem(CROSS_PROJECT_COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });
  const sectionRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const section = sectionRef.current;
    const header = headerRef.current;
    if (!section || !header) {
      return;
    }
    const applyHeaderHeight = (): void => {
      const height =
        header.getBoundingClientRect().bottom -
        section.getBoundingClientRect().top;
      section.style.setProperty("--chats-header-h", `${height}px`);
    };
    applyHeaderHeight();
    const observer = new ResizeObserver(applyHeaderHeight);
    observer.observe(header);
    return () => {
      observer.disconnect();
    };
  }, [isMultiSelectMode]);

  /** 收起/展开时间分组并持久化到 localStorage */
  const toggleGroupCollapsed = (key: TimeGroupKey): void => {
    setCollapsedGroupKeys((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        localStorage.setItem(TIME_GROUPS_COLLAPSED_KEY, JSON.stringify(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  };

  /** 收起/展开「其他项目」跨项目通知区块并持久化到 localStorage */
  const toggleCrossProjectCollapsed = (): void => {
    setIsCrossProjectCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(CROSS_PROJECT_COLLAPSED_KEY, String(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  };

  const getGroupLabel = (key: TimeGroupKey): string => {
    switch (key) {
      case "running":
        return t("sidebar.chatTimeRunning", { defaultValue: "Running" });
      case "today":
        return t("sidebar.chatTimeToday", { defaultValue: "Today" });
      case "yesterday":
        return t("sidebar.chatTimeYesterday", {
          defaultValue: "Yesterday",
        });
      case "last7days":
        return t("sidebar.chatTimeLast7Days", {
          defaultValue: "Last 7 days",
        });
      case "earlier":
        return t("sidebar.chatTimeEarlier", { defaultValue: "Earlier" });
      default:
        return "";
    }
  };

  return {
    sectionRef,
    headerRef,
    isChatDragOver,
    setIsChatDragOver,
    collapsedGroupKeys,
    isCrossProjectCollapsed,
    toggleGroupCollapsed,
    toggleCrossProjectCollapsed,
    getGroupLabel,
  };
}
