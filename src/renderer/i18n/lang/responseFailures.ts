import type { Locale } from "../../../shared/locale";

export const responseFailureTranslations: Record<
  Locale,
  Record<string, string>
> = {
  en: {
    "chat.error.missingReason":
      "Response failed; no specific reason was retained",
    "chat.error.modelRetryToolsBlocked":
      "This model response cannot be retried safely. Completed tool results have been retained. Continue from the current conversation without replaying tool actions.",
    "chat.error.modelRetryToolCallsRejected":
      "Model response retry returned tool calls. No tool action was executed.",
    "chat.subAgentRetry.retry": "Retry model response",
    "toolCall.subAgent.retry": "Retry model response",
  },
  "zh-CN": {
    "chat.error.missingReason": "响应失败，未保留具体原因",
    "chat.error.modelRetryToolsBlocked":
      "无法安全重试此模型响应，已保留完成的工具结果；请从当前会话继续，不要重放工具动作。",
    "chat.error.modelRetryToolCallsRejected":
      "模型响应重试返回了工具调用，未执行任何工具动作。",
    "chat.subAgentRetry.retry": "重试模型响应",
    "toolCall.subAgent.retry": "重试模型响应",
  },
  "zh-TW": {
    "chat.error.missingReason": "回應失敗，未保留具體原因",
    "chat.error.modelRetryToolsBlocked":
      "無法安全重試此模型回應，已保留完成的工具結果；請從目前會話繼續，不要重播工具動作。",
    "chat.error.modelRetryToolCallsRejected":
      "模型回應重試傳回了工具呼叫，未執行任何工具動作。",
    "chat.subAgentRetry.retry": "重試模型回應",
    "toolCall.subAgent.retry": "重試模型回應",
  },
};
