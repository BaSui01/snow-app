import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { MainSidebarContent } from "./sidebar/MainSidebarContent";
import { SettingsSidebarContent } from "./sidebar/SettingsSidebarContent";
import { SETTINGS_VIEW_IDS } from "./sidebar/settingsItems";
import { explorerPlacementStore } from "./common/explorerPlacementStore";
import { rightPanelEvents } from "./rightPanel/rightPanelEvents";
import { shortcutEvents } from "./shortcutEvents";
import { APP_CONTROL_OPEN_SETTINGS_EVENT } from "../hooks/useAppControl";
import type { MainContentView } from "./mainContent/types";
import type { SidebarContentKey, SidebarContentProps } from "./sidebar/types";

// 资源管理器按需加载（与右侧面板共用同一 chunk），避免首次渲染时同步加载。
const ProjectExplorerContent = lazy(() =>
  import("./rightPanel/ProjectExplorerContent").then((m) => ({
    default: m.ProjectExplorerContent,
  })),
);

type SidebarProps = {
  activeMainView: SidebarContentProps["activeMainView"];
  activeDirectory?: SidebarContentProps["activeDirectory"];
  isCollapsed: boolean;
  onActiveDirectoryChange?: SidebarContentProps["onActiveDirectoryChange"];
  onSelectMainView: SidebarContentProps["onSelectMainView"];
  /** 打开 SSH 连接向导；onCanceled 在向导被取消时回调（用于清理一次性状态）。 */
  onOpenSshWizard?: (options?: { onCanceled?: () => void }) => void;
  onOpenTerminal?: SidebarContentProps["onOpenTerminal"];
  onOpenFile?: (
    filePath: string,
    fileName: string,
    isSsh?: boolean,
    sshSessionId?: string | null,
    focusLine?: number,
    sshWorkspaceRoot?: string,
    sshWorkspaceId?: string,
  ) => void;
};

export const Sidebar = ({
  activeMainView,
  activeDirectory,
  isCollapsed,
  onActiveDirectoryChange,
  onSelectMainView,
  onOpenSshWizard,
  onOpenTerminal,
  onOpenFile,
}: SidebarProps): React.JSX.Element => {
  const [activeContent, setActiveContent] = useState<SidebarContentKey>("main");
  const [explorerDirectoryId, setExplorerDirectoryId] = useState<string | null>(
    null,
  );
  const [explorerPlacement, setExplorerPlacement] = useState(() =>
    explorerPlacementStore.get(),
  );

  // 订阅显示位置偏好：用户切换位置时同步在目标位置展示资源管理器。订阅回调在
  // 状态变更的同一批次内执行，因此这里能读到切换前记住的目录（effect 会晚于
  // 资源管理器自身挂载，读到已被重置的值）。
  useEffect(() => {
    return explorerPlacementStore.subscribe((next) => {
      setExplorerPlacement(next);
      if (next === "sidebar") {
        // 从右侧面板移回侧栏：沿用最近展示的目录，直接切到资源管理器视图。
        const targetDirectoryId =
          explorerPlacementStore.getDirectoryId() ||
          activeDirectory?.directoryId;
        if (targetDirectoryId) {
          setExplorerDirectoryId(targetDirectoryId);
        }
        setActiveContent("explorer");
        return;
      }
      // 移到右侧面板：侧栏退出资源管理器视图（tab 由右侧面板打开）。
      setActiveContent((current) =>
        current === "explorer" ? "main" : current,
      );
    });
  }, [activeDirectory]);

  const handleSwitchContent = useCallback(
    (content: SidebarContentKey): void => {
      setActiveContent(content);
    },
    [],
  );

  // 资源管理器入口：按显示位置偏好内嵌到侧栏，或请求右侧面板打开 tab。
  const handleSwitchToExplorer = useCallback((directoryId: string): void => {
    if (explorerPlacementStore.get() === "sidebar") {
      setExplorerDirectoryId(directoryId);
      setActiveContent("explorer");
      return;
    }
    rightPanelEvents.emit("open-explorer", { directoryId });
  }, []);

  // 订阅快捷键事件：Ctrl/Cmd+D 打开当前项目明细（按偏好落在侧栏或右侧面板）。
  // 使用当前激活的工作区目录作为 explorer 目标。
  useEffect(() => {
    return shortcutEvents.on("open-project-explorer", () => {
      if (activeDirectory?.directoryId) {
        handleSwitchToExplorer(activeDirectory.directoryId);
      }
    });
  }, [activeDirectory, handleSwitchToExplorer]);

  useEffect(() => {
    const openSettings = (view?: string): void => {
      setActiveContent("settings");
      // The event may carry a target settings view (e.g. opened from the
      // project codebase panel when the embedding configuration is missing),
      // so the sidebar can navigate directly to the right settings page.
      const target = view as MainContentView | undefined;
      if (target && SETTINGS_VIEW_IDS.has(target)) {
        onSelectMainView(target);
      }
    };
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ view?: string }>).detail;
      openSettings(detail?.view);
    };
    window.addEventListener(APP_CONTROL_OPEN_SETTINGS_EVENT, handler);
    // 独立浏览器窗口点击「浏览器设置」时，请求经主进程转发到主窗口，
    // 与本地事件走同一打开设置逻辑。
    const unsubscribe = window.snow.onOpenSettingsRequest(openSettings);
    // 快捷键打开设置：切到设置内容页。
    const unsubOpenSettings = shortcutEvents.on("open-settings", () => {
      setActiveContent("settings");
    });
    return () => {
      window.removeEventListener(APP_CONTROL_OPEN_SETTINGS_EVENT, handler);
      unsubscribe();
      unsubOpenSettings();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sidebarProps: SidebarContentProps = {
    activeMainView,
    activeDirectory,
    onActiveDirectoryChange,
    onSelectMainView,
    onSwitchContent: handleSwitchContent,
    onSwitchToExplorer: handleSwitchToExplorer,
    onOpenSshWizard,
    onOpenTerminal,
    onOpenFile,
  };

  return (
    <aside
      className={`sidebar ${isCollapsed ? "collapsed" : ""}`}
      data-snow-anchor="sidebar"
    >
      <div
        className={`sidebar-content-wrapper ${
          activeContent === "main" ? "" : "is-hidden"
        }`}
      >
        <MainSidebarContent {...sidebarProps} />
      </div>
      <div
        className={`sidebar-content-wrapper ${
          activeContent === "settings" ? "" : "is-hidden"
        }`}
      >
        <SettingsSidebarContent {...sidebarProps} />
      </div>
      {explorerPlacement === "sidebar" ? (
        <div
          className={`sidebar-content-wrapper ${
            activeContent === "explorer" ? "" : "is-hidden"
          }`}
        >
          <Suspense fallback={null}>
            <ProjectExplorerContent
              directoryId={explorerDirectoryId}
              onOpenFile={onOpenFile}
              onOpenTerminal={onOpenTerminal}
              onBack={() => handleSwitchContent("main")}
            />
          </Suspense>
        </div>
      ) : null}
    </aside>
  );
};
