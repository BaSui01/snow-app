import type { Locale } from "../../../shared/locale";

export const subAgentToolTranslations: Record<
  Locale,
  Record<string, string>
> = {
  en: {
    "subAgentTools.waitAll": "Wait for all {{count}} runs",
    "subAgentTools.waitAny": "Wait for any of {{count}} runs",
    "subAgentTools.settledCount": "{{count}} / {{total}} runs ended",
    "subAgentTools.timedOut": "Wait timed out",
    "subAgentTools.currentState": "Current state",
    "subAgentTools.snapshotState": "Includes query-time state",
    "subAgentTools.details": "Run details",
    "subAgentTools.parameters": "Parameters",
    "subAgentTools.rawResult": "Raw response",
    "subAgentTools.summary": "Result summary",
    "subAgentTools.paged": "Partial summary",
  },
  "zh-CN": {
    "subAgentTools.waitAll": "等待全部 {{count}} 项运行",
    "subAgentTools.waitAny": "等待 {{count}} 项中的任一项",
    "subAgentTools.settledCount": "已结束 {{count}} / {{total}} 项",
    "subAgentTools.timedOut": "等待超时",
    "subAgentTools.currentState": "当前状态",
    "subAgentTools.snapshotState": "含查询时状态",
    "subAgentTools.details": "运行详情",
    "subAgentTools.parameters": "参数",
    "subAgentTools.rawResult": "原始返回",
    "subAgentTools.summary": "结果摘要",
    "subAgentTools.paged": "摘要未完整显示",
  },
  "zh-TW": {
    "subAgentTools.waitAll": "等待全部 {{count}} 項執行",
    "subAgentTools.waitAny": "等待 {{count}} 項中的任一項",
    "subAgentTools.settledCount": "已結束 {{count}} / {{total}} 項",
    "subAgentTools.timedOut": "等待逾時",
    "subAgentTools.currentState": "目前狀態",
    "subAgentTools.snapshotState": "含查詢時狀態",
    "subAgentTools.details": "執行詳情",
    "subAgentTools.parameters": "參數",
    "subAgentTools.rawResult": "原始回傳",
    "subAgentTools.summary": "結果摘要",
    "subAgentTools.paged": "摘要尚未完整顯示",
  },
};
