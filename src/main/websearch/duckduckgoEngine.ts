/**
 * DuckDuckGo 搜索引擎（照搬 Snow CLI 的 duckduckgo.engine.ts）。
 *
 * 使用轻量级 `lite.duckduckgo.com/lite` 端点：渲染纯 HTML 表格，
 * 不依赖重型 JS bundle，是 headless 浏览器最可靠的抓取目标。
 */

import type { Page } from "puppeteer-core";
import type { SearchEngine, SearchResult } from "./types";
import { cleanText } from "./textUtils";

export class DuckDuckGoEngine implements SearchEngine {
  readonly id = "duckduckgo";
  readonly name = "DuckDuckGo";

  async search(
    page: Page,
    query: string,
    maxResults: number
  ): Promise<SearchResult[]> {
    const encodedQuery = encodeURIComponent(query);
    const searchUrl = `https://lite.duckduckgo.com/lite?q=${encodedQuery}`;

    await page.goto(searchUrl, {
      waitUntil: "networkidle2",
      timeout: 30000,
    });

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
          currentResult.displayUrl =
            displayUrlElement.textContent?.trim() || "";
        }
      }

      if (
        currentResult.title &&
        currentResult.url &&
        resultCount < maxLimit
      ) {
        searchResults.push(currentResult);
      }

      return searchResults;
    }, maxResults);

    return results.map((r) => ({
      title: cleanText(r.title || ""),
      url: r.url || "",
      snippet: cleanText(r.snippet || ""),
      displayUrl: cleanText(r.displayUrl || ""),
    }));
  }
}
