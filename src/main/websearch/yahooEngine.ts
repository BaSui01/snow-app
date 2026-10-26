/**
 * Yahoo 搜索引擎。
 *
 * 抓取 search.yahoo.com 的公开结果页，不依赖任何官方 API。
 *
 * DOM 契约（2026-10-27 实测）：
 *   - 每条自然结果位于 `#web .algo`（单页 6-7 条，`n` 参数不改变每页条数）
 *   - 标题链接为 `div.compTitle a`，href 即真实 URL（无跳转包装）
 *   - 标题文本位于 `h3`，摘要位于 `div.compText`
 *   - 展示 URL 位于 `div.compTitle .d-ib.p-abs span`，其中站点名（favicon 文本）
 *     与 URL 混排，按 `http` 起始位置截取
 *   - 翻页使用 `b` 参数（首条序号：第一页 1、第二页 11，步长 10）
 *
 * 语言与时间范围：Yahoo 没有可稳定映射的 URL 参数，这两个筛选项在本引擎上不生效。
 */

import type { Page } from "puppeteer-core";
import type { EngineRequest, SearchEngine, SearchResult } from "./types";
import { cleanText } from "./textUtils";

/** 单页结果条数（实测 6-7 条，按 7 估算页数）。 */
const PAGE_SIZE = 7;
/** 翻页步长（`b` 参数每页递增 10）。 */
const PAGE_STEP = 10;

const buildSearchUrl = (query: string, pageIndex: number): string => {
  const params = new URLSearchParams({ p: query });
  if (pageIndex > 0) {
    params.set("b", String(1 + pageIndex * PAGE_STEP));
  }
  return `https://search.yahoo.com/search?${params.toString()}`;
};

/** 从当前页面提取一页结果（最多 PAGE_SIZE 条）。 */
const extractPageResults = async (page: Page): Promise<SearchResult[]> => {
  try {
    await page.waitForSelector("#web .algo", { timeout: 10000 });
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
    const items = document.querySelectorAll("#web .algo");

    for (const item of items) {
      if (out.length >= maxLimit) break;

      const anchor = item.querySelector(
        "div.compTitle a[href]",
      ) as HTMLAnchorElement | null;
      const url = anchor?.getAttribute("href") ?? "";
      if (!/^https?:\/\//i.test(url)) continue;

      const title = (item.querySelector("h3")?.textContent ?? "").trim();
      if (!title) continue;

      // 展示 URL：站点名与 URL 混排在同一段文本里，从 http 起始处截取。
      const urlText = Array.from(
        item.querySelectorAll("div.compTitle .d-ib.p-abs span"),
      )
        .map((span) => span.textContent ?? "")
        .find((text) => text.includes("http"));
      const httpIndex = urlText ? urlText.search(/https?:\/\//) : -1;

      out.push({
        title,
        url,
        snippet: item.querySelector("div.compText")?.textContent ?? "",
        displayUrl: httpIndex >= 0 ? urlText!.slice(httpIndex) : "",
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

export class YahooEngine implements SearchEngine {
  readonly id = "yahoo";
  readonly name = "Yahoo";

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
