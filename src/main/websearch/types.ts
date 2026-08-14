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
};

export interface SearchEngine {
  readonly id: string;
  readonly name: string;
  search(page: import("puppeteer-core").Page, query: string, maxResults: number): Promise<SearchResult[]>;
}
