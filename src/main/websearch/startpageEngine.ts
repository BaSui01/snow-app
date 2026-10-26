/**
 * Startpage 搜索引擎。
 *
 * 抓取 www.startpage.com 的公开结果页（Google 索引的隐私代理），不依赖任何官方 API。
 *
 * DOM 契约（2026-10-27 实测）：
 *   - 每条结果位于 `div.result`（单页 11 条）
 *   - 标题链接为 `a.result-title`，href 即真实 URL（无跳转包装）
 *   - 标题文本位于 `h2.wgl-title`，摘要位于 `p.description`
 *   - 展示 URL 位于 `a.wgl-display-url`
 *
 * 该站未发现可用的翻页参数，只抓首屏；语言与时间范围也没有可靠映射，不生效。
 */

import type { Page } from "puppeteer-core";
import type { EngineRequest, SearchEngine, SearchResult } from "./types";
import { cleanText } from "./textUtils";

/** 单页结果条数（实测 11 条）。 */
const PAGE_SIZE = 11;

const buildSearchUrl = (query: string): string => {
  const params = new URLSearchParams({ query });
  return `https://www.startpage.com/sp/search?${params.toString()}`;
};

/** 从当前页面提取一页结果（最多 PAGE_SIZE 条）。 */
const extractPageResults = async (page: Page): Promise<SearchResult[]> => {
  try {
    await page.waitForSelector("div.result", { timeout: 10000 });
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
    const blocks = document.querySelectorAll("div.result");

    for (const block of blocks) {
      if (out.length >= maxLimit) break;

      const anchor = block.querySelector(
        "a.result-title[href]",
      ) as HTMLAnchorElement | null;
      const url = anchor?.getAttribute("href") ?? "";
      if (!/^https?:\/\//i.test(url)) continue;

      const title = (
        block.querySelector("h2.wgl-title")?.textContent ??
        anchor?.textContent ??
        ""
      ).trim();
      if (!title) continue;

      out.push({
        title,
        url,
        snippet: block.querySelector("p.description")?.textContent ?? "",
        displayUrl: block.querySelector("a.wgl-display-url")?.textContent ?? "",
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

export class StartpageEngine implements SearchEngine {
  readonly id = "startpage";
  readonly name = "Startpage";

  async search(page: Page, request: EngineRequest): Promise<SearchResult[]> {
    await page.goto(buildSearchUrl(request.query), {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const results = await extractPageResults(page);
    return results.slice(0, request.limit);
  }
}
