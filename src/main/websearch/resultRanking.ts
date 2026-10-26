/**
 * 搜索结果重排（纯算法，不调用任何模型）。
 *
 * 流水线：URL 规范化去重 -> 多维特征加权打分 -> 稳定排序。
 *
 * 特征与权重：
 *   relevance  0.45  query 词项在 title / snippet / url 的加权覆盖率
 *   authority  0.25  域名权威度（官方文档、代码托管、学术源加权；文档分享站降权）
 *   rankPrior  0.20  引擎原始排名先验 1 / (1 + 0.2 * position)
 *   siteMatch  0.10  显式 site 限定命中
 */

import type { SearchResult } from "./types";

/** 追踪参数：参与 URL 规范化去重时被剥离。 */
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "msclkid",
  "yclid",
  "spm",
  "scm",
  "ref",
  "ref_src",
  "from",
  "source",
  "share_token",
  "share_source",
  "share_medium",
]);

/** 英文停用词：避免噪声词抬高无关结果。 */
const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "how",
  "what",
  "why",
  "when",
  "where",
  "which",
  "that",
  "this",
  "from",
  "into",
  "about",
  "are",
  "was",
  "were",
  "you",
  "your",
  "can",
  "could",
  "should",
  "would",
  "does",
  "did",
  "not",
  "but",
  "its",
  "of",
  "in",
  "on",
  "at",
  "to",
  "is",
  "be",
  "or",
  "as",
  "by",
  "an",
  "a",
]);

/** 高权威域名（官方文档、代码托管、学术与标准组织、政府/教育域）。 */
const HIGH_AUTHORITY_HOSTS = [
  "gov",
  "edu",
  "mil",
  "gov.cn",
  "edu.cn",
  "ac.uk",
  "ac.jp",
  "go.jp",
  "edu.hk",
  "docs.rs",
  "readthedocs.io",
  "developer.mozilla.org",
  "docs.python.org",
  "nodejs.org",
  "rust-lang.org",
  "go.dev",
  "python.org",
  "kernel.org",
  "mozilla.org",
  "w3.org",
  "ietf.org",
  "rfc-editor.org",
  "man7.org",
  "unicode.org",
  "github.com",
  "gitlab.com",
  "stackoverflow.com",
  "stackexchange.com",
  "serverfault.com",
  "wikipedia.org",
  "arxiv.org",
  "nature.com",
  "science.org",
  "ieee.org",
  "acm.org",
  "springer.com",
  "sciencedirect.com",
  "microsoft.com",
  "apple.com",
  "google.com",
  "amazon.com",
  "cloudflare.com",
  "openai.com",
  "anthropic.com",
  "huggingface.co",
  "modelcontextprotocol.io",
  "npmjs.com",
  "pypi.org",
  "crates.io",
  "packagist.org",
];

/** 低权威域名（文档分享站、问答农场、资源聚合站）。 */
const LOW_AUTHORITY_HOSTS = [
  "pinterest.com",
  "quora.com",
  "slideshare.net",
  "scribd.com",
  "coursehero.com",
  "chegg.com",
  "brainly.com",
  "brainly.co",
  "answers.yahoo.com",
  "studocu.com",
  "docin.com",
  "doc88.com",
  "book118.com",
  "renrendoc.com",
  "wenku.baidu.com",
];

const AUTHORITY_HIGH = 1;
const AUTHORITY_DEFAULT = 0.5;
const AUTHORITY_LOW = 0.15;

/** 特征权重（合计 1）。 */
const WEIGHTS = {
  relevance: 0.4,
  engineCoverage: 0.2,
  authority: 0.2,
  rankPrior: 0.15,
  siteMatch: 0.05,
};

/** 位置先验衰减系数：score = 1 / (1 + k * rank)。 */
const RANK_PRIOR_DECAY = 0.2;

/** 标题 / 摘要 / URL 在相关性中的权重。 */
const FIELD_WEIGHTS = { title: 0.6, snippet: 0.3, url: 0.1 };

const LATIN_PATTERN = /[a-z0-9][a-z0-9+#._-]*/g;
const CJK_PATTERN =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/g;

/** 从查询词中提取匹配用词项：英文单词（去停用词）+ 中日韩 2-gram。 */
const extractQueryTerms = (query: string): string[] => {
  const terms = new Set<string>();

  for (const match of query.toLowerCase().matchAll(LATIN_PATTERN)) {
    const term = match[0];
    if (term.length < 2 || STOP_WORDS.has(term)) {
      continue;
    }
    terms.add(term);
  }

  for (const match of query.matchAll(CJK_PATTERN)) {
    const segment = match[0];
    if (segment.length === 1) {
      terms.add(segment);
      continue;
    }
    for (let index = 0; index < segment.length - 1; index++) {
      terms.add(segment.slice(index, index + 2));
    }
  }

  return [...terms];
};

/** 从 URL 提取主机名（小写、去 www.）；非法 URL 返回空串。 */
const extractHost = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** 规范化 URL：去 fragment、去追踪参数、主机小写、去尾部斜杠。 */
const normalizeUrl = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const url = new URL(trimmed);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");

    const kept: Array<[string, string]> = [];
    url.searchParams.forEach((value, key) => {
      if (!TRACKING_PARAMS.has(key.toLowerCase())) {
        kept.push([key, value]);
      }
    });
    kept.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

    url.search = "";
    for (const [key, value] of kept) {
      url.searchParams.append(key, value);
    }

    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.toString();
  } catch {
    return trimmed;
  }
};

