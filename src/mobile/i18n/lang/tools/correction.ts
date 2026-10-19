/**
 * 工具纠错 Agent 面板词条（键前缀 remote.toolCall.correction.*）。
 *
 * 覆盖：面板标题 / 副标题、整体状态、尝试次数、尝试状态、原始参数、修正参数、
 * 执行结果与失败原因；三语同键，文案与桌面端 toolCall.correction.* 对齐。
 */

export const correctionEn: Record<string, string> = {
  "remote.toolCall.correction.title": "Correction agent",
  "remote.toolCall.correction.subtitle": "Basic model",
  "remote.toolCall.correction.attemptCount": "{{count}} repairs",
  "remote.toolCall.correction.originalArguments": "Original arguments",
  "remote.toolCall.correction.attempt": "Repair {{index}}",
  "remote.toolCall.correction.status.running": "Repairing",
  "remote.toolCall.correction.status.succeeded": "Repaired",
  "remote.toolCall.correction.status.failed": "Repair failed",
  "remote.toolCall.correction.status.abandoned": "Stopped",
  "remote.toolCall.correction.attemptStatus.running": "Running",
  "remote.toolCall.correction.attemptStatus.succeeded": "Succeeded",
  "remote.toolCall.correction.attemptStatus.failed": "Failed",
  "remote.toolCall.correction.attemptStatus.rejected": "Not approved",
  "remote.toolCall.correction.arguments": "Corrected arguments",
  "remote.toolCall.correction.result": "Execution result",
  "remote.toolCall.correction.details": "View arguments and result",
  "remote.toolCall.correction.replaced":
    "The corrected call and result replaced the main flow",
  "remote.toolCall.correction.failure.max_attempts":
    "Stopped after 3 repairs; the original error is used",
  "remote.toolCall.correction.failure.model_error":
    "The correction model produced no usable repair",
  "remote.toolCall.correction.failure.not_repairable":
    "The correction model judged this error unfixable by changing arguments",
  "remote.toolCall.correction.failure.rejected":
    "The corrected call was not approved; the original error is used",
  "remote.toolCall.correction.failure.cancelled":
    "The conversation was cancelled; correction stopped",
};

export const correctionZhCN: Record<string, string> = {
  "remote.toolCall.correction.title": "纠错 Agent",
  "remote.toolCall.correction.subtitle": "基础模型",
  "remote.toolCall.correction.attemptCount": "{{count}} 次纠错",
  "remote.toolCall.correction.originalArguments": "原始参数",
  "remote.toolCall.correction.attempt": "第 {{index}} 次纠错",
  "remote.toolCall.correction.status.running": "纠错中",
  "remote.toolCall.correction.status.succeeded": "纠错成功",
  "remote.toolCall.correction.status.failed": "纠错失败",
  "remote.toolCall.correction.status.abandoned": "已停止",
  "remote.toolCall.correction.attemptStatus.running": "执行中",
  "remote.toolCall.correction.attemptStatus.succeeded": "成功",
  "remote.toolCall.correction.attemptStatus.failed": "失败",
  "remote.toolCall.correction.attemptStatus.rejected": "未授权",
  "remote.toolCall.correction.arguments": "修正参数",
  "remote.toolCall.correction.result": "执行结果",
  "remote.toolCall.correction.details": "查看参数与结果",
  "remote.toolCall.correction.replaced": "已用修正后的调用与结果替换主流程",
  "remote.toolCall.correction.failure.max_attempts":
    "已达到 3 次纠错上限，继续使用原始错误",
  "remote.toolCall.correction.failure.model_error": "纠错模型未能给出可用结果",
  "remote.toolCall.correction.failure.not_repairable":
    "纠错模型判断该错误无法通过修改参数修复",
  "remote.toolCall.correction.failure.rejected":
    "修正后的调用未获授权，已保留原始错误",
  "remote.toolCall.correction.failure.cancelled": "会话已取消，纠错中止",
};

export const correctionZhTW: Record<string, string> = {
  "remote.toolCall.correction.title": "糾錯 Agent",
  "remote.toolCall.correction.subtitle": "基礎模型",
  "remote.toolCall.correction.attemptCount": "{{count}} 次糾錯",
  "remote.toolCall.correction.originalArguments": "原始參數",
  "remote.toolCall.correction.attempt": "第 {{index}} 次糾錯",
  "remote.toolCall.correction.status.running": "糾錯中",
  "remote.toolCall.correction.status.succeeded": "糾錯成功",
  "remote.toolCall.correction.status.failed": "糾錯失敗",
  "remote.toolCall.correction.status.abandoned": "已停止",
  "remote.toolCall.correction.attemptStatus.running": "執行中",
  "remote.toolCall.correction.attemptStatus.succeeded": "成功",
  "remote.toolCall.correction.attemptStatus.failed": "失敗",
  "remote.toolCall.correction.attemptStatus.rejected": "未授權",
  "remote.toolCall.correction.arguments": "修正參數",
  "remote.toolCall.correction.result": "執行結果",
  "remote.toolCall.correction.details": "檢視參數與結果",
  "remote.toolCall.correction.replaced": "已用修正後的調用與結果替換主流程",
  "remote.toolCall.correction.failure.max_attempts":
    "已達到 3 次糾錯上限，繼續使用原始錯誤",
  "remote.toolCall.correction.failure.model_error": "糾錯模型未能給出可用結果",
  "remote.toolCall.correction.failure.not_repairable":
    "糾錯模型判斷該錯誤無法透過修改參數修復",
  "remote.toolCall.correction.failure.rejected":
    "修正後的調用未獲授權，已保留原始錯誤",
  "remote.toolCall.correction.failure.cancelled": "會話已取消，糾錯中止",
};
