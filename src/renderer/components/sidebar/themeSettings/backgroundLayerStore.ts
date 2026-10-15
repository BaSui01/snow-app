/**
 * 全局背景图层状态：applyBackgroundToDocument 在每次主题应用 / 面板预览 /
 * 启动缓存恢复时写入最新的 Background 快照，ThemeBackgroundImageLayer 组件
 * 通过 useSyncExternalStore 订阅并负责实际绘制（多图轮播与交叉淡化）。
 *
 * 使用模块级订阅而非 React 状态的原因：背景应用发生在主题 Hook、设置面板
 * 预览与启动缓存三条互不相干的路径上，快照订阅让三者都能即时驱动同一个
 * 图层组件，无需层层传递 props。
 */
import type { ThemeBackground } from "./types";

type BackgroundListener = () => void;

let activeBackground: ThemeBackground | null = null;
const listeners = new Set<BackgroundListener>();

/** 订阅背景快照变化，返回取消订阅函数。 */
export const subscribeActiveBackground = (
  listener: BackgroundListener,
): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * 读取当前背景快照（未启用 / 无素材时为 null）。
 * 返回值引用稳定：仅在 setActiveBackground 写入新引用时变化，
 * 满足 useSyncExternalStore 对 getSnapshot 的稳定性要求。
 */
export const getActiveBackground = (): ThemeBackground | null =>
  activeBackground;

/** 写入背景快照并通知订阅者（引用未变化时跳过）。 */
export const setActiveBackground = (
  background: ThemeBackground | null,
): void => {
  if (activeBackground === background) {
    return;
  }
  activeBackground = background;
  listeners.forEach((listener) => {
    listener();
  });
};
