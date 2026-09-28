import { lazy, Suspense } from "react";
import { Loader2, Maximize2 } from "lucide-react";
import { ChatContent } from "./mainContent/ChatContent";
import { TeamPanel } from "./mainContent/team/TeamPanel";
import { useI18n } from "../i18n";
import { useSettingsSearchTarget } from "./sidebar/settingsSearchNavigation";
import { useConversationNavigation } from "../hooks/useConversationNavigation";
import { useScriptEditorStore } from "../userscripts/scriptEditorStore";
import type { MainContentView } from "./mainContent/types";
import type { WorkspaceDirectoryRecord } from "../../preload";

// 所有设置面板与低频独立页面均使用 React.lazy 按需加载，
// 避免首屏打包体积过大拖慢启动速度。
const ApiSettingsTreePanel = lazy(() =>
  import("./sidebar/ApiSettingsTreePanel").then((m) => ({
    default: m.ApiSettingsTreePanel,
  })),
);
const CodebaseSettingsPanel = lazy(() =>
  import("./sidebar/CodebaseSettingsPanel").then((m) => ({
    default: m.CodebaseSettingsPanel,
  })),
);
const CustomHeadersSettingsPanel = lazy(() =>
  import("./sidebar/CustomHeadersSettingsPanel").then((m) => ({
    default: m.CustomHeadersSettingsPanel,
  })),
);
const CustomCommandsSettingsPanel = lazy(() =>
  import("./sidebar/CustomCommandsSettingsPanel").then((m) => ({
    default: m.CustomCommandsSettingsPanel,
  })),
);
const HooksSettingsPanel = lazy(() =>
  import("./sidebar/HooksSettingsPanel").then((m) => ({
    default: m.HooksSettingsPanel,
  })),
);
const McpSettingsPanel = lazy(() =>
  import("./sidebar/McpSettingsPanel").then((m) => ({
    default: m.McpSettingsPanel,
  })),
);
const LspSettingsPanel = lazy(() =>
  import("./sidebar/LspSettingsPanel").then((m) => ({
    default: m.LspSettingsPanel,
  })),
);
const ImageLibraryPanel = lazy(() =>
  import("./sidebar/ImageLibraryPanel").then((m) => ({
    default: m.ImageLibraryPanel,
  })),
);
const PrivacySettingsPanel = lazy(() =>
  import("./sidebar/PrivacySettingsPanel").then((m) => ({
    default: m.PrivacySettingsPanel,
  })),
);
const RemoteControlSettingsPanel = lazy(() =>
  import("./sidebar/RemoteControlSettingsPanel").then((m) => ({
    default: m.RemoteControlSettingsPanel,
  })),
);
const ProxyBrowserSettingsPanel = lazy(() =>
  import("./sidebar/ProxyBrowserSettingsPanel").then((m) => ({
    default: m.ProxyBrowserSettingsPanel,
  })),
);
const SensitiveCommandsPanel = lazy(() =>
  import("./sidebar/SensitiveCommandsPanel").then((m) => ({
    default: m.SensitiveCommandsPanel,
  })),
);
const SkillsSettingsPanel = lazy(() =>
  import("./sidebar/SkillsSettingsPanel").then((m) => ({
    default: m.SkillsSettingsPanel,
  })),
);
const SubAgentSettingsPanel = lazy(() =>
  import("./sidebar/SubAgentSettingsPanel").then((m) => ({
    default: m.SubAgentSettingsPanel,
  })),
);
const SystemPromptSettingsPanel = lazy(() =>
  import("./sidebar/SystemPromptSettingsPanel").then((m) => ({
    default: m.SystemPromptSettingsPanel,
  })),
);
const PersonalizationSettingsPanel = lazy(() =>
  import("./sidebar/personalization/PersonalizationSettingsPanel").then(
    (m) => ({
      default: m.PersonalizationSettingsPanel,
    }),
  ),
);
const TerminalSettingsPanel = lazy(() =>
  import("./sidebar/TerminalSettingsPanel").then((m) => ({
    default: m.TerminalSettingsPanel,
  })),
);
const ThemeSettingsPanel = lazy(() =>
  import("./sidebar/ThemeSettingsPanel").then((m) => ({
    default: m.ThemeSettingsPanel,
  })),
);
const KeyboardShortcutsSettingsPanel = lazy(() =>
  import("./sidebar/KeyboardShortcutsSettingsPanel").then((m) => ({
    default: m.KeyboardShortcutsSettingsPanel,
  })),
);
const PetsSettingsPanel = lazy(() =>
  import("./sidebar/PetsSettingsPanel").then((m) => ({
    default: m.PetsSettingsPanel,
  })),
);
const UsageSettingsPanel = lazy(() =>
  import("./sidebar/usageSettings/UsageSettingsPanel").then((m) => ({
    default: m.UsageSettingsPanel,
  })),
);
const SystemLogsPanel = lazy(() =>
  import("./sidebar/systemLogs/SystemLogsPanel").then((m) => ({
    default: m.SystemLogsPanel,
  })),
);
const BrowserSettingsPanel = lazy(() =>
  import("./sidebar/browserSettings/BrowserSettingsPanel").then((m) => ({
    default: m.BrowserSettingsPanel,
  })),
);
const GeneralSettingsPanel = lazy(() =>
  import("./sidebar/GeneralSettingsPanel").then((m) => ({
    default: m.GeneralSettingsPanel,
  })),
);
const GitSettingsPanel = lazy(() =>
  import("./sidebar/GitSettingsPanel").then((m) => ({
    default: m.GitSettingsPanel,
  })),
);
const MemoPanel = lazy(() =>
  import("./sidebar/MemoPanel").then((m) => ({ default: m.MemoPanel })),
);
const ProjectMemoryPanel = lazy(() =>
  import("./sidebar/ProjectMemoryPanel").then((m) => ({
    default: m.ProjectMemoryPanel,
  })),
);
const ScheduledTasksPanel = lazy(() =>
  import("./sidebar/ScheduledTasksPanel").then((m) => ({
    default: m.ScheduledTasksPanel,
  })),
);
const PluginsPanel = lazy(() =>
  import("./sidebar/PluginsPanel").then((m) => ({ default: m.PluginsPanel })),
);
const ScriptEditorOverlay = lazy(() =>
  import("../userscripts/ScriptEditorOverlay").then((m) => ({
    default: m.ScriptEditorOverlay,
  })),
);

type MainContentProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
  activeView: MainContentView;
  /** 右侧面板全屏时聊天视图悬浮为卡片 */
  isFloating?: boolean;
  /** 右面板拖宽越界待全屏：显示遮罩提醒，拖回可取消 */
  isFullscreenPending?: boolean;
  onActiveDirectoryChange?: (
    directory: WorkspaceDirectoryRecord | null,
  ) => void;
  onSelectView: (view: MainContentView) => void;
};

// 懒加载面板的 Suspense 兜底视图：
// 铺满主内容区并居中展示加载状态，避免分包加载期间出现白屏。
const LazyPanelFallback = (): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <div className="main-content-loading" role="status" aria-live="polite">
      <Loader2 className="spin" size={22} aria-hidden="true" />
      <span>{t("common.loading")}</span>
    </div>
  );
};

export const MainContent = ({
  activeDirectory,
  activeView,
  isFloating = false,
  isFullscreenPending = false,
  onActiveDirectoryChange,
  onSelectView,
}: MainContentProps): React.JSX.Element => {
  const { t } = useI18n();
  const editorState = useScriptEditorStore();
  useSettingsSearchTarget(activeView);
  const activeDirectoryId = activeDirectory?.directoryId ?? "";
  // 项目记忆页「来自会话」徽章复用共享的会话跳转管道（校验 → 切项目 → 切视图）。
  const { navigateToConversation } = useConversationNavigation({
    activeDirectory: activeDirectory ?? null,
    onActiveDirectoryChange,
    onSelectMainView: onSelectView,
  });
  const closePanel = (): void => onSelectView("chat");
  return (
    <main
      className="main-content"
      data-snow-anchor="main.view"
      data-snow-view={activeView}
    >
      {isFullscreenPending && (
        <div className="fullscreen-pending-overlay" aria-live="assertive">
          <div className="fullscreen-pending-card">
            <Maximize2 size={20} aria-hidden="true" />
            <span className="fullscreen-pending-title">
              {t("rightPanel.fullscreenPendingTitle")}
            </span>
            <span className="fullscreen-pending-hint">
              {t("rightPanel.fullscreenPendingHint")}
            </span>
          </div>
        </div>
      )}
      {activeView === "chat" ? (
        <ChatContent
          activeDirectory={activeDirectory}
          isFloating={isFloating}
          onNavigateToView={onSelectView}
        />
      ) : activeView === "team" ? (
        <TeamPanel
          activeDirectory={activeDirectory}
          onNavigateToView={onSelectView}
        />
      ) : (
        <Suspense fallback={<LazyPanelFallback />}>
          {activeView === "memo" ? (
            <MemoPanel directoryId={activeDirectoryId} onClose={closePanel} />
          ) : activeView === "memory" ? (
            <ProjectMemoryPanel
              directoryId={activeDirectoryId}
              onNavigateToConversation={navigateToConversation}
              onClose={closePanel}
            />
          ) : activeView === "scheduled-tasks" ? (
            <ScheduledTasksPanel
              directoryId={activeDirectoryId}
              directoryPath={activeDirectory?.path ?? ""}
              onClose={closePanel}
            />
          ) : activeView === "plugins" ? (
            <PluginsPanel onClose={closePanel} />
          ) : activeView === "api-settings" ? (
            <ApiSettingsTreePanel />
          ) : activeView === "imagegen-settings" ? (
            // 「图像生成」并入 API 设置页标签页：独立视图 id 作为别名直达该 tab。
            <ApiSettingsTreePanel initialTab="imagegen" />
          ) : activeView === "image-library" ? (
            <ImageLibraryPanel />
          ) : activeView === "browser-settings" ? (
            <BrowserSettingsPanel />
          ) : activeView === "browser-devices" ? (
            // 菜单「自定义设备…」直达浏览器设置面板的设备 tab。
            <BrowserSettingsPanel initialTab="devices" />
          ) : activeView === "proxy-browser-settings" ? (
            <ProxyBrowserSettingsPanel />
          ) : activeView === "codebase-settings" ? (
            <CodebaseSettingsPanel />
          ) : activeView === "git-settings" ? (
            <GitSettingsPanel />
          ) : activeView === "system-prompt-settings" ? (
            <SystemPromptSettingsPanel />
          ) : activeView === "personalization-settings" ? (
            <PersonalizationSettingsPanel activeDirectory={activeDirectory} />
          ) : activeView === "custom-headers-settings" ? (
            <CustomHeadersSettingsPanel />
          ) : activeView === "mcp-settings" ? (
            <McpSettingsPanel activeDirectory={activeDirectory} />
          ) : activeView === "lsp-settings" ? (
            <LspSettingsPanel activeDirectory={activeDirectory} />
          ) : activeView === "skills-settings" ? (
            <SkillsSettingsPanel activeDirectory={activeDirectory} />
          ) : activeView === "sub-agent-settings" ? (
            <SubAgentSettingsPanel activeDirectory={activeDirectory} />
          ) : activeView === "sensitive-command-settings" ? (
            <SensitiveCommandsPanel activeDirectory={activeDirectory} />
          ) : activeView === "custom-commands-settings" ? (
            <CustomCommandsSettingsPanel activeDirectory={activeDirectory} />
          ) : activeView === "hooks-settings" ? (
            <HooksSettingsPanel activeDirectory={activeDirectory} />
          ) : activeView === "terminal-settings" ? (
            <TerminalSettingsPanel />
          ) : activeView === "theme-settings" ? (
            <ThemeSettingsPanel />
          ) : activeView === "privacy-settings" ? (
            <PrivacySettingsPanel />
          ) : activeView === "remote-control-settings" ? (
            <RemoteControlSettingsPanel />
          ) : activeView === "keyboard-shortcuts-settings" ? (
            <KeyboardShortcutsSettingsPanel />
          ) : activeView === "pets-settings" ? (
            <PetsSettingsPanel />
          ) : activeView === "usage-settings" ? (
            <UsageSettingsPanel />
          ) : activeView === "system-logs" ? (
            <SystemLogsPanel />
          ) : activeView === "general-settings" ? (
            <GeneralSettingsPanel />
          ) : null}
        </Suspense>
      )}
      {editorState.session && (
        <Suspense fallback={null}>
          <ScriptEditorOverlay />
        </Suspense>
      )}
    </main>
  );
};
