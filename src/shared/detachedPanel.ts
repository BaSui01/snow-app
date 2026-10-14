/**
 * 右侧面板 tab「在新窗口中打开」的跨进程数据结构（主进程 / preload / 渲染进程共用）。
 *
 * tab 数据经主进程暂存后交给独立面板窗口，因此必须是可 JSON 序列化的纯数据：
 * - data 为 tab 的业务数据（与 RightPanelTab.data 同构，渲染端按 type 还原）；
 * - 终端 tab 额外携带 ptyId（接管已有 PTY）与 snapshot（屏幕 + 回滚缓冲的纯文本快照）。
 */

export type DetachedPanelTabPayload = {
  id: string;
  type: string;
  title: string;
  data?: unknown;
};

export type DetachedPanelPayload = {
  /** 随窗口迁移的 tab。 */
  tab: DetachedPanelTabPayload;
  /** 打开时主窗口的活动工作区目录快照（Git / 资源管理器 / 终端 cwd 等依赖）。 */
  activeDirectory: unknown | null;
};
