/** Web search 模块类型定义（对齐 Snow CLI 的 websearch 类型）。 */

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  displayUrl: string;
};

export type SearchResponse = {
  query: string;
  results: SearchResult[];
  totalResults: number;
  /** 被屏蔽规则过滤掉的结果数量。 */
  blockedCount?: number;
  /** 屏蔽比例达到阈值时回传的被屏蔽结果明细。 */
  blockedResults?: SearchResult[];
  /** 触发屏蔽的规则（正则字符串）。 */
  blockedPatterns?: string[];
  /** 给 AI 的屏蔽说明，解释为何返回了被屏蔽明细。 */
  blockNote?: string;
};

export interface SearchEngine {
  readonly id: string;
  readonly name: string;
  search(page: import("puppeteer-core").Page, query: string, maxResults: number): Promise<SearchResult[]>;
}
