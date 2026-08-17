import type { ProxyBrowserSettings } from "../../../../preload";

export const PROXY_BROWSER_SETTING_NAME = "Proxy and browser settings";
export const PROXY_BROWSER_SETTING_CODE = "proxy_browser_settings";
export const PROXY_BROWSER_SETTINGS_CHANGED_EVENT =
  "proxy-browser-settings:changed";

export const DEFAULT_PROXY_HOST = "127.0.0.1";

export const DEFAULT_PROXY_BROWSER_SETTINGS: ProxyBrowserSettings = {
  enabled: false,
  host: DEFAULT_PROXY_HOST,
  port: 7890,
  browserPath: "",
  browserDebugPort: 9222,
  searchEngine: "duckduckgo",
  blockedPatterns: [],
};

export const SEARCH_ENGINE_OPTIONS = [
  { value: "duckduckgo", label: "DuckDuckGo" },
  { value: "bing", label: "Bing" },
];

/**
 * 推荐屏蔽模板：覆盖低质 SEO 站点及其全部二级/子域名。
 * `(^|\.)` 前缀 + `$` 结尾保证只匹配该域名本身及其子域，不误伤主域其它站点
 * （如 baidu.com 搜索本身、tencent.com 官网）。
 */
export const RECOMMENDED_BLOCKED_PATTERNS: string[] = [
  // 腾讯云计算（cloud.tencent.com 及 *.cloud.tencent.com）
  String.raw`(^|\.)cloud\.tencent\.com$`,
  // 百度文库（wenku.baidu.com 及子域）
  String.raw`(^|\.)wenku\.baidu\.com$`,
  // 百度智能云（cloud.baidu.com / bce.baidu.com 旧域名及子域）
  String.raw`(^|\.)(cloud|bce)\.baidu\.com$`,
  // 百度开发者中心（developer.baidu.com 及子域）
  String.raw`(^|\.)developer\.baidu\.com$`,
  // CSDN 全站（www/blog/ask/download 等子域）
  String.raw`(^|\.)csdn\.net$`,
];