/**
 * 按规范化 URL 去重，合并来源引擎并保留各引擎内的最好排名。
 * 多引擎命中同一 URL 时，engines 累积、rank 取最小值（保留首次出现的顺序）。
 */
export const dedupeSearchResults = (
  results: SearchResult[],
): SearchResult[] => {
  const seen = new Map<string, SearchResult>();

  for (const result of results) {
    const url = result.url.trim();
    const key = normalizeUrl(url);
    if (!key) {
      continue;
    }

    const existing = seen.get(key);
    if (existing) {
      existing.engines = [
        ...new Set([...(existing.engines ?? []), ...(result.engines ?? [])]),
      ];
      const ranks = [existing.rank, result.rank].filter(
        (rank): rank is number => typeof rank === "number",
      );
      existing.rank = ranks.length > 0 ? Math.min(...ranks) : undefined;
      continue;
    }

    const host = extractHost(url);
    seen.set(key, { ...result, url, domain: host || undefined });
  }

  return [...seen.values()];
};

const matchesHostList = (host: string, patterns: string[]): boolean =>
  patterns.some((pattern) => host === pattern || host.endsWith(`.${pattern}`));

const authorityScore = (host: string): number => {
  if (!host) {
    return AUTHORITY_DEFAULT;
  }
  if (matchesHostList(host, HIGH_AUTHORITY_HOSTS)) {
    return AUTHORITY_HIGH;
  }
  if (matchesHostList(host, LOW_AUTHORITY_HOSTS)) {
    return AUTHORITY_LOW;
  }
  return AUTHORITY_DEFAULT;
};

/** query 词项在标题 / 摘要 / URL 上的加权覆盖率（0-1）。 */
const relevanceScore = (result: SearchResult, terms: string[]): number => {
  if (terms.length === 0) {
    return AUTHORITY_DEFAULT;
  }

  const title = result.title.toLowerCase();
  const snippet = result.snippet.toLowerCase();
  const url = result.url.toLowerCase();

  let matched = 0;
  for (const term of terms) {
    if (title.includes(term)) {
      matched += FIELD_WEIGHTS.title;
    }
    if (snippet.includes(term)) {
      matched += FIELD_WEIGHTS.snippet;
    }
    if (url.includes(term)) {
      matched += FIELD_WEIGHTS.url;
    }
  }

  return matched / terms.length;
};

const siteMatchScore = (host: string, site: string | undefined): number =>
  site && (host === site || host.endsWith(`.${site}`)) ? 1 : 0;

/** 多引擎命中覆盖度：被越多独立索引命中越可信；单引擎时该特征无区分度。 */
const coverageScore = (result: SearchResult, engineCount: number): number => {
  if (engineCount <= 1) {
    return 1;
  }
  return Math.min(1, (result.engines?.length ?? 1) / engineCount);
};

export type RankInput = {
  query: string;
  site?: string;
  /** 本次参与检索的引擎数量，用于计算多引擎命中覆盖度。 */
  engineCount: number;
  results: SearchResult[];
};

/** 去重后按加权特征打分并稳定排序（同分保持引擎原始顺序）。 */
export const rankSearchResults = ({
  query,
  site,
  engineCount,
  results,
}: RankInput): SearchResult[] => {
  const deduped = dedupeSearchResults(results);
  const terms = extractQueryTerms(query);

  const scored = deduped.map((result, position) => {
    const host = result.domain ?? extractHost(result.url);
    const rank = result.rank ?? position;
    const score =
      WEIGHTS.relevance * relevanceScore(result, terms) +
      WEIGHTS.engineCoverage * coverageScore(result, engineCount) +
      WEIGHTS.authority * authorityScore(host) +
      WEIGHTS.rankPrior * (1 / (1 + RANK_PRIOR_DECAY * rank)) +
      WEIGHTS.siteMatch * siteMatchScore(host, site);

    return {
      result: {
        ...result,
        domain: host || undefined,
        score: Number(score.toFixed(4)),
      },
      position,
    };
  });

  scored.sort(
    (left, right) =>
      (right.result.score ?? 0) - (left.result.score ?? 0) ||
      left.position - right.position,
  );

  // 输出时剥离内部字段：来源引擎与引擎内排名只参与打分。
  return scored.map(({ result }) => ({
    title: result.title,
    url: result.url,
    snippet: result.snippet,
    displayUrl: result.displayUrl,
    ...(result.domain ? { domain: result.domain } : {}),
    score: result.score,
  }));
};
