/**
 * Seznam 搜索引擎（捷克）。
 *
 * 抓取 search.seznam.cz 的公开结果页，不依赖任何官方 API。
 *
 * DOM 契约（2026-10-27 实测）：
 *   - 标题链接为 `a[data-e-a="heading"]`，href 即真实 URL（无跳转包装）
 *   - 展示 URL 位于同结果块内的 `a[data-e-a="reference"]`
 *   - 摘要位于结果块内含 `data-e-b-n` 属性的元素（并非每条结果都有）
 *   - 类名是构建哈希（会随发布变化），因此只依赖上述 data 属性
 *
 * 该站未发现可用的翻页参数（单页 10 条）；语言与时间范围没有可靠映射，不生效。
 */

import type { Page } from "puppeteer-core";
import type { EngineRequest, SearchEngine, SearchResult } from "./types";
import { cleanText } from "./textUtils";

/** 单页结果条数（实测 10 条）。 */
const PAGE_SIZE = 10;

const buildSearchUrl = (query: string): string => {
  const params = new URLSearchParams({ q: query });
  return `https://search.seznam.cz/?${params.toString()}`;
};

/** 从当前页面提取一页结果（最多 PAGE_SIZE 条）。 */
const extractPageResults = async (page: Page): Promise<SearchResult[]> => {
  try {
    await page.waitForSelector('a[data-e-a="heading"]', { timeout: 10000 });
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
    const anchors = document.querySelectorAll('a[data-e-a="heading"]');

    for (const anchor of anchors) {
      if (out.length >= maxLimit) break;

      const url = anchor.getAttribute("href") ?? "";
      if (!/^https?:\/\//i.test(url)) continue;

      const title = (anchor.textContent ?? "").trim();
      if (!title) continue;

      // 结果块：向上找到包含展示 URL 链接的最近容器。
      let block: Element = anchor;
      for (let depth = 0; depth < 4 && block.parentElement; depth++) {
        block = block.parentElement;
        if (block.querySelector('a[data-e-a="reference"]')) break;
      }

      out.push({
        title,
        url,
        snippet: block.querySelector("[data-e-b-n]")?.textContent ?? "",
        displayUrl:
          block.querySelector('a[data-e-a="reference"]')?.textContent ?? "",
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

export class SeznamEngine implements SearchEngine {
  readonly id = "seznam";
  readonly name = "Seznam";

  async search(page: Page, request: EngineRequest): Promise<SearchResult[]> {
    await page.goto(buildSearchUrl(request.query), {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const results = await extractPageResults(page);
    return results.slice(0, request.limit);
  }
}
