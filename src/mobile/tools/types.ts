/**
 * 移动端工具卡片模块契约。
 *
 * 派发顺序（见 ./index.ts）：精确工具名（六模块合并，filesystem → exec →
 * search → web → agents → ops，同名后写覆盖）→ 最长前缀匹配（等长按模块
 * 顺序）→ 兜底通用卡（./generic.ts）。
 *
 * 渲染器返回 null 表示「本模块不处理」，交给后续候选继续尝试；抛错按未处理
 * 处理（单个卡片的问题不影响整条时间线，最终由兜底卡接管）。
 *
 * 约定：
 * - dataset.toolId / dataset.sig 由 timeline.ts 的 syncToolList 统一设置，
 *   渲染器不要自行写入（工具级 diff 依赖这两个字段）；
 * - 渲染器只读 SnowRemoteToolCall，渲染期不发网络请求；
 * - 所有输出节点一律 createElement + textContent，数据不进 innerHTML。
 */
import type { SnowRemoteToolCall } from "../../renderer/types/remoteControl";

/** 工具状态（与远控桥下发的字段同源）。 */
export type ToolStatus = SnowRemoteToolCall["status"];

/** 单个工具卡的渲染器：返回 null 表示不处理（继续后续匹配 / 兜底）。 */
export type ToolCallRenderer = (
  tool: SnowRemoteToolCall,
) => HTMLElement | null;

/** 一个工具族模块：精确名渲染器 + 前缀渲染器。 */
export type ToolModule = {
  /** 精确工具名 → 渲染器（键为工具全名，如 "filesystem-read"）。 */
  renderers: Record<string, ToolCallRenderer>;
  /** 前缀匹配渲染器（如 "lsp-"），派发时按前缀长度降序优先。 */
  prefixes: { prefix: string; render: ToolCallRenderer }[];
};
