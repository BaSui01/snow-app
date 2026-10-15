import type { Locale } from "../../../shared/locale";

export const imageGenerationTranslations: Record<
  Locale,
  Record<string, string>
> = {
  en: {
    "toolCall.imagegen.untracked":
      "This historical task cannot be tracked. Check the image library before retrying; retrying may incur another charge.",
    "toolCall.imagegen.taskFailed": "Image generation failed",
    "toolCall.imagegen.taskCancelled": "Image generation cancelled",
    "toolCall.imagegen.resultUnavailable":
      "The saved image result is unavailable",
    "toolCall.imagegen.registrationFailed":
      "The image batch could not be registered. No new image request was submitted.",
    "toolCall.imagegen.conversationRequired":
      "Image generation requires a saved conversation. No image request was submitted.",
    "toolCall.imagegen.batchSummary":
      "Background image batch finished: {{completed}} completed, {{failed}} failed, {{cancelled}} cancelled ({{total}} tasks). Briefly report the outcome using the existing image cards. Do not generate again, repeat image paths, or render the images again.",
    "toolCall.imagegen.batchReference": "Image batch: {{batchId}}",
    "toolCall.imagegen.backendQueued": "Queued for generation",
    "toolCall.imagegen.queued": "Waiting to submit",
    "toolCall.imagegen.submitting": "Submitting image request",
    "toolCall.imagegen.asyncPendingNotice":
      "Waiting for background image generation",
    "toolCall.imagegen.waiting": "Waiting for image generation",
  },
  "zh-CN": {
    "toolCall.imagegen.untracked":
      "此历史任务无法跟踪。重试前请先检查图库，重新生成可能再次计费。",
    "toolCall.imagegen.taskFailed": "图片生成失败",
    "toolCall.imagegen.taskCancelled": "图片生成已取消",
    "toolCall.imagegen.resultUnavailable": "已保存的图片结果不可用",
    "toolCall.imagegen.registrationFailed":
      "图片批次登记失败，未提交新的生图请求。",
    "toolCall.imagegen.conversationRequired":
      "请先保存会话，尚未提交生图请求。",
    "toolCall.imagegen.batchSummary":
      "后台生图批次已结束：成功 {{completed}} 项，失败 {{failed}} 项，取消 {{cancelled}} 项，共 {{total}} 项。请结合现有图片卡片简要告知结果，不要重新生成、重复图片路径或再次渲染图片。",
    "toolCall.imagegen.batchReference": "生图批次：{{batchId}}",
    "toolCall.imagegen.backendQueued": "排队生成",
    "toolCall.imagegen.queued": "等待提交",
    "toolCall.imagegen.submitting": "正在提交生图请求",
    "toolCall.imagegen.asyncPendingNotice": "等待后台图片生成",
    "toolCall.imagegen.waiting": "等待图片生成",
  },
  "zh-TW": {
    "toolCall.imagegen.untracked":
      "此歷史任務無法追蹤。重試前請先檢查圖庫，重新生成可能再次計費。",
    "toolCall.imagegen.taskFailed": "圖片生成失敗",
    "toolCall.imagegen.taskCancelled": "圖片生成已取消",
    "toolCall.imagegen.resultUnavailable": "已儲存的圖片結果無法使用",
    "toolCall.imagegen.registrationFailed":
      "圖片批次登記失敗，未提交新的生圖請求。",
    "toolCall.imagegen.conversationRequired":
      "請先儲存會話，尚未提交生圖請求。",
    "toolCall.imagegen.batchSummary":
      "背景生圖批次已結束：成功 {{completed}} 項，失敗 {{failed}} 項，取消 {{cancelled}} 項，共 {{total}} 項。請結合現有圖片卡片簡要告知結果，不要重新生成、重複圖片路徑或再次顯示圖片。",
    "toolCall.imagegen.batchReference": "生圖批次：{{batchId}}",
    "toolCall.imagegen.backendQueued": "排隊生成",
    "toolCall.imagegen.queued": "等待提交",
    "toolCall.imagegen.submitting": "正在提交生圖請求",
    "toolCall.imagegen.asyncPendingNotice": "等待背景圖片生成",
    "toolCall.imagegen.waiting": "等待圖片生成",
  },
};
