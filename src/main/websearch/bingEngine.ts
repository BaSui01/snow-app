/**
 * Bing 搜索引擎。
 *
 * 抓取公开的 Bing 搜索页 DOM，不依赖任何官方 API。
 *
 * DOM 契约（2026 年验证）：
 *   - 每条自然结果位于 `li.b_algo`
 *   - 规范链接为 `.b_tpcn a.tilk`（优先）或 `h2 > a`
 *   - 摘要位于 `.b_caption p`（部分卡片直接放 `.b_caption` 文本）
 *   - 展示 URL 位于 `.b_attribution cite`（回退任意 `cite`）
 *
 * 该页面每页 10 条，翻页使用 `first` 参数（步长 10）。
 */

import type { Page } from "puppeteer-core";
import type { EngineRequest, SearchEngine, SearchResult } from "./types";
import { resolveLanguageProfile, resolveTimeFilter } from "./searchParams";
import { cleanText } from "./textUtils";

/** Bing 网页结果每页 10 条。 */
const PAGE_SIZE = 10;

/**
 * 构造 Bing 搜索 URL。
 *
 * `setlang` + `cc` 只是提示；未指定语言时保持英文/美国的默认行为。
 * `mkt` 在指定语言时统一语言与地区。
 * `filters` 承载时间范围过滤（Bing 网页端的 ex1 过滤表达式）；
 * 参数不被识别时 Bing 会忽略它，不影响结果返回。
 */
const buildSearchUrl = (
  query: string,
  first: number,
  language: ReturnType<typeof resolveLanguageProfile>,
  filters: string | undefined,
): string => {
  const params = new URLSearchParams({
    q: query,
    count: String(PAGE_SIZE),
    setlang: language?.bingLang ?? "en",
  });
  if (language) {
    params.set("mkt", language.bingMkt);
  } else {
    params.set("cc", "us");
  }
  if (first > 1) {
    params.set("first", String(first));
  }
  if (filters) {
    params.set("filters", filters);
  }
  return `https://www.bing.com/search?${params.toString()}`;
};

/** 从当前页面提取一页结果（最多 PAGE_SIZE 条）。 */
const extractPageResults = async (page: Page): Promise<SearchResult[]> => {
  // 等待结果容器。先试最具体的选择器，再回退。绝不抛错——空结果是合法结果。
  try {
    await page.waitForSelector("#b_results li.b_algo", { timeout: 10000 });
  } catch {
    try {
      await page.waitForSelector("#b_results", { timeout: 3000 });
    } catch {
      // 直接进入提取
    }
  }

  const results = await page.evaluate((maxLimit: number) => {
    type Partial = {
      title?: string;
      url?: string;
      snippet?: string;
      displayUrl?: string;
    };

    const out: Partial[] = [];
    const items = document.querySelectorAll("#b_results > li.b_algo");

    const isHttpUrl = (u: string): boolean => /^https?:\/\//i.test(u);

    for (const item of items) {
      if (out.length >= maxLimit) break;

      // 跳过可能共享 b_algo 类的广告项
      if (
        item.classList.contains("b_ad") ||
        item.querySelector(".b_adlabel, .b_ad_text")
      ) {
        continue;
      }

      // 优先 top-card 链接（.b_tpcn a.tilk），其 href 是规范目标 URL；
      // 回退 h2 > a。
      const tilkEl = item.querySelector(
        ".b_tpcn a.tilk",
      ) as HTMLAnchorElement | null;
      const headingEl = item.querySelector("h2 a") as HTMLAnchorElement | null;

      const linkEl = tilkEl ?? headingEl;
      if (!linkEl) continue;

      const url = linkEl.getAttribute("href") || "";
      if (!url || !isHttpUrl(url)) continue;

      // 标题来自 <h2>，缺失时回退 tilk 的 aria-label / 文本
      let title = headingEl?.textContent?.trim() || "";
      if (!title) {
        title =
          tilkEl?.getAttribute("aria-label")?.trim() ||
          tilkEl?.textContent?.trim() ||
          "";
      }
      if (!title) continue;

      // 摘要：按优先级尝试常见 Bing 布局
      let snippet = "";
      const snippetCandidates: Array<string> = [
        ".b_caption p.b_lineclamp2",
        ".b_caption p",
        ".b_richcard .b_caption",
        ".b_snippet",
        ".b_caption",
        ".b_paractl",
      ];
      for (const sel of snippetCandidates) {
        const el = item.querySelector(sel);
        const txt = el?.textContent?.trim();
        if (txt) {
          snippet = txt;
          break;
        }
      }

      // 展示 URL：优先 .b_attribution cite，回退任意 cite
      const citeEl =
        item.querySelector(".b_attribution cite") || item.querySelector("cite");
      const displayUrl = citeEl?.textContent?.trim() || "";

      out.push({ title, url, snippet, displayUrl });
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

export class BingEngine implements SearchEngine {
  readonly id = "bing";
  readonly name = "Bing";

  async search(page: Page, request: EngineRequest): Promise<SearchResult[]> {
    const language = resolveLanguageProfile(request.language);
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
        1 + index * PAGE_SIZE,
        language,
        timeFilter?.bingFilters,
      );

      try {
        // 用 domcontentloaded 而非 networkidle2：Bing 会持续加载埋点脚本，
        // networkidle2 经常超时导致空结果。
        await page.goto(searchUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
      } catch {
        // 导航超时——尝试提取已加载的内容
      }

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
