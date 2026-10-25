import type { Locale } from "../../../shared/locale";

export const subAgentToolTranslations: Record<
  Locale,
  Record<string, string>
> = {
  en: {
    "subAgentTools.settledCount": "{{count}} / {{total}} runs ended",
    "subAgentTools.currentState": "Current state",
    "subAgentTools.snapshotState": "Includes query-time state",
    "subAgentTools.details": "Run details",
    "subAgentTools.summary": "Result summary",
    "subAgentTools.paged": "Partial summary",
    "subAgentTools.resultDelivered": "Sub-agent result delivered",
    "subAgentTools.awaitingResult": "Waiting for tool result",
    "subAgentTools.runNotFound": "Run not found",
    "subAgentTools.scopeDenied": "Run access denied for this conversation",
    "subAgentTools.notTerminal": "Run result is not ready",
    "subAgentTools.queryFailed": "Unable to query run result",
  },
  "zh-CN": {
    "subAgentTools.settledCount": "已结束 {{count}} / {{total}} 项",
    "subAgentTools.currentState": "当前状态",
    "subAgentTools.snapshotState": "含查询时状态",
    "subAgentTools.details": "运行详情",
    "subAgentTools.summary": "结果摘要",
    "subAgentTools.paged": "摘要未完整显示",
    "subAgentTools.resultDelivered": "子代理结果已送达",
    "subAgentTools.awaitingResult": "等待工具结果",
    "subAgentTools.runNotFound": "未找到该运行",
    "subAgentTools.scopeDenied": "当前会话无权读取该运行",
    "subAgentTools.notTerminal": "运行结果尚未就绪",
    "subAgentTools.queryFailed": "运行结果查询失败",
  },
  "zh-TW": {
    "subAgentTools.settledCount": "已結束 {{count}} / {{total}} 項",
    "subAgentTools.currentState": "目前狀態",
    "subAgentTools.snapshotState": "含查詢時狀態",
    "subAgentTools.details": "執行詳情",
    "subAgentTools.summary": "結果摘要",
    "subAgentTools.paged": "摘要尚未完整顯示",
    "subAgentTools.resultDelivered": "子代理結果已送達",
    "subAgentTools.awaitingResult": "等待工具結果",
    "subAgentTools.runNotFound": "找不到該執行",
    "subAgentTools.scopeDenied": "目前對話無權讀取該執行",
    "subAgentTools.notTerminal": "執行結果尚未就緒",
    "subAgentTools.queryFailed": "執行結果查詢失敗",
  },
};
