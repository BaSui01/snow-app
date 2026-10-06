import type { TerminalSettings } from "../../../../preload";

export const TERMINAL_SETTING_NAME = "Terminal settings";
export const TERMINAL_SETTING_CODE = "terminal_settings";

export const TERMINAL_FONT_SIZE_MIN = 6;
export const TERMINAL_FONT_SIZE_MAX = 72;

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  shellPath: "",
  fontFamily: "",
  fontSize: 14,
  fontWeight: "normal",
  lineHeight: 1.2,
  // GPU 渲染默认关闭：WebGL 上下文按需创建，遇远程桌面/驱动禁用等
  // 环境问题可一键关闭回到稳定的 DOM 渲染器。
  gpuRendering: false,
};

export const FONT_WEIGHT_OPTIONS = [
  { value: "normal", label: "Normal" },
  { value: "bold", label: "Bold" },
  { value: "300", label: "Light" },
  { value: "500", label: "Medium" },
  { value: "600", label: "Semibold" },
  { value: "700", label: "Bold" },
];

/**
 * 终端字体族预设：值为可直接写入 fontFamily 的 CSS 字体栈。
 * 空值代表「使用内置默认栈」（已包含常见 Nerd Font 探测与等宽回退），
 * 其余项是 Oh My Posh / starship 提示符常用的 Nerd Font 家族。
 */
export const TERMINAL_FONT_FAMILY_PRESETS = [
  { value: "", label: "" },
  {
    value: "'Maple Mono Normal NF CN', monospace",
    label: "Maple Mono Normal NF CN",
  },
  { value: "'Maple Mono NF CN', monospace", label: "Maple Mono NF CN" },
  {
    value: "'CaskaydiaCove Nerd Font', monospace",
    label: "CaskaydiaCove Nerd Font",
  },
  {
    value: "'CaskaydiaCove NF', monospace",
    label: "CaskaydiaCove NF",
  },
  {
    value: "'JetBrainsMono Nerd Font', monospace",
    label: "JetBrainsMono Nerd Font",
  },
  { value: "'MesloLGS NF', monospace", label: "MesloLGS NF" },
  {
    value: "'FiraCode Nerd Font', monospace",
    label: "FiraCode Nerd Font",
  },
  { value: "'Hack Nerd Font', monospace", label: "Hack Nerd Font" },
  {
    value: "'Symbols Nerd Font Mono', 'Consolas', monospace",
    label: "Symbols Nerd Font Mono",
  },
];
