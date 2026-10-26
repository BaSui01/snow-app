import type { Locale } from "../../../shared/locale";

export const markdownAcceptanceTranslations: Record<
  Locale,
  Record<string, string>
> = {
  en: {
    "markdown.acceptance.title": "Acceptance report",
    "markdown.acceptance.count": "{{completed}} / {{total}} reported complete",
    "markdown.acceptance.completed": "Reported complete",
    "markdown.acceptance.incomplete": "Incomplete",
    "markdown.acceptance.blocked": "Blocked",
    "markdown.acceptance.unverified": "Unverified",
    "markdown.acceptance.reason": "Reason",
    "markdown.acceptance.evidence": "Evidence references",
    "markdown.acceptance.copy": "Copy report",
    "markdown.acceptance.copyFailed": "Could not copy report",
    "markdown.acceptance.copied": "Copied",
  },
  "zh-CN": {
    "markdown.acceptance.title": "验收报告",
    "markdown.acceptance.count": "{{completed}} / {{total}} 项报告完成",
    "markdown.acceptance.completed": "报告完成",
    "markdown.acceptance.incomplete": "未完成",
    "markdown.acceptance.blocked": "受阻",
    "markdown.acceptance.unverified": "未核验",
    "markdown.acceptance.reason": "原因",
    "markdown.acceptance.evidence": "证据引用",
    "markdown.acceptance.copy": "复制报告",
    "markdown.acceptance.copyFailed": "复制报告失败",
    "markdown.acceptance.copied": "已复制",
  },
  "zh-TW": {
    "markdown.acceptance.title": "驗收報告",
    "markdown.acceptance.count": "{{completed}} / {{total}} 項回報完成",
    "markdown.acceptance.completed": "回報完成",
    "markdown.acceptance.incomplete": "未完成",
    "markdown.acceptance.blocked": "受阻",
    "markdown.acceptance.unverified": "未核驗",
    "markdown.acceptance.reason": "原因",
    "markdown.acceptance.evidence": "證據引用",
    "markdown.acceptance.copy": "複製報告",
    "markdown.acceptance.copyFailed": "複製報告失敗",
    "markdown.acceptance.copied": "已複製",
  },
};
