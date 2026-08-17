/**
 * Web Search Service（照搬 Snow CLI 的 WebSearchService，无 WSL / fetch 分支）。
 *
 * 使用 puppeteer-core 驱动系统安装的 Chrome/Edge/Chromium（headless），
 * 由所选搜索引擎（DuckDuckGo / Bing）在真实浏览器中渲染并提取结果，
 * 从而绕过纯 HTTP 客户端无法执行的 JS 反爬 challenge。
 *
 * 代理与搜索引擎配置来自应用的 proxy_browser_settings 系统设置。
 */

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import type { NativeBridge } from "../native/types";
import { snowLog } from "../../utils/snowLogger";
import { sanitizeProxyHost } from "../settings/proxyBrowserSettings";
import { findBrowserExecutable, isExecutableForPlatform } from "./browserUtils";
import { DuckDuckGoEngine } from "./duckduckgoEngine";
import { BingEngine } from "./bingEngine";
import type { SearchEngine, SearchResponse, SearchResult } from "./types";

const PROXY_BROWSER_SETTING_CODE = "proxy_browser_settings";
const DEFAULT_SEARCH_ENGINE = "duckduckgo";
const DEFAULT_MAX_RESULTS = 10;
/** 屏蔽比例达到该阈值时，把被屏蔽结果与规则回传给 AI 供其选择性补充。 */
const BLOCKED_REPORT_THRESHOLD = 0.5;
/** 回传的被屏蔽结果上限，避免 token 膨胀。 */
const MAX_BLOCKED_REPORT = 10;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

type ProxyBrowserSettingsJson = {
  enabled?: boolean;
  host?: string;
  port?: number;
  browserPath?: string;
  searchEngine?: string;
  blockedPatterns?: string[];
};

const BUILT_IN_ENGINES: SearchEngine[] = [
  new DuckDuckGoEngine(),
  new BingEngine(),
];

export class WebSearchService {
  private browser: Browser | null = null;
  private executablePath: string | null = null;
  private browserLaunchPromise: Promise<Browser> | null = null;
  private browserClosePromise: Promise<void> | null = null;
  // Windows 上手动 spawn 浏览器进程的引用，close 失败时兜底 kill
  private browserProcess: ChildProcess | null = null;
  // Windows 手动模式使用独立 profile，避免锁文件冲突
  private userDataDir: string | undefined;

  constructor(private native: NativeBridge) {
    if (process.platform === "win32") {
      this.userDataDir = join(
        tmpdir(),
        `snow-app-puppeteer-profile-${process.pid}`
      );
    }
  }

