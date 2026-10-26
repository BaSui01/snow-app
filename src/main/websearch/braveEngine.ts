/**
 * Brave 搜索引擎。
 *
 * 抓取 search.brave.com 的公开结果页，不依赖任何官方 API。
 *
 * DOM 契约（2026-10-27 实测）：
 *   - 每条自然结果位于 `.result-wrapper`（单页固定 20 条）
 *   - 标题链接为 `.result-content a[href^="http"]`，href 即真实 URL（无跳转包装）
 *   - 标题文本位于 `div.title`，摘要位于 `.generic-snippet`，展示 URL 位于 `cite.snippet-url`
 *   - 翻页使用 `offset` 参数（页索引，从 0 开始）
 *
 * 语言与时间范围：Brave 由浏览器语言与出口地区决定，没有可映射的 URL 参数，
 * 因此这两个筛选项在本引擎上不生效（其它引擎各自映射）。
 */

import type { Page } from "puppeteer-core";
import type { EngineRequest, SearchEngine, SearchResult } from "./types";
import { cleanText } from "./textUtils";

/** 单页结果条数（实测固定 20 条）。 */
const PAGE_SIZE = 20;

const buildSearchUrl = (query: string, pageIndex: number): string => {
  const params = new URLSearchParams({ q: query });
  if (pageIndex > 0) {
    params.set("offset", String(pageIndex));
  }
  return `https://search.brave.com/search?${params.toString()}`;
};

/** 从当前页面提取一页结果（最多 PAGE_SIZE 条）。 */
const extractPageResults = async (page: Page): Promise<SearchResult[]> => {
  try {
    await page.waitForSelector(".result-wrapper", { timeout: 10000 });
  } catch {
    // 空结果是合法结果，直接进入提取。
  }

  const results = await page.evaluate((maxLimit: number) => {
    type Partial = {
      title?: string;
      url?: string;
      snippet?: string;
      displayUrl?: string;
    };
    const out: Partial[] = [];
    const wrappers = document.querySelectorAll(".result-wrapper");

    for (const wrapper of wrappers) {
      if (out.length >= maxLimit) break;

      const anchor = wrapper.querySelector(
        'a[href^="http"]',
      ) as HTMLAnchorElement | null;
      const url = anchor?.getAttribute("href") ?? "";
      if (!url) continue;

      const title = (
        wrapper.querySelector("div.title")?.textContent ??
        anchor?.textContent ??
        ""
      ).trim();
      if (!title) continue;

      out.push({
        title,
        url,
        snippet: wrapper.querySelector(".generic-snippet")?.textContent ?? "",
        displayUrl:
          wrapper.querySelector("cite.snippet-url")?.textContent ?? "",
      });
    }

    return out;
  }, PAGE_SIZE);

  return results.map((r) => ({
    title: cleanText(r.title || ""),
    url: r.url || "",
    snippet: cleanText(r.snippet || ""),
    displayUrl: cleanText(r.displayUrl || ""),
  }));
};

export class BraveEngine implements SearchEngine {
  readonly id = "brave";
  readonly name = "Brave";

  async search(page: Page, request: EngineRequest): Promise<SearchResult[]> {
    const maxPages = Math.max(1, Math.ceil(request.limit / PAGE_SIZE));
    const collected: SearchResult[] = [];

    for (
      let index = 0;
      index < maxPages && collected.length < request.limit;
      index++
    ) {
      await page.goto(buildSearchUrl(request.query, index), {
        waitUntil: "domcontentloaded",
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
