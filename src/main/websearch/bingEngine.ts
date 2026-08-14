/**
 * Bing 搜索引擎（照搬 Snow CLI 的 bing.engine.ts）。
 *
 * 抓取公开的 Bing 搜索页 DOM，不依赖任何官方 API。
 *
 * DOM 契约（2026 年验证）：
 *   - 每条自然结果位于 `li.b_algo`
 *   - 规范链接为 `.b_tpcn a.tilk`（优先）或 `h2 > a`
 *   - 摘要位于 `.b_caption p`（部分卡片直接放 `.b_caption` 文本）
 *   - 展示 URL 位于 `.b_attribution cite`（回退任意 `cite`）
 */

import type { Page } from "puppeteer-core";
import type { SearchEngine, SearchResult } from "./types";
import { cleanText } from "./textUtils";

export class BingEngine implements SearchEngine {
  readonly id = "bing";
  readonly name = "Bing";

  async search(
    page: Page,
    query: string,
    maxResults: number
  ): Promise<SearchResult[]> {
    const encodedQuery = encodeURIComponent(query);
    // `setlang=en` + `cc=us` 只是提示；Bing 仍可能把国内客户端重定向到
    // cn.bing.com，但两种布局的 DOM 契约一致，不影响解析。
    const searchUrl =
      `https://www.bing.com/search?q=${encodedQuery}` +
      `&count=${Math.max(maxResults, 10)}&setlang=en&cc=us`;

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
          ".b_tpcn a.tilk"
        ) as HTMLAnchorElement | null;
        const headingEl = item.querySelector(
          "h2 a"
        ) as HTMLAnchorElement | null;

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
          item.querySelector(".b_attribution cite") ||
          item.querySelector("cite");
        const displayUrl = citeEl?.textContent?.trim() || "";

        out.push({ title, url, snippet, displayUrl });
      }

      return out;
    }, maxResults);

    return results.map((r) => ({
      title: cleanText(r.title || ""),
      url: r.url || "",
      snippet: cleanText(r.snippet || ""),
      displayUrl: cleanText(r.displayUrl || ""),
    }));
  }
}