  /** 读取代理/搜索引擎设置（与 sessionProxy 同一数据源）。 */
  private async loadSettings(): Promise<ProxyBrowserSettingsJson> {
    try {
      const raw = await this.native.getSystemSettingValue(
        PROXY_BROWSER_SETTING_CODE
      );
      if (raw) {
        return JSON.parse(raw) as ProxyBrowserSettingsJson;
      }
    } catch (error) {
      snowLog.error({
        module: "websearch",
        func: "loadSettings",
        message: "Failed to load proxy browser settings",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return {};
  }

  private async launchBrowser(): Promise<Browser> {
    if (this.browserClosePromise) {
      await this.browserClosePromise;
    }
    if (this.browser && this.browser.connected) {
      return this.browser;
    }
    if (this.browserLaunchPromise) {
      return this.browserLaunchPromise;
    }
    this.browserLaunchPromise = this.createBrowser().finally(() => {
      this.browserLaunchPromise = null;
    });
    return this.browserLaunchPromise;
  }

  private async createBrowser(): Promise<Browser> {
    const settings = await this.loadSettings();

    // 浏览器路径优先级：1. 用户配置（须为当前平台可执行文件），2. 系统自动发现
    if (!this.executablePath) {
      if (
        settings.browserPath &&
        isExecutableForPlatform(settings.browserPath) &&
        existsSync(settings.browserPath)
      ) {
        this.executablePath = settings.browserPath;
      } else {
        this.executablePath = findBrowserExecutable();
        if (!this.executablePath) {
          throw new Error(
            "No system browser found. Please install Chrome or Edge browser, or configure browser path in Proxy and browser settings."
          );
        }
      }
    }

    const launchArgs = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--disable-gpu",
    ];

    // 启用代理时注入代理参数
    if (settings.enabled) {
      const host = sanitizeProxyHost(settings.host);
      const port =
        typeof settings.port === "number" &&
        settings.port >= 1 &&
        settings.port <= 65535
          ? settings.port
          : 7890;
      launchArgs.unshift(`--proxy-server=http://${host}:${port}`);
    }

    // Windows 上 puppeteer.launch() 不可靠（启动器进程提前退出 Code: 0），
    // 采用手动 spawn + HTTP 轮询 + connect 的方式（与 Snow CLI 一致）。
    if (process.platform === "win32") {
      return this.launchBrowserManual(this.executablePath, launchArgs);
    }

    // macOS / Linux：puppeteer.launch() 直接启动
    this.browser = await puppeteer.launch({
      executablePath: this.executablePath,
      headless: true,
      args: launchArgs,
      userDataDir: this.userDataDir,
    });
    return this.browser;
  }

  /** Windows：手动 spawn headless 浏览器进程并通过 DevTools WebSocket 连接。 */
  private async launchBrowserManual(
    executablePath: string,
    args: string[]
  ): Promise<Browser> {
    const debugPort = 9300 + Math.floor(Math.random() * 100);

    const allArgs = [
      ...args,
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${debugPort}`,
      "--remote-debugging-address=127.0.0.1",
    ];
    if (this.userDataDir) {
      allArgs.push(`--user-data-dir=${this.userDataDir}`);
    }

    this.browserProcess = spawn(executablePath, allArgs, {
      stdio: "ignore",
      windowsHide: true,
      detached: false,
    });

    const spawnErrorRef: { error: Error | null } = { error: null };
    this.browserProcess.on("error", (err: Error) => {
      spawnErrorRef.error = err;
    });

    // 轮询 DevTools WebSocket 端点
    const maxRetries = 30;
    const retryDelay = 500;
    let wsEndpoint: string | null = null;

    for (let i = 0; i < maxRetries; i++) {
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      wsEndpoint = await this.getBrowserWSEndpoint(debugPort);
      if (wsEndpoint) break;
      if (spawnErrorRef.error) break;
    }

    if (spawnErrorRef.error) {
      throw new Error(
        `Failed to spawn browser process: ${spawnErrorRef.error.message}. Path: ${executablePath}`
      );
    }
    if (!wsEndpoint) {
      this.killBrowserProcess();
      throw new Error(
        `Browser launched but DevTools endpoint was not reachable on port ${debugPort} after ${maxRetries} retries. Path: ${executablePath}`
      );
    }

    this.browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
    return this.browser;
  }

  /** 读取本地调试端口的 DevTools WebSocket 地址。 */
  private async getBrowserWSEndpoint(debugPort: number): Promise<string | null> {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, {
        signal: AbortSignal.timeout(500),
      });
      if (!response.ok) return null;
      const data = (await response.json()) as { webSocketDebuggerUrl?: string };
      return data.webSocketDebuggerUrl ?? null;
    } catch {
      return null;
    }
  }

  private killBrowserProcess(): void {
    if (!this.browserProcess) return;
    try {
      if (!this.browserProcess.killed) {
        this.browserProcess.kill();
      }
    } catch {
      // 进程可能已退出
    }
    this.browserProcess = null;
  }

  /** 关闭浏览器实例。 */
  async closeBrowser(): Promise<void> {
    if (this.browserClosePromise) {
      return this.browserClosePromise;
    }
    this.browserClosePromise = this.closeBrowserInternal().finally(() => {
      this.browserClosePromise = null;
    });
    return this.browserClosePromise;
  }

  private async closeBrowserInternal(): Promise<void> {
    const browser = this.browserLaunchPromise
      ? await this.browserLaunchPromise.catch(() => null)
      : this.browser;

    if (!browser) {
      this.browser = null;
      this.killBrowserProcess();
      return;
    }

    try {
      if (browser.connected) {
        await browser.close();
      }
    } catch {
      // 忽略关闭错误
    }
    this.killBrowserProcess();
    this.browser = null;
  }

  private async closePage(page: Page | null): Promise<void> {
    if (!page || page.isClosed()) return;
    try {
      await page.close();
    } catch {
      // 忽略
    }
  }

  private resolveEngine(id: string | undefined): SearchEngine {
    const engineId = (id ?? "").trim().toLowerCase();
    const engine = BUILT_IN_ENGINES.find((e) => e.id === engineId);
    return engine ?? BUILT_IN_ENGINES.find((e) => e.id === DEFAULT_SEARCH_ENGINE)!;
  }

  /** 执行搜索并返回结构化结果（自动过滤命中屏蔽规则的结果）。 */
  async search(query: string, maxResults?: number): Promise<SearchResponse> {
    const limit = Math.min(Math.max(maxResults ?? DEFAULT_MAX_RESULTS, 1), 20);
    let page: Page | null = null;

    try {
      const settings = await this.loadSettings();
      const engine = this.resolveEngine(settings.searchEngine);

      const browser = await this.launchBrowser();
      page = await browser.newPage();
      await page.setUserAgent(USER_AGENT);

const results = await engine.search(page, query, limit);
      const {
        filtered,
        blockedCount,
        blockedResults,
        blockedPatterns,
      } = this.applyBlockedRules(results, settings.blockedPatterns ?? []);

      const response: SearchResponse = {
        query,
        results: filtered,
        totalResults: filtered.length,
        ...(blockedCount > 0 ? { blockedCount } : {}),
      };

      // 屏蔽比例达到阈值时，把被屏蔽结果与规则回传给 AI，
      // 并明确提示这些站点当前不可抓取，AI 可据此判断是否需要针对性补充。
      if (blockedResults && blockedPatterns && blockedResults.length > 0) {
        response.blockedResults = blockedResults;
        response.blockedPatterns = blockedPatterns;
        response.blockNote =
          `${blockedCount} of ${results.length} search results were filtered ` +
          `out by your site blocking rules (${blockedPatterns.join(", ")}). ` +
          `These sites are NOT fetchable while the rules are active. ` +
          `If one of them is truly relevant despite the rule, tell the user ` +
          `which rule should be removed in Settings, or rephrase the query ` +
          `to find the information on non-blocked sites.`;
      }

      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Web search failed: ${message}`);
    } finally {
      await this.closePage(page);
    }
  }

/** 按屏蔽规则（正则列表）过滤搜索结果，返回过滤后的结果与屏蔽数量。 */
  private applyBlockedRules(
    results: SearchResult[],
    patterns: string[]
  ): {
    filtered: SearchResult[];
    blockedCount: number;
    blockedResults?: SearchResult[];
    blockedPatterns?: string[];
  } {
    if (patterns.length === 0) {
      return { filtered: results, blockedCount: 0 };
    }

    const compiled: RegExp[] = [];
    for (const pattern of patterns) {
      try {
        compiled.push(new RegExp(pattern, "i"));
      } catch {
        snowLog.error({
          module: "websearch",
          func: "applyBlockedRules",
          message: "Invalid blocked pattern, skipped",
          error: pattern,
        });
      }
    }

    if (compiled.length === 0) {
      return { filtered: results, blockedCount: 0 };
    }

    const isBlocked = (url: string): boolean => {
      const candidates = [url];
      try {
        candidates.push(new URL(url).host);
      } catch {
        // 非标准 URL 直接匹配原文
      }
      return compiled.some((regex) =>
        candidates.some((candidate) => regex.test(candidate))
      );
    };

    const blocked = results.filter((result) => isBlocked(result.url));
    const filtered = results.filter((result) => !isBlocked(result.url));

    const result: {
      filtered: SearchResult[];
      blockedCount: number;
      blockedResults?: SearchResult[];
      blockedPatterns?: string[];
    } = {
      filtered,
      blockedCount: blocked.length,
    };

    // 屏蔽比例达到阈值时附带被屏蔽结果与规则，供 AI 判断是否需要补充。
    if (
      results.length > 0 &&
      blocked.length / results.length >= BLOCKED_REPORT_THRESHOLD
    ) {
      result.blockedResults = blocked.slice(0, MAX_BLOCKED_REPORT);
      result.blockedPatterns = compiled.map((regex) => regex.source);
    }

    return result;
  }
}
