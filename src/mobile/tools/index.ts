/**
 * 工具卡片派发器：工具快照 → 卡片元素。
 *
 * 匹配顺序：
 *   1. 精确工具名（六模块渲染器合并，模块顺序 filesystem → exec → search →
 *      web → agents → ops，同名后写覆盖）；
 *   2. 前缀匹配（前缀长度降序，等长按模块合并顺序）；
 *   3. 兜底通用卡（./generic.ts）。
 *
 * 候选渲染器返回 null 表示「本模块不处理」，抛错按未处理处理（只记日志），
 * 两者都会继续尝试后续候选，全部落空才回退兜底卡 —— 单个卡片的问题不影响
 * 整条时间线的渲染。
 *
 * dataset.toolId / dataset.sig 由 timeline.ts 的 syncToolList 统一设置。
 */
import type { SnowRemoteToolCall } from "../../renderer/types/remoteControl";
import { agentsModule } from "./agents";
import { execModule } from "./exec";
import { filesystemModule } from "./filesystem";
import { renderGenericTool } from "./generic";
import { opsModule } from "./ops";
import { searchModule } from "./search";
import type { ToolCallRenderer, ToolModule } from "./types";
import { webModule } from "./web";

/** 模块合并顺序（决定同名覆盖与等长前缀的先后）。 */
const MODULES: ToolModule[] = [
  filesystemModule,
  execModule,
  searchModule,
  webModule,
  agentsModule,
  opsModule,
];

const exactRenderers = new Map<string, ToolCallRenderer>();
const prefixRenderers: { prefix: string; order: number; render: ToolCallRenderer }[] =
  [];

MODULES.forEach((module, order) => {
  for (const [name, render] of Object.entries(module.renderers)) {
    exactRenderers.set(name, render);
  }
  for (const entry of module.prefixes) {
    prefixRenderers.push({ ...entry, order });
  }
});
// 前缀长度降序；等长保持模块顺序（Array.prototype.sort 稳定）。
prefixRenderers.sort(
  (a, b) => b.prefix.length - a.prefix.length || a.order - b.order,
);

/** 按候选顺序尝试渲染：null / 抛错都视为「未处理」。 */
const renderWith = (
  renderer: ToolCallRenderer,
  tool: SnowRemoteToolCall,
): HTMLElement | null => {
  try {
    return renderer(tool);
  } catch (error) {
    console.error(`[mobile] 工具卡片渲染失败：${tool.name}`, error);
    return null;
  }
};

/** 工具快照 → 卡片元素（永不返回 null：兜底卡保底）。 */
export const createToolCallEl = (tool: SnowRemoteToolCall): HTMLElement => {
  const candidates: ToolCallRenderer[] = [];
  const exact = exactRenderers.get(tool.name);
  if (exact) candidates.push(exact);
  for (const entry of prefixRenderers) {
    if (tool.name.startsWith(entry.prefix)) candidates.push(entry.render);
  }

  for (const renderer of candidates) {
    const el = renderWith(renderer, tool);
    if (el) return el;
  }
  return renderGenericTool(tool);
};
