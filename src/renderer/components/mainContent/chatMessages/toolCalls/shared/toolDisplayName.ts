/**
 * 工具显示名解析（工具卡片徽章与子代理活动列表共用）。
 *
 * 只查 `toolNames.<工具全名>` 词条（如 `filesystem-read`、`lsp-goto`）；
 * 内置工具必须全部收录，未收录的外部 MCP 工具回退为去掉 server 前缀的
 * 原始短名（`dbx_list_tables` → `list_tables`）。
 */

type TranslateFn = (key: string, options?: { defaultValue?: string }) => string;

/**
 * 提取工具短名：去掉 `prefix-`（内置工具）或 `prefix_`（外部 MCP 规范化名，
 * 如 dbx_list_tables -> list_tables），未匹配时返回原名。
 */
export const getToolShortName = (name: string): string =>
  name.replace(/^.*?[-_]/, "");

export const resolveToolDisplayName = (
  t: TranslateFn,
  toolName: string,
): string => {
  // 注意：用 `||` 而非 `??`——i18n 查找可能返回空字符串（defaultValue: ""），
  // 空字符串应视为"未收录"并继续走 fallback 链。
  const localized = t(`toolNames.${toolName}`, { defaultValue: "" });
  return localized || getToolShortName(toolName);
};
