/**
 * 项目记忆页面的导航入口。
 *
 * /memory 面板「在项目记忆中定位」需要打开项目记忆页面并把目标条目标题
 * 作为初始检索词。生产者在窗口上派发事件（侧栏据此切换到记忆页面），
 * 检索词先暂存在本模块，页面挂载或已挂载时取走生效 —— 这样事件先于页面
 * 挂载到达也不会丢失。独立成模块是为了避免侧栏静态引入记忆页面（懒加载分包）。
 */
export type ProjectMemoryOpenDetail = {
  query: string;
};

/** /memory 面板请求打开项目记忆页面并定位某条记忆的窗口事件。 */
export const OPEN_PROJECT_MEMORY_PANEL_EVENT = "project-memory:open-panel";

/** 页面尚未挂载时暂存的检索词，被取走后清空。 */
let pendingSearchSeed: string | null = null;

export const requestProjectMemoryPanel = (query: string): void => {
  pendingSearchSeed = query;
  window.dispatchEvent(
    new CustomEvent<ProjectMemoryOpenDetail>(OPEN_PROJECT_MEMORY_PANEL_EVENT, {
      detail: { query },
    }),
  );
};

export const consumeProjectMemorySearchSeed = (): string | null => {
  const seed = pendingSearchSeed;
  pendingSearchSeed = null;
  return seed;
};
