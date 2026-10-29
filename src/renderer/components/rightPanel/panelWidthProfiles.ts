import type { RightPanelTabType } from "./types";

export type RightPanelWidthProfile = {
  /** 该类型首次打开时的推荐宽度 */
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
};

/**
 * 右面板按内容类型的推荐宽度与可拖范围：
 * 浏览器 / 绘图 / 并排 diff 需要横向空间（浏览器低于 768px 会触发站点窄屏布局），
 * 文件树 / 任务 / 会话给窄栏即可。
 */
export const RIGHT_PANEL_WIDTH_PROFILES: Record<
  RightPanelTabType,
  RightPanelWidthProfile
> = {
  browser: { defaultWidth: 720, minWidth: 420, maxWidth: 1200 },
  drawing: { defaultWidth: 720, minWidth: 420, maxWidth: 1200 },
  diff: { defaultWidth: 720, minWidth: 420, maxWidth: 1200 },
  "file-diff-preview": { defaultWidth: 720, minWidth: 420, maxWidth: 1200 },
  file: { defaultWidth: 640, minWidth: 360, maxWidth: 1000 },
  terminal: { defaultWidth: 640, minWidth: 360, maxWidth: 1000 },
  codebase: { defaultWidth: 520, minWidth: 320, maxWidth: 720 },
  plugin: { defaultWidth: 480, minWidth: 320, maxWidth: 720 },
  tasks: { defaultWidth: 480, minWidth: 320, maxWidth: 720 },
  git: { defaultWidth: 480, minWidth: 320, maxWidth: 720 },
  conversation: { defaultWidth: 420, minWidth: 320, maxWidth: 720 },
  explorer: { defaultWidth: 280, minWidth: 220, maxWidth: 480 },
};

/** 未知类型的兜底档案：沿用旧版面板级默认值与全局边界。 */
export const RIGHT_PANEL_FALLBACK_WIDTH_PROFILE: RightPanelWidthProfile = {
  defaultWidth: 320,
  minWidth: 280,
  maxWidth: 640,
};

export const getRightPanelWidthProfile = (
  type: RightPanelTabType,
): RightPanelWidthProfile =>
  RIGHT_PANEL_WIDTH_PROFILES[type] ?? RIGHT_PANEL_FALLBACK_WIDTH_PROFILE;
