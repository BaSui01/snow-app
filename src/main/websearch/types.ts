/** Web search 模块类型定义（对齐 Snow CLI 的 websearch 类型）。 */

export type SearchResult = {
  title: string;
  url: string;
  snippet: string;
  displayUrl: string;
  /** 纯算法重排后的相关性得分（0-1，越高越相关）。 */
  score?: number;
  /** 结果所属域名（已去掉 www. 前缀）。 */
  domain?: string;
  /** 内部字段：命中该结果的搜索引擎 id，仅用于多引擎合并去重与重排。 */
  engines?: string[];
  /** 内部字段：结果在其来源引擎中的原始排名（从 0 开始）。 */
  rank?: number;
};

/** 时间范围过滤（由各引擎映射到自己的 URL 参数）。 */
export type SearchTimeRange = "day" | "week" | "month" | "year";

/** 搜索请求的原始选项：来自工具参数，尚未校验，由 service 内部规范化。 */
export type SearchOptions = {
  maxResults?: number;
  /** 限定单个域名（如 "docs.python.org"），会拼成 site: 操作符。 */
  site?: string;
  /** 时间范围过滤，取值为 SearchTimeRange。 */
  timeRange?: string;
  /** 语言/区域提示（如 "zh-CN"、"en-US"），由引擎映射到各自参数。 */
  language?: string;
  /** 指定本次使用的搜索引擎 id 列表（如 ["brave", "bing"]）；缺省使用设置中勾选的引擎。 */
  engineIds?: string[];
};

/** 引擎执行一次搜索所需的完整请求描述。 */
export type EngineRequest = {
  /** 已包含 site: 限定等修饰的最终查询词。 */
  query: string;
  /** 需要返回的结果条数（引擎按自身单页容量分页抓取）。 */
  limit: number;
  /** 规范化后的语言标识（如 "zh-CN"）。 */
  language?: string;
  /** 时间范围过滤。 */
  timeRange?: SearchTimeRange;
};

export type SearchResponse = {
  query: string;
  /** 本次实际参与的搜索引擎 id 列表（多引擎混合检索）。 */
  engines: string[];
  /** 本次实际参与的搜索引擎展示名列表（与 engines 一一对应）。 */
  engineNames: string[];
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
  search(
    page: import("puppeteer-core").Page,
    request: EngineRequest,
  ): Promise<SearchResult[]>;
}
