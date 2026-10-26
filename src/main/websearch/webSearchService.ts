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
import { BraveEngine } from "./braveEngine";
import { YahooEngine } from "./yahooEngine";
import { GoogleEngine } from "./googleEngine";
import { StartpageEngine } from "./startpageEngine";
import { SeznamEngine } from "./seznamEngine";
import { YepEngine } from "./yepEngine";
import {
  buildEngineQuery,
  normalizeLanguage,
  normalizeSite,
  normalizeTimeRange,
} from "./searchParams";
import { dedupeSearchResults, rankSearchResults } from "./resultRanking";
import type {
  SearchEngine,
  SearchOptions,
  SearchResponse,
  SearchResult,
} from "./types";

const PROXY_BROWSER_SETTING_CODE = "proxy_browser_settings";
const DEFAULT_SEARCH_ENGINE = "duckduckgo";
/** 默认返回条数：单页只有 10 条，默认取两页以保证召回量。 */
const DEFAULT_MAX_RESULTS = 20;
/** 返回条数上限（引擎按需翻页，最多 5 页）。 */
const MAX_MAX_RESULTS = 50;
/**
 * 搜索结束后的空闲时长：超过该时间没有新的搜索，就关闭 headless 浏览器，
 * 释放其占用的内存与整棵子进程树（浏览器常驻成本远高于重新启动）。
 */
const IDLE_CLOSE_MS = 3 * 60 * 1000;
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
  /** 参与联网搜索的引擎 id 列表（多引擎混合）。 */
  searchEngines?: string[];
  blockedPatterns?: string[];
};

