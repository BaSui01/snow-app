/**
 * Yep 搜索引擎（Ahrefs 的独立索引）。
 *
 * 抓取 yep.com 的公开结果页，不依赖任何官方 API。
 *
 * DOM 契约（2026-10-27 实测）：
 *   - 每条结果位于 `article`（单页 10 条）
 *   - 标题链接为 `a[data-part="title"]`，href 即真实 URL（无跳转包装）
 *   - 摘要位于 `p[data-part="description"]`，展示 URL 位于 `span[data-part="visible-url"]`
 *   - data-part 属性稳定，不依赖构建哈希类名
 *
 * 该站未发现可用的翻页参数；语言与时间范围没有可靠映射，不生效。
 */

import type { Page } from "puppeteer-core";
import type { EngineRequest, SearchEngine, SearchResult } from "./types";
import { cleanText } from "./textUtils";

/** 单页结果条数（实测 10 条）。 */
const PAGE_SIZE = 10;

const buildSearchUrl = (query: string): string => {
  const params = new URLSearchParams({ q: query });
  return `https://yep.com/web?${params.toString()}`;
};

/** 从当前页面提取一页结果（最多 PAGE_SIZE 条）。 */
const extractPageResults = async (page: Page): Promise<SearchResult[]> => {
  try {
    await page.waitForSelector('a[data-part="title"]', { timeout: 6000 });
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
    const articles = document.querySelectorAll("article");

    for (const article of articles) {
      if (out.length >= maxLimit) break;

      const anchor = article.querySelector(
        'a[data-part="title"][href]',
      ) as HTMLAnchorElement | null;
      const url = anchor?.getAttribute("href") ?? "";
      if (!/^https?:\/\//i.test(url)) continue;

      const title = (anchor?.textContent ?? "").trim();
      if (!title) continue;

      out.push({
        title,
        url,
        snippet:
          article.querySelector('p[data-part="description"]')?.textContent ??
          "",
        displayUrl:
          article.querySelector('span[data-part="visible-url"]')?.textContent ??
          "",
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

export class YepEngine implements SearchEngine {
  readonly id = "yep";
  readonly name = "Yep";

  async search(page: Page, request: EngineRequest): Promise<SearchResult[]> {
    // Yep 由 Cloudflare 防护，首次访问可能返回安全验证页（403）；
    // 该页会下发 clearance cookie，因此再试一次通常即可通过。
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.goto(buildSearchUrl(request.query), {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      const results = await extractPageResults(page);
      if (results.length > 0 || attempt > 0) {
        return results.slice(0, request.limit);
      }
    }

    return [];
  }
}
