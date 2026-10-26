/**
 * Google 搜索引擎。
 *
 * 抓取 www.google.com 的公开结果页，不依赖任何官方 API。
 *
 * DOM 契约（2026-10-27 实测）：
 *   - 结果块为 `div.MjjYud`（其中含非自然结果块），自然结果块内含 `div.yuRUbf`
 *   - 标题链接为 `div.yuRUbf a[href]`，标题文本位于 `h3`
 *   - 摘要位于 `div.VwiC3b`，展示 URL 位于 `cite`
 *
 * URL 还原：Google 把自然结果链接包装成 `/goto?url=<加密串>`，加密串无法本地解码，
 * 但该端点会 302 到真实地址。因此引擎在页面上下文里并发触发这些链接，
 * 通过响应事件读取 302 的 Location 头完成还原（走浏览器网络栈，系统代理自然生效）。
 * 还原失败的条目直接丢弃，避免把 google.com 的跳转地址当成结果。
 *
 * 反爬：Google 对自动化流量可能返回 429 或 "unusual traffic" 页面，
 * 命中时抛出明确错误。语言与时间范围没有可靠的 URL 参数映射，在本引擎上不生效。
 */

import type { HTTPResponse, Page } from "puppeteer-core";
import type { EngineRequest, SearchEngine, SearchResult } from "./types";
import { cleanText } from "./textUtils";

/** 单页结果条数（实测每页约 10 条自然结果）。 */
const PAGE_SIZE = 10;
/** 等待跳转地址还原的最长时间。 */
const REDIRECT_TIMEOUT_MS = 6000;
const GOOGLE_ORIGIN = "https://www.google.com";

type RawResult = {
  title: string;
  href: string;
  snippet: string;
  displayUrl: string;
};

const buildSearchUrl = (query: string, start: number): string => {
  const params = new URLSearchParams({
    q: query,
    num: String(PAGE_SIZE),
    hl: "en",
  });
  if (start > 0) {
    params.set("start", String(start));
  }
  return `${GOOGLE_ORIGIN}/search?${params.toString()}`;
};

/** 判定是否被反爬拦截（限流页 / 验证码页）。 */
const isBlocked = async (page: Page): Promise<boolean> => {
  if (page.url().includes("/sorry/")) {
    return true;
  }
  return page
    .evaluate(() => {
      const text = document.body ? document.body.innerText : "";
      return /unusual traffic|captcha|not a robot/i.test(text.slice(0, 4000));
    })
    .catch(() => false);
};

/** 从当前页面提取一页结果（最多 PAGE_SIZE 条）。 */
const extractPageResults = async (page: Page): Promise<RawResult[]> => {
  try {
    await page.waitForSelector("div.yuRUbf", { timeout: 10000 });
  } catch {
    // 空结果是合法结果，继续尝试提取。
  }

  return page.evaluate((maxLimit: number) => {
    type Item = {
      title: string;
      href: string;
      snippet: string;
      displayUrl: string;
    };
    const out: Item[] = [];
    const blocks = document.querySelectorAll("div.MjjYud, div.g");

    for (const block of blocks) {
      if (out.length >= maxLimit) break;

      const anchor = block.querySelector(
        "div.yuRUbf a[href]",
      ) as HTMLAnchorElement | null;
      const href = anchor?.getAttribute("href") ?? "";
      if (!href) continue;

      const title = (block.querySelector("h3")?.textContent ?? "").trim();
      if (!title) continue;

      out.push({
        title,
        href,
        snippet:
          block.querySelector("div.VwiC3b, div[data-sncf], span.aCOpRe")
            ?.textContent ?? "",
        displayUrl: block.querySelector("cite")?.textContent ?? "",
      });
    }

    return out;
  }, PAGE_SIZE);
};

/**
 * 触发跳转链接并收集 302 的 Location，得到「跳转地址 → 真实地址」映射。
 * 只在页面上下文发请求，因此沿用浏览器的网络栈与代理设置。
 */
const resolveRedirects = async (
  page: Page,
  hrefs: string[],
): Promise<Map<string, string>> => {
  const resolved = new Map<string, string>();
  const pending = new Set(hrefs);
  if (pending.size === 0) {
    return resolved;
  }

  const onResponse = (response: HTTPResponse): void => {
    const status = response.status();
    if (status < 300 || status >= 400) return;
    const location = response.headers()["location"];
    if (!location) return;
    if (pending.delete(response.url())) {
      resolved.set(response.url(), location);
    }
  };

  page.on("response", onResponse);
  try {
    await page.evaluate((urls: string[]) => {
      for (const url of urls) {
        // no-cors：允许跨域跟随重定向，响应体不需要，只取响应头。
        void fetch(url, { mode: "no-cors", credentials: "include" }).catch(
          () => {},
        );
      }
    }, hrefs);

    const deadline = Date.now() + REDIRECT_TIMEOUT_MS;
    while (pending.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    page.off("response", onResponse);
  }

  return resolved;
};

/** 把结果链接还原为真实地址；无法还原时返回空串。 */
const restoreUrl = (href: string, resolved: Map<string, string>): string => {
  let url: URL;
  try {
    url = new URL(href, GOOGLE_ORIGIN);
  } catch {
    return "";
  }

  if (url.pathname === "/goto") {
    return resolved.get(url.href) ?? "";
  }

  if (url.pathname === "/url") {
    const wrapped = url.searchParams.get("url") ?? url.searchParams.get("q");
    if (wrapped && /^https?:\/\//i.test(wrapped)) {
      return wrapped;
    }
    return resolved.get(url.href) ?? "";
  }

  return /^https?:\/\//i.test(url.href) ? url.href : "";
};

export class GoogleEngine implements SearchEngine {
  readonly id = "google";
  readonly name = "Google";

  async search(page: Page, request: EngineRequest): Promise<SearchResult[]> {
    const maxPages = Math.max(1, Math.ceil(request.limit / PAGE_SIZE));
    const collected: SearchResult[] = [];

    for (
      let index = 0;
      index < maxPages && collected.length < request.limit;
      index++
    ) {
      try {
        await page.goto(buildSearchUrl(request.query, index * PAGE_SIZE), {
          waitUntil: "domcontentloaded",
          timeout: 35000,
        });
      } catch {
        // 导航超时——尝试提取已加载的内容。
      }

      if (await isBlocked(page)) {
        throw new Error(
          "Google blocked the automated search request (captcha / unusual traffic page). " +
            "Open Google once in a normal browser or switch network, then retry.",
        );
      }

      const raw = await extractPageResults(page);
      // 空页说明已到结果末尾，停止翻页。
      if (raw.length === 0) {
        break;
      }

      const redirectHrefs = raw
        .map((item) => {
          try {
            return new URL(item.href, GOOGLE_ORIGIN).href;
          } catch {
            return "";
          }
        })
        .filter((href) => href.includes("/goto?") || href.includes("/url?"));
      const resolved = await resolveRedirects(page, redirectHrefs);

      for (const item of raw) {
        const realUrl = restoreUrl(item.href, resolved);
        if (!realUrl) continue;
        collected.push({
          title: cleanText(item.title),
          url: realUrl,
          snippet: cleanText(item.snippet),
          displayUrl: cleanText(item.displayUrl),
        });
      }
    }

    return collected.slice(0, request.limit);
  }
}
