import type { MainContentView } from "./mainContent/types";

/**
 * 以独立页面（而非模态框）呈现的低频视图。
 *
 * 这些页面的标题与关闭按钮显示在 TopBar 上，内容区由 MainContent 懒加载；
 * 侧栏入口在页面打开时显示选中态，再次点击收回聊天视图。
 */
export type FeaturePageView = "memo" | "memory" | "scheduled-tasks" | "plugins";

export const FEATURE_PAGE_VIEWS: ReadonlySet<MainContentView> = new Set([
  "memo",
  "memory",
  "scheduled-tasks",
  "plugins",
]);

export const isFeaturePageView = (
  view: MainContentView,
): view is FeaturePageView => FEATURE_PAGE_VIEWS.has(view);

/** TopBar 上各独立页面的标题（与侧栏入口文案一致）。 */
export const FEATURE_PAGE_TITLES: Record<
  FeaturePageView,
  { key: string; defaultValue: string }
> = {
  memo: { key: "memo.title", defaultValue: "Memos" },
  memory: { key: "memory.modalTitle", defaultValue: "Project Memory" },
  "scheduled-tasks": {
    key: "scheduledTask.title",
    defaultValue: "Scheduled Tasks",
  },
  plugins: { key: "plugins.title", defaultValue: "Plugins" },
};
