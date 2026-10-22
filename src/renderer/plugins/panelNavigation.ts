import type { MarketCategory } from "./market";

/** 与 userscripts/ClientScriptBridge 约定的主视图切换事件名。 */
const OPEN_MAIN_VIEW_EVENT = "snow:client-open-view";

export type PluginsPanelTab = "list" | "market" | "metadata";

export type PluginsPanelNavigation = {
  tab: PluginsPanelTab;
  /** 市场页的目标分类（tab 为 market 时生效）。 */
  category?: MarketCategory;
};

let pending: PluginsPanelNavigation | null = null;

/** 请求打开插件面板的指定标签页，由 PluginsPanel 挂载后消费。 */
export function requestPluginsPanelNavigation(
  intent: PluginsPanelNavigation,
): void {
  pending = intent;
}

/** 读取待处理的导航意图（不清空，StrictMode 下可安全重复读取）。 */
export function peekPluginsPanelNavigation(): PluginsPanelNavigation | null {
  return pending;
}

/** 清空导航意图（插件面板读取后调用）。 */
export function clearPluginsPanelNavigation(): void {
  pending = null;
}

/** 切换主内容视图（复用客户端脚本的视图切换通道）。 */
export function openMainView(view: string): void {
  window.dispatchEvent(
    new CustomEvent(OPEN_MAIN_VIEW_EVENT, { detail: { view } }),
  );
}
