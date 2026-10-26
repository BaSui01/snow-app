/**
 * DuckDuckGo 搜索引擎（lite 端点）。
 *
 * 使用轻量级 `lite.duckduckgo.com/lite` 端点：渲染纯 HTML 表格，
 * 不依赖重型 JS bundle，是 headless 浏览器最可靠的抓取目标。
 * 该端点每页固定 10 条，翻页使用 `s` 参数（步长 10）。
 */

import type { Page } from "puppeteer-core";
import type { EngineRequest, SearchEngine, SearchResult } from "./types";
import { resolveLanguageProfile, resolveTimeFilter } from "./searchParams";
import { cleanText } from "./textUtils";

/** lite 端点单页固定返回 10 条结果。 */
const PAGE_SIZE = 10;

/** 构造 lite 端点搜索 URL（含翻页、区域与时间过滤参数）。 */
const buildSearchUrl = (
  query: string,
  offset: number,
  kl: string | undefined,
  df: string | undefined,
): string => {
  const params = new URLSearchParams({ q: query });
  if (offset > 0) {
    params.set("s", String(offset));
  }
  if (kl) {
    params.set("kl", kl);
  }
  if (df) {
    params.set("df", df);
  }
  return `https://lite.duckduckgo.com/lite/?${params.toString()}`;
};

/** 从当前页面提取一页结果（最多 PAGE_SIZE 条）。 */
const extractPageResults = async (page: Page): Promise<SearchResult[]> => {
  const results = await page.evaluate((maxLimit: number) => {
    type Partial = {
      title?: string;
      url?: string;
      snippet?: string;
      displayUrl?: string;
    };
    const searchResults: Partial[] = [];
    const rows = document.querySelectorAll("table tr");

    let currentResult: Partial = {};
    let resultCount = 0;

    for (const row of rows) {
      if (resultCount >= maxLimit) break;

      // 标题行包含结果链接
      const linkElement = row.querySelector("a.result-link");
      if (linkElement) {
        if (currentResult.title && currentResult.url) {
          searchResults.push(currentResult);
          resultCount++;
          if (resultCount >= maxLimit) break;
        }

        const title = linkElement.textContent?.trim() || "";
        const href = linkElement.getAttribute("href") || "";

        // 从 DuckDuckGo 的重定向包装中解出真实 URL
        let actualUrl = href;
        if (href.includes("uddg=")) {
          const match = href.match(/uddg=([^&]+)/);
          if (match && match[1]) {
            actualUrl = decodeURIComponent(match[1]);
          }
        }

        currentResult = {
          title,
          url: actualUrl,
          snippet: "",
          displayUrl: "",
        };
        continue;
      }

      const snippetElement = row.querySelector("td.result-snippet");
      if (snippetElement && currentResult.title) {
        currentResult.snippet = snippetElement.textContent?.trim() || "";
        continue;
      }

      const displayUrlElement = row.querySelector("span.link-text");
      if (displayUrlElement && currentResult.title) {
        currentResult.displayUrl = displayUrlElement.textContent?.trim() || "";
      }
    }

    if (currentResult.title && currentResult.url && resultCount < maxLimit) {
      searchResults.push(currentResult);
    }

    return searchResults;
  }, PAGE_SIZE);

  return results.map((r) => ({
    title: cleanText(r.title || ""),
    url: r.url || "",
    snippet: cleanText(r.snippet || ""),
    displayUrl: cleanText(r.displayUrl || ""),
  }));
};

export class DuckDuckGoEngine implements SearchEngine {
  readonly id = "duckduckgo";
  readonly name = "DuckDuckGo";

  async search(page: Page, request: EngineRequest): Promise<SearchResult[]> {
    const profile = resolveLanguageProfile(request.language);
    const timeFilter = resolveTimeFilter(request.timeRange);
    const maxPages = Math.max(1, Math.ceil(request.limit / PAGE_SIZE));
    const collected: SearchResult[] = [];

    for (
      let index = 0;
      index < maxPages && collected.length < request.limit;
      index++
    ) {
      const searchUrl = buildSearchUrl(
        request.query,
        index * PAGE_SIZE,
        profile?.ddgKl,
        timeFilter?.ddgDf,
      );

      await page.goto(searchUrl, {
        waitUntil: "networkidle2",
        timeout: 30000,
      });

      const pageResults = await extractPageResults(page);
      // 空页说明已到结果末尾，停止翻页。
      if (pageResults.length === 0) {
        break;
      }
      collected.push(...pageResults);
    }

    return collected.slice(0, request.limit);
  }
}
