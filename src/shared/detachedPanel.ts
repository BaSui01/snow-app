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

/**
 * 会话 tab 所属的会话 id 集合（tab 中的会话与运行中的会话）变化后，
 * 主进程广播给主窗口：主窗口据此拦截对这些会话的点击，改为聚焦所在窗口。
 */
export const DETACHED_PANEL_CONVERSATION_OWNERS_BROADCAST_CHANNEL =
  "detached-panel:conversation-owners-broadcast";

/** 主进程要求独立面板窗口激活某个会话 tab（主窗口点击已归属会话时触发）。 */
export const DETACHED_PANEL_CONVERSATION_ACTIVATE_BROADCAST_CHANNEL =
  "detached-panel:conversation-activate-broadcast";

/**
 * 用户请求关闭独立面板窗口（标题栏关闭、系统关闭等）时，主进程先拦截关闭，
 * 通知渲染进程弹出二次确认；确认后再真正关闭。
 */
export const DETACHED_PANEL_CLOSE_REQUESTED_CHANNEL =
  "detached-panel:close-requested";

/** 独立面板窗口内的会话列表 / 树形数据发生变化（新建会话、标题与摘要更新、子代理或
 * Workflow 节点变化）后，主进程通知主窗口重新拉取侧边栏数据。
 */
export const DETACHED_PANEL_CONVERSATION_LIST_BROADCAST_CHANNEL =
  "detached-panel:conversation-list-broadcast";
