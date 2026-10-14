import { isMacOS } from "../utils/shortcutUtils";
import { WindowControlsButtons } from "./WindowControls";

/**
 * 独立面板窗口的顶部操作栏（系统标题栏已隐藏，与主窗口 TopBar 的做法一致）。
 *
 * - macOS：原生红绿灯位于左上角，栏体左侧预留空间，不渲染自绘按钮；
 * - Windows / Linux：无边框窗口，右侧渲染自绘的最小化 / 最大化 / 关闭按钮
 *   （与主窗口 TopBar 使用同一组件）。
 *
 * 整栏为拖拽区域（-webkit-app-region: drag），按钮区域保持可点击。
 */

type DesktopPlatform = "macos" | "windows" | "linux";

const resolveDesktopPlatform = (): DesktopPlatform => {
  if (isMacOS()) {
    return "macos";
  }
  return navigator.userAgent.includes("Win") ? "windows" : "linux";
};

const DESKTOP_PLATFORM = resolveDesktopPlatform();

export const DetachedPanelTitleBar = ({
  title,
}: {
  title: string;
}): React.JSX.Element => (
  <header className={`detached-panel-titlebar is-${DESKTOP_PLATFORM}`}>
    <span className="detached-panel-titlebar-title" title={title}>
      {title}
    </span>
    {DESKTOP_PLATFORM !== "macos" && <WindowControlsButtons />}
  </header>
);
