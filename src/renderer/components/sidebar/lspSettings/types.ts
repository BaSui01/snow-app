import type { LspServerConfigRecord } from "../../../../preload";

export type LspServerConfig = LspServerConfigRecord;

export type LspStringItem = {
  id: string;
  value: string;
};

export type LspServerDraft = {
  /** 空字符串 = 新建 */
  id: string;
  /** 语言标识（唯一键） */
  lang: string;
  /** 启动命令 */
  command: string;
  /** 命令参数（argsJson 拆分） */
  args: LspStringItem[];
  /** 关联文件扩展名（fileExtensionsJson 拆分） */
  fileExtensions: LspStringItem[];
  /** 安装提示命令（可空） */
  installCommand: string;
  /** 初始化选项 JSON 文本（可空） */
  initializationOptions: string;
  enabled: boolean;
  sortOrder: number;
  source: string;
};

/** 编辑器 lang 输入的预置语言提示（与 native 种子列表一致）。 */
export const PRESET_LANGS = [
  "typescript",
  "python",
  "go",
  "rust",
  "c",
  "csharp",
  "java",
  "kotlin",
  "php",
  "ruby",
  "lua",
  "swift",
];
