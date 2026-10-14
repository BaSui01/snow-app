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

/**
 * 主窗口运行时快照的镜像（不含 panels，panels 由各窗口的右侧面板自行维护）。
 * 插件面板读取的会话 / 项目等实时状态只由主窗口的 App 级组件写入，独立窗口需经主进程同步。
 * 字段结构与渲染层 RuntimeSnapshot 一致，此处以纯数据对象传输。
 */
export type DetachedPanelRuntimeMirror = Record<string, unknown>;

/** 主进程向独立面板窗口广播运行时快照镜像的通道。 */
export const DETACHED_PANEL_RUNTIME_MIRROR_BROADCAST_CHANNEL =
  "detached-panel:runtime-mirror-broadcast";
