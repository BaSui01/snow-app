import type { LucideIcon } from "lucide-react";

/** 指令分组：内置指令在前，用户自定义指令统一排在其后 */
export type ChatCommandGroup = "builtin" | "custom";

export type ChatCommand = {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  /** 附加搜索关键词（如各语言版本的描述），用于指令面板过滤 */
  searchKeywords?: string[];
  disabled?: boolean;
  group?: ChatCommandGroup;
  badge?: string;
  /** prompt 类型自定义指令：返回插入输入框的 chip 编码内容（不直接执行） */
  buildInputContent?: (args?: string) => string;
  execute: (args?: string) => void;
};
