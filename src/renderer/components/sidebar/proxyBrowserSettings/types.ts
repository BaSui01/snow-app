import type { ProxyBrowserSettings } from "../../../../preload";

export type ProxyBrowserSettingsForm = {
  enabled: boolean;
  host: string;
  port: string;
  browserPath: string;
  browserDebugPort: string;
  /** 勾选的搜索引擎 id（多选，至少一个）。 */
  searchEngines: string[];
  /** textarea 文本：每行一条正则表达式。 */
  blockedPatternsText: string;
};

export type ProxyBrowserSettingsValue = ProxyBrowserSettings;
