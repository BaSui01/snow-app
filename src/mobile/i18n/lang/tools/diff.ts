/**
 * diff 视图词条（键前缀 remote.toolCall.diff.*）。
 *
 * 使用处：tools/diffView.ts（头部文件名 / 统计、折叠条、展开提示、无差异、
 * 降级与截断提示）。文件模块的 fs.* 词汇不再承担 diff 文案。
 */

export const diffEn: Record<string, string> = {
  "remote.toolCall.diff.file": "File",
  "remote.toolCall.diff.stats": "+{{additions}} -{{deletions}} lines",
  "remote.toolCall.diff.foldedLines": "{{count}} folded lines",
  "remote.toolCall.diff.expand": "Expand",
  "remote.toolCall.diff.noDiff": "No changes",
  "remote.toolCall.diff.tooLarge":
    "File too large - showing the full replacement instead",
  "remote.toolCall.diff.truncated": "Truncated - showing the first {{count}} lines",
};

export const diffZhCN: Record<string, string> = {
  "remote.toolCall.diff.file": "文件",
  "remote.toolCall.diff.stats": "+{{additions}} -{{deletions}} 行",
  "remote.toolCall.diff.foldedLines": "已折叠 {{count}} 行",
  "remote.toolCall.diff.expand": "展开",
  "remote.toolCall.diff.noDiff": "无差异",
  "remote.toolCall.diff.tooLarge": "文件过大，已改为整体替换对比",
  "remote.toolCall.diff.truncated": "已截断，仅显示前 {{count}} 行",
};

export const diffZhTW: Record<string, string> = {
  "remote.toolCall.diff.file": "檔案",
  "remote.toolCall.diff.stats": "+{{additions}} -{{deletions}} 行",
  "remote.toolCall.diff.foldedLines": "已折疊 {{count}} 行",
  "remote.toolCall.diff.expand": "展開",
  "remote.toolCall.diff.noDiff": "無差異",
  "remote.toolCall.diff.tooLarge": "檔案過大，已改為整體取代對照",
  "remote.toolCall.diff.truncated": "已截斷，僅顯示前 {{count}} 行",
};
