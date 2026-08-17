import type { ProxyBrowserSettings } from "../../../../preload";

export type ProxyBrowserSettingsPanelProps = {
  onClose?: () => void;
};

export type ProxyBrowserSettingsForm = {
  enabled: boolean;
  host: string;
  port: string;
  browserPath: string;
  browserDebugPort: string;
  searchEngine: string;
  /** textarea 文本：每行一条正则表达式。 */
  blockedPatternsText: string;
};

export type ProxyBrowserSettingsValue = ProxyBrowserSettings;
