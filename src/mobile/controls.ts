import type { SnowRemoteState } from "../renderer/types/remoteControl";
import { $, escapeHtml } from "./dom";
import { contextLabel, effectiveThinkingLabel } from "./format";
import { t } from "./i18n";
import { iconMarkup, type MobileIconName } from "./icons";
import { renderModelPanel, resetModelPanel } from "./modelPanel";
import { openRemotePanel } from "./panels";
import type { AppContext } from "./types";

/** 思考强度值 → lucide 图标（与桌面端 THINKING_OPTIONS_BY_METHOD 逐值对应）。 */
const THINKING_ICONS: Record<string, MobileIconName> = {
  none: "circle-off",
  minimal: "circle-dot",
  low: "gauge",
  medium: "activity",
  high: "brain-circuit",
  xhigh: "chevrons-up",
  max: "rocket",
};

/**
 * 输入区上方的远程状态 chips：
 * 模型 + 思考强度合并为一个选择器（参考桌面端 ModelSelector 触发器，
 * 思考区带分隔线 + 强度图标），后接模式与上下文 chip；点击打开模型面板。
 */
export const renderControls = (next: SnowRemoteState | null): void => {
  const input = next?.chatInput;
  const modes = next?.modes;

  const activeModes: string[] = [];
  if (modes?.yolo) activeModes.push(t("remote.modes.yolo"));
  if (modes?.lite) activeModes.push(t("remote.modes.lite"));
  if (modes?.plan) activeModes.push(t("remote.modes.plan"));
  if (modes?.worktree) activeModes.push(t("remote.modes.worktree"));
  if (modes?.workflow) activeModes.push(t("remote.modes.workflow"));
  if (modes?.goal) activeModes.push(t("remote.modes.goal"));

  const thinkingValue = input?.effectiveThinkingValue || "";
  $("modelChip").innerHTML =
    `<span class="chip-model">${escapeHtml(input?.selectedModel || t("remote.model.notSelected"))}</span>` +
    `<span class="chip-thinking">${iconMarkup(THINKING_ICONS[thinkingValue] ?? "brain-circuit")}<span class="chip-thinking-label">${escapeHtml(effectiveThinkingLabel(input))}</span></span>` +
    `<span class="chip-caret">${iconMarkup("chevron-down")}</span>`;
  $("modeChip").textContent = t("remote.chips.mode", {
    value: activeModes.length
      ? activeModes.join(" · ")
      : t("remote.chips.modeStandard"),
  });
  $("contextChip").textContent = contextLabel(
    input?.tokenUsage,
    input?.maxContextTokens,
  );
};

export const initControls = (ctx: AppContext): void => {
  $("remoteToolbar").onclick = (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-panel]",
    );
    if (!button) return;
    const panelId = button.dataset.panel ?? "";
    if (panelId === "modelPanel") {
      // 模型面板由模型 chip 直接打开（不再从 Plus 菜单进入），回到 root 视图。
      resetModelPanel();
      openRemotePanel(panelId);
      renderModelPanel(ctx.getState()?.chatInput);
      return;
    }
    openRemotePanel(panelId);
  };
};
