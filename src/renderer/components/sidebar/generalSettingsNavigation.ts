/**
 * 通用设置面板的 tab 导航入口。
 *
 * 侧栏「更新日志」需要直达通用设置面板的更新日志 tab：生产者先把目标 tab
 * 暂存在本模块，再派发窗口事件（侧栏据此切到设置内容页）。面板挂载时取走
 * 暂存值，已挂载时由事件监听切换 —— 事件先于面板挂载（懒加载分包）到达也
 * 不会丢失。独立成模块是为了避免侧栏静态引入设置面板（懒加载分包）。
 */
export type GeneralSettingsTab =
  "general" | "storage" | "privacy" | "about" | "changelog";

/** 请求打开通用设置面板某个 tab 的窗口事件。 */
export const OPEN_GENERAL_SETTINGS_TAB_EVENT = "general-settings:open-tab";

/** 面板尚未挂载时暂存的目标 tab，被取走后清空。 */
let pendingTab: GeneralSettingsTab | null = null;

export const requestGeneralSettingsTab = (tab: GeneralSettingsTab): void => {
  pendingTab = tab;
  window.dispatchEvent(
    new CustomEvent<{ tab: GeneralSettingsTab }>(
      OPEN_GENERAL_SETTINGS_TAB_EVENT,
      { detail: { tab } },
    ),
  );
};

export const consumeGeneralSettingsTab = (): GeneralSettingsTab | null => {
  const tab = pendingTab;
  pendingTab = null;
  return tab;
};
