/**
 * 渲染层桌面平台判断。
 *
 * Windows / Linux 主窗口使用无边框窗口（主进程 frame: false），标题栏、
 * 窗口控制按钮（最小化 / 最大化 / 关闭）与 LOGO 全部由渲染层自绘；
 * macOS 保留原生红绿灯按钮，不渲染自绘控件。
 */
export const hasCustomWindowFrame = (): boolean => {
  if (typeof navigator === "undefined") {
    return false;
  }
  const userAgent = navigator.userAgent ?? "";
  return userAgent.includes("Win") || userAgent.includes("Linux");
};
