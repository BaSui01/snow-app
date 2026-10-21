import { matchKey } from "./shortcutUtils";

export type ToolCardStyle = "classic" | "chips";

/**
 * 工具卡风格切换快捷键。
 *
 * 固定绑定，不进入可配置快捷键面板：界面上不提供切换开关，
 * 只通过该组合键在「经典」与「chips」两套视觉之间切换。
 */
export const TOOL_CARD_STYLE_SHORTCUT_KEY = "mod+shift+u";

const STORAGE_KEY = "snow:tool-card-style";
const ROOT_ATTRIBUTE = "data-tool-card-style";

const applyToolCardStyle = (style: ToolCardStyle): void => {
  document.documentElement.setAttribute(ROOT_ATTRIBUTE, style);
};

export const getToolCardStyle = (): ToolCardStyle => {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "chips"
      ? "chips"
      : "classic";
  } catch {
    return "classic";
  }
};

const setToolCardStyle = (style: ToolCardStyle): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, style);
  } catch {
    // 存储不可用时仅在本次会话生效
  }
  applyToolCardStyle(style);
};

export const toggleToolCardStyle = (): ToolCardStyle => {
  const next: ToolCardStyle =
    getToolCardStyle() === "chips" ? "classic" : "chips";
  setToolCardStyle(next);
  return next;
};

/**
 * 首屏同步应用上次选择，避免先渲染默认风格再切换造成闪烁。
 */
export const initToolCardStyle = (): void => {
  applyToolCardStyle(getToolCardStyle());
};

/**
 * 安装固定快捷键监听（mod+shift+u），返回卸载函数。
 */
export const installToolCardStyleShortcut = (): (() => void) => {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) {
      return;
    }
    if (!matchKey(event, TOOL_CARD_STYLE_SHORTCUT_KEY)) {
      return;
    }
    event.preventDefault();
    toggleToolCardStyle();
  };
  document.addEventListener("keydown", onKeyDown);
  return () => document.removeEventListener("keydown", onKeyDown);
};
