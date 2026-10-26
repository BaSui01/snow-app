import type { Locale } from "../../../shared/locale";

export const subAgentExecutionModeTranslations: Record<
  Locale,
  Record<string, string>
> = {
  en: {
    "settings.subAgentExecutionModeLabel": "Default sub-agent execution mode",
    "settings.subAgentExecutionModeSync": "Synchronous (default)",
    "settings.subAgentExecutionModeAsync": "Asynchronous",
    "settings.subAgentExecutionModeHint":
      "Applies globally as the default only. The AI can still choose synchronous or asynchronous per dispatch; Workflow nodes always run sub-agents synchronously. Accepted runs are unchanged.",
    "settings.subAgentExecutionModeSaved":
      "Saved default sub-agent execution mode.",
    "settings.subAgentExecutionModeSaveError":
      "Failed to save default sub-agent execution mode",
    "settings.subAgentExecutionModeLoadError":
      "Failed to load default sub-agent execution mode",
  },
  "zh-CN": {
    "settings.subAgentExecutionModeLabel": "子代理默认执行方式",
    "settings.subAgentExecutionModeSync": "同步（默认）",
    "settings.subAgentExecutionModeAsync": "异步",
    "settings.subAgentExecutionModeHint":
      "全局生效，仅作为默认值；AI 仍可按场景为每次派发选择同步或异步。Workflow 节点内的子代理始终同步执行。不影响已受理的运行。",
    "settings.subAgentExecutionModeSaved": "已保存子代理默认执行方式。",
    "settings.subAgentExecutionModeSaveError": "保存子代理默认执行方式失败",
    "settings.subAgentExecutionModeLoadError": "读取子代理默认执行方式失败",
  },
  "zh-TW": {
    "settings.subAgentExecutionModeLabel": "子代理預設執行方式",
    "settings.subAgentExecutionModeSync": "同步（預設）",
    "settings.subAgentExecutionModeAsync": "非同步",
    "settings.subAgentExecutionModeHint":
      "全域生效，僅作為預設值；AI 仍可依情境為每次派發選擇同步或非同步。Workflow 節點內的子代理一律同步執行。不影響已受理的執行。",
    "settings.subAgentExecutionModeSaved": "已儲存子代理預設執行方式。",
    "settings.subAgentExecutionModeSaveError": "儲存子代理預設執行方式失敗",
    "settings.subAgentExecutionModeLoadError": "讀取子代理預設執行方式失敗",
  },
};
