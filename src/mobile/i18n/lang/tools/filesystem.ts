/**
 * filesystem 工具族词条：文件工具卡片（filesystem-read / filesystem-replace_edit /
 * filesystem-create，渲染见 mobile/tools/filesystem.ts）与卡片内嵌的行级 diff
 * （diff 自身的词条在 lang/tools/diff.ts，本文件不要重复登记）。
 *
 * 键前缀统一 remote.toolCall.filesystem.*，三语必须同键；折叠 / 参数 / 结果 / 截断
 * 等公共词条归 lang/tools/common.ts（聚合器 lang/tools/index.ts 里 common 最后合并）。
 */

export const filesystemEn: Record<string, string> = {
  // 头部徽章（.tool-name 内的模块名，图标由渲染器补入）
  "remote.toolCall.filesystem.read": "Read",
  "remote.toolCall.filesystem.edit": "Edit",
  "remote.toolCall.filesystem.create": "Create",

  // 提示（参数截断 / 结果回退 / 空态 / 预览）
  "remote.toolCall.filesystem.noArguments": "No arguments",
  "remote.toolCall.filesystem.argsTruncated":
    "Arguments were truncated - the content below is incomplete",
  "remote.toolCall.filesystem.diffUnavailable":
    "Arguments were truncated - the full diff cannot be shown",
  "remote.toolCall.filesystem.rawFallback":
    "Could not parse the result; showing raw text",
  "remote.toolCall.filesystem.preview": "Preview",

  // read：行范围与计数
  "remote.toolCall.filesystem.linesTotal": "{{count}} lines",
  "remote.toolCall.filesystem.linesRange": "L{{start}}-{{end}}",
  "remote.toolCall.filesystem.lineSingle": "L{{line}}",
  "remote.toolCall.filesystem.lineWindow": "Lines {{start}}-{{end}} of {{total}}",
  "remote.toolCall.filesystem.fileCount": "{{count}} files",
  "remote.toolCall.filesystem.entryCount": "{{count}} entries",
  "remote.toolCall.filesystem.imagePreview": "Image preview ({{mediaType}})",

  // replace_edit
  "remote.toolCall.filesystem.occurrence": "Occurrence",
  "remote.toolCall.filesystem.matchedLine": "matched at line {{line}}",
  "remote.toolCall.filesystem.matchedIndex": "matched at index {{index}}",

  // create
  "remote.toolCall.filesystem.created": "created {{path}}",
  "remote.toolCall.filesystem.overwrite": "Overwrite",
  "remote.toolCall.filesystem.directory": "Directory",
};

export const filesystemZhCN: Record<string, string> = {
  "remote.toolCall.filesystem.read": "读取",
  "remote.toolCall.filesystem.edit": "编辑",
  "remote.toolCall.filesystem.create": "创建",

  "remote.toolCall.filesystem.noArguments": "无参数",
  "remote.toolCall.filesystem.argsTruncated": "参数已被截断，下方内容不完整",
  "remote.toolCall.filesystem.diffUnavailable": "参数已被截断，无法展示完整 diff",
  "remote.toolCall.filesystem.rawFallback": "无法解析结构化结果，显示原文",
  "remote.toolCall.filesystem.preview": "预览",

  "remote.toolCall.filesystem.linesTotal": "共 {{count}} 行",
  "remote.toolCall.filesystem.linesRange": "第 {{start}}-{{end}} 行",
  "remote.toolCall.filesystem.lineSingle": "第 {{line}} 行",
  "remote.toolCall.filesystem.lineWindow": "第 {{start}}-{{end}} 行，共 {{total}} 行",
  "remote.toolCall.filesystem.fileCount": "{{count}} 个文件",
  "remote.toolCall.filesystem.entryCount": "{{count}} 个条目",
  "remote.toolCall.filesystem.imagePreview": "图片预览（{{mediaType}}）",

  "remote.toolCall.filesystem.occurrence": "匹配序号",
  "remote.toolCall.filesystem.matchedLine": "匹配于第 {{line}} 行",
  "remote.toolCall.filesystem.matchedIndex": "匹配于第 {{index}} 处",

  "remote.toolCall.filesystem.created": "已创建 {{path}}",
  "remote.toolCall.filesystem.overwrite": "覆盖",
  "remote.toolCall.filesystem.directory": "目录",
};

export const filesystemZhTW: Record<string, string> = {
  "remote.toolCall.filesystem.read": "讀取",
  "remote.toolCall.filesystem.edit": "編輯",
  "remote.toolCall.filesystem.create": "建立",

  "remote.toolCall.filesystem.noArguments": "無參數",
  "remote.toolCall.filesystem.argsTruncated": "參數已被截斷，下方內容不完整",
  "remote.toolCall.filesystem.diffUnavailable": "參數已被截斷，無法顯示完整 diff",
  "remote.toolCall.filesystem.rawFallback": "無法解析結構化結果，顯示原文",
  "remote.toolCall.filesystem.preview": "預覽",

  "remote.toolCall.filesystem.linesTotal": "共 {{count}} 行",
  "remote.toolCall.filesystem.linesRange": "第 {{start}}-{{end}} 行",
  "remote.toolCall.filesystem.lineSingle": "第 {{line}} 行",
  "remote.toolCall.filesystem.lineWindow": "第 {{start}}-{{end}} 行，共 {{total}} 行",
  "remote.toolCall.filesystem.fileCount": "{{count}} 個檔案",
  "remote.toolCall.filesystem.entryCount": "{{count}} 個項目",
  "remote.toolCall.filesystem.imagePreview": "圖片預覽（{{mediaType}}）",

  "remote.toolCall.filesystem.occurrence": "符合序號",
  "remote.toolCall.filesystem.matchedLine": "符合於第 {{line}} 行",
  "remote.toolCall.filesystem.matchedIndex": "符合於第 {{index}} 處",

  "remote.toolCall.filesystem.created": "已建立 {{path}}",
  "remote.toolCall.filesystem.overwrite": "覆寫",
  "remote.toolCall.filesystem.directory": "目錄",
};
