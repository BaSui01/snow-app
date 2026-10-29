/**
 * 左右面板展开/收起状态与右面板各类型的宽度记忆。
 *
 * 属于全局 UI 偏好（不区分项目与会话），持久化在 localStorage，
 * 应用下次启动时直接恢复。
 */
const STORAGE_KEY = "snow.layout.panel-collapsed";
// 右面板宽度按内容类型分别记忆：类型 -> 用户拖拽后的宽度（px）。
const RIGHT_PANEL_WIDTH_STORAGE_KEY = "snow.layout.right-panel-widths";

export type PanelCollapsedState = {
  sidebar: boolean;
  rightPanel: boolean;
};

/** 读取全局记忆；没有持久化记录时返回 null，由调用方决定初次默认值。 */
export const readPanelCollapsedState = (): PanelCollapsedState | null => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<PanelCollapsedState> | null;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return {
      sidebar: parsed.sidebar === true,
      rightPanel: parsed.rightPanel === true,
    };
  } catch {
    return null;
  }
};

export const writePanelCollapsedState = (state: PanelCollapsedState): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 持久化失败时仅本次会话生效。
  }
};

/** 读取各内容类型的宽度覆盖；非法值直接忽略。 */
const readRightPanelWidthOverrides = (): Record<string, number> => {
  try {
    const raw = window.localStorage.getItem(RIGHT_PANEL_WIDTH_STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const overrides: Record<string, number> = {};
    for (const [type, width] of Object.entries(parsed)) {
      if (typeof width === "number" && Number.isFinite(width) && width > 0) {
        overrides[type] = width;
      }
    }
    return overrides;
  } catch {
    return {};
  }
};

/** 读取某内容类型记住的宽度；没有记录时返回 null。 */
export const readRightPanelWidthOverride = (type: string): number | null =>
  readRightPanelWidthOverrides()[type] ?? null;

/** 记住某内容类型拖拽后的宽度。 */
export const writeRightPanelWidthOverride = (
  type: string,
  width: number,
): void => {
  try {
    const overrides = readRightPanelWidthOverrides();
    overrides[type] = width;
    window.localStorage.setItem(
      RIGHT_PANEL_WIDTH_STORAGE_KEY,
      JSON.stringify(overrides),
    );
  } catch {
    // 持久化失败时仅本次会话生效。
  }
};
