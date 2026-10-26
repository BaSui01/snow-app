import type { Locale } from "../../../shared/locale";

export const subAgentExecutionModeTranslations: Record<
  Locale,
  Record<string, string>
> = {
  en: {
    "settings.subAgentExecutionModeLabel": "Sub-agent execution mode",
    "settings.subAgentExecutionModeSync": "Synchronous (default)",
    "settings.subAgentExecutionModeAsync": "Asynchronous",
    "settings.subAgentExecutionModeHint":
      "Applies globally. The selected mode is enforced and cannot be overridden by tool arguments. Accepted runs are unchanged.",
    "settings.subAgentExecutionModeSaved": "Saved sub-agent execution mode.",
    "settings.subAgentExecutionModeSaveError":
      "Failed to save sub-agent execution mode",
    "settings.subAgentExecutionModeLoadError":
      "Failed to load sub-agent execution mode",
  },
  "zh-CN": {
    "settings.subAgentExecutionModeLabel": "子代理执行方式",
    "settings.subAgentExecutionModeSync": "同步（默认）",
    "settings.subAgentExecutionModeAsync": "异步",
    "settings.subAgentExecutionModeHint":
      "全局生效，所选方式为强制执行方式，工具参数不能覆盖；不影响已受理的运行。",
    "settings.subAgentExecutionModeSaved": "已保存子代理执行方式。",
    "settings.subAgentExecutionModeSaveError": "保存子代理执行方式失败",
    "settings.subAgentExecutionModeLoadError": "读取子代理执行方式失败",
  },
  "zh-TW": {
    "settings.subAgentExecutionModeLabel": "子代理執行方式",
    "settings.subAgentExecutionModeSync": "同步（預設）",
    "settings.subAgentExecutionModeAsync": "非同步",
    "settings.subAgentExecutionModeHint":
      "全域生效，所選方式為強制執行方式，工具參數不能覆蓋；不影響已受理的執行。",
    "settings.subAgentExecutionModeSaved": "已儲存子代理執行方式。",
    "settings.subAgentExecutionModeSaveError": "儲存子代理執行方式失敗",
    "settings.subAgentExecutionModeLoadError": "讀取子代理執行方式失敗",
  },
};