const BUILT_IN_ENGINES: SearchEngine[] = [
  new DuckDuckGoEngine(),
  new BingEngine(),
  new BraveEngine(),
  new YahooEngine(),
  new GoogleEngine(),
  new StartpageEngine(),
  new SeznamEngine(),
  new YepEngine(),
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
  // 空闲回收：空闲计时器与进行中的搜索计数（并发搜索时不得关闭浏览器）
  private idleTimer: NodeJS.Timeout | null = null;
  private activeSearches = 0;
  private disposed = false;

  constructor(private native: NativeBridge) {
    if (process.platform === "win32") {
      this.userDataDir = join(
        tmpdir(),
        `snow-app-puppeteer-profile-${process.pid}`,
      );
    }
  }

  /** 读取代理/搜索引擎设置（与 sessionProxy 同一数据源）。 */
  private async loadSettings(): Promise<ProxyBrowserSettingsJson> {
    try {
      const raw = await this.native.getSystemSettingValue(
        PROXY_BROWSER_SETTING_CODE,
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
            "No system browser found. Please install Chrome or Edge browser, or configure browser path in Proxy and browser settings.",
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
    args: string[],
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
        `Failed to spawn browser process: ${spawnErrorRef.error.message}. Path: ${executablePath}`,
      );
    }
    if (!wsEndpoint) {
      this.killBrowserProcess();
      throw new Error(
        `Browser launched but DevTools endpoint was not reachable on port ${debugPort} after ${maxRetries} retries. Path: ${executablePath}`,
      );
    }

    this.browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint });
    return this.browser;
  }

  /** 读取本地调试端口的 DevTools WebSocket 地址。 */
  private async getBrowserWSEndpoint(
    debugPort: number,
  ): Promise<string | null> {
    try {
      const response = await fetch(
        `http://127.0.0.1:${debugPort}/json/version`,
        {
          signal: AbortSignal.timeout(500),
        },
      );
      if (!response.ok) return null;
      const data = (await response.json()) as { webSocketDebuggerUrl?: string };
      return data.webSocketDebuggerUrl ?? null;
    } catch {
      return null;
    }
  }

  /** Windows 兜底：结束浏览器主进程及其整棵子进程树。 */
  private killBrowserProcess(): void {
    const child = this.browserProcess;
    if (!child) return;
    this.browserProcess = null;

    if (child.killed || child.exitCode !== null) return;

    if (process.platform === "win32" && child.pid) {
      try {
        // 直接 kill 只结束主进程，会残留 renderer / gpu 等子进程。
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        }).unref();
        return;
      } catch {
        // 回退到普通 kill
      }
    }

    try {
      child.kill();
    } catch {
      // 进程可能已退出
    }
  }

  /** 取消待触发的空闲回收。 */
  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** 搜索结束：无进行中的搜索时，安排一次空闲回收。 */
  private scheduleIdleClose(): void {
    this.clearIdleTimer();
    if (this.disposed || this.activeSearches > 0) return;

    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.activeSearches > 0) return;
      void this.closeBrowser();
    }, IDLE_CLOSE_MS);
    // 空闲计时器不应阻止进程退出。
    this.idleTimer.unref();
  }

  /** 关闭浏览器实例。 */
  async closeBrowser(): Promise<void> {
    this.clearIdleTimer();
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

  /** 应用退出时调用：停止空闲回收并关闭浏览器，避免残留 headless 进程。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearIdleTimer();
    await this.closeBrowser();
  }

  private async closePage(page: Page | null): Promise<void> {
    if (!page || page.isClosed()) return;
    try {
      await page.close();
    } catch {
      // 忽略
    }
  }

  /**
   * 解析本次参与检索的引擎：显式 engines 参数优先（覆盖设置），
   * 其次使用设置里勾选的引擎列表；都为空时回退默认引擎。
   */
  private resolveEngines(
    requested: string[] | undefined,
    configured: string[] | undefined,
  ): SearchEngine[] {
    const requestedIds = (requested ?? []).map((id) => id.trim().toLowerCase());
    const explicit = BUILT_IN_ENGINES.filter((engine) =>
      requestedIds.includes(engine.id),
    );
    if (explicit.length > 0) {
      return explicit;
    }

    const configuredIds = (configured ?? []).map((id) =>
      id.trim().toLowerCase(),
    );
    const selected = BUILT_IN_ENGINES.filter((engine) =>
      configuredIds.includes(engine.id),
    );
    if (selected.length > 0) {
      return selected;
    }

    return [
      BUILT_IN_ENGINES.find((engine) => engine.id === DEFAULT_SEARCH_ENGINE)!,
    ];
  }

  /** 执行搜索并返回结构化结果（过滤屏蔽规则命中项，并按相关性重排）。 */
  async search(
    query: string,
    options?: SearchOptions,
  ): Promise<SearchResponse> {
    const requested = options?.maxResults;
    const limit = Math.min(
      Math.max(
        typeof requested === "number" && Number.isFinite(requested)
          ? Math.trunc(requested)
          : DEFAULT_MAX_RESULTS,
        1,
      ),
      MAX_MAX_RESULTS,
    );
    const site = normalizeSite(options?.site);
    const timeRange = normalizeTimeRange(options?.timeRange);
    const language = normalizeLanguage(options?.language);

    try {
      if (this.disposed) {
        throw new Error("Web search service has been disposed");
      }
      this.activeSearches++;
      const settings = await this.loadSettings();
      const engines = this.resolveEngines(
        options?.engineIds,
        settings.searchEngines,
      );

      const browser = await this.launchBrowser();
      const engineQuery = buildEngineQuery(query, site);

      // 多引擎混合：各引擎独立 page 并行抓取，单个引擎失败不影响其它引擎。
      const settled = await Promise.allSettled(
        engines.map(async (engine) => {
          const enginePage = await browser.newPage();
          try {
            await enginePage.setUserAgent(USER_AGENT);
            const results = await engine.search(enginePage, {
              query: engineQuery,
              limit,
              language,
              timeRange,
            });
            return { engineId: engine.id, engineName: engine.name, results };
          } finally {
            await this.closePage(enginePage);
          }
        }),
      );

      const collected: Array<{
        engineId: string;
        engineName: string;
        results: SearchResult[];
      }> = [];
      const failures: string[] = [];

      settled.forEach((outcome, index) => {
        if (outcome.status === "fulfilled") {
          collected.push(outcome.value);
          return;
        }
        const engine = engines[index];
        const message =
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason);
        failures.push(`${engine.name}: ${message}`);
        snowLog.error({
          module: "websearch",
          func: "search",
          message: `Search engine failed: ${engine.name}`,
          error: message,
        });
      });

      if (collected.length === 0) {
        throw new Error(`All search engines failed: ${failures.join("; ")}`);
      }

      // 合并各引擎结果：标记来源引擎与引擎内排名，供去重与重排使用。
      const merged: SearchResult[] = [];
      for (const { engineId, results } of collected) {
        results.forEach((result, rank) => {
          merged.push({ ...result, engines: [engineId], rank });
        });
      }

      const deduped = dedupeSearchResults(merged);
      const { filtered, blockedCount, blockedResults, blockedPatterns } =
        this.applyBlockedRules(deduped, settings.blockedPatterns ?? []);
      const results = rankSearchResults({
        query,
        site,
        engineCount: collected.length,
        results: filtered,
      }).slice(0, limit);

      const response: SearchResponse = {
        query,
        engines: collected.map((entry) => entry.engineId),
        engineNames: collected.map((entry) => entry.engineName),
        results,
        totalResults: results.length,
        ...(blockedCount > 0 ? { blockedCount } : {}),
      };

      // 屏蔽比例达到阈值时，把被屏蔽结果与规则回传给 AI，
      // 并明确提示这些站点当前不可抓取，AI 可据此判断是否需要针对性补充。
      if (blockedResults && blockedPatterns && blockedResults.length > 0) {
        response.blockedResults = blockedResults;
        response.blockedPatterns = blockedPatterns;
        response.blockNote =
          `${blockedCount} of ${deduped.length} search results were filtered ` +
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
      this.activeSearches = Math.max(0, this.activeSearches - 1);
      // 浏览器实例常驻会持续占用内存，空闲后主动回收。
      this.scheduleIdleClose();
    }
  }

  /** 按屏蔽规则（正则列表）过滤搜索结果，返回过滤后的结果与屏蔽数量。 */
  private applyBlockedRules(
    results: SearchResult[],
    patterns: string[],
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
        candidates.some((candidate) => regex.test(candidate)),
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
