/** 全局角色/规则文件（~/.snow/ROLE.md）的读取结果。 */
export type GlobalRoleFile = {
  /** 全局 ROLE.md 的绝对路径。 */
  filePath: string;
  /** 文件内容；文件尚不存在时为空字符串。 */
  content: string;
  /** 全局 ROLE 是否覆盖内置系统提示词（~/.snow/settings.json 的 role.overrideRoleIds）。 */
  overrideBuiltinPrompt: boolean;
};
