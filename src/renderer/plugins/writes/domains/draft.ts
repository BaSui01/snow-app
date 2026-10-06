import {
  applyPluginDraft,
  capturePluginDraft,
  restorePluginDraft,
} from "../../pluginDraft";
import { l10n } from "../helpers";
import type { PluginWriteActionDefinition } from "../types";

export const DRAFT_WRITE_ACTIONS: PluginWriteActionDefinition[] = [
  {
    domain: "chatInput",
    action: "captureDraft",
    scope: null,
    summary: l10n(
      "Capture the mounted chat draft",
      "捕获当前输入草稿",
      "擷取目前輸入草稿",
    ),
    invoke: async ({ plugin }) => capturePluginDraft(plugin.pluginId),
  },
  {
    domain: "chatInput",
    action: "applyDraft",
    scope: null,
    summary: l10n(
      "Safely replace draft text",
      "安全替换草稿文本",
      "安全取代草稿文字",
    ),
    invoke: async ({ plugin, params }) =>
      applyPluginDraft(plugin.pluginId, params.draftToken, params.text),
  },
  {
    domain: "chatInput",
    action: "restoreDraft",
    scope: null,
    summary: l10n(
      "Restore the captured original draft",
      "还原捕获的原始草稿",
      "還原擷取的原始草稿",
    ),
    invoke: async ({ plugin, params }) =>
      restorePluginDraft(plugin.pluginId, params.restoreToken),
  },
];
