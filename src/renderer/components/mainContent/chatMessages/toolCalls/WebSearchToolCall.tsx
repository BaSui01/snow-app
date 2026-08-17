import { useMemo } from "react";
import {
  AlertCircle,
  Ban,
  ExternalLink,
  FileText,
  Globe,
  Image as ImageIcon,
  Link2,
  Loader2,
  Search,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import { rightPanelEvents } from "../../../rightPanel/rightPanelEvents";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";

type WebSearchToolCallProps = {
  toolCall: ToolCallInfo;
};

type ParsedSearchArgs = {
  query: string;
  maxResults?: number;
};

type ParsedFetchArgs = {
  url: string;
  maxLength?: number;
};

type SearchResultItem = {
  title: string;
  url: string;
  snippet: string;
  displayUrl: string;
};

type ParsedSearchResult =
  | {
      type: "success";
      query: string;
      results: SearchResultItem[];
      totalResults: number;
      blockedCount?: number;
      blockedResults?: SearchResultItem[];
      blockedPatterns?: string[];
      blockNote?: string;
    }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

type FetchedImage = {
  data: string;
  mimeType: string;
};

type ParsedFetchResult =
  | {
      type: "success";
      url: string;
      title: string;
      content: string;
      textLength: number;
      contentPreview: string;
      image: FetchedImage | null;
      truncated: boolean;
    }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseSearchArgs = (args: string): ParsedSearchArgs | null => {
  try {
    const parsed: unknown = JSON.parse(args);
    if (
      !isRecord(parsed) ||
      typeof parsed.query !== "string" ||
      parsed.query.trim() === ""
    ) {
      return null;
    }

    const result: ParsedSearchArgs = { query: parsed.query };
    if (typeof parsed.maxResults === "number") {
      result.maxResults = parsed.maxResults;
    }
    return result;
  } catch {
    return null;
  }
};

const parseFetchArgs = (args: string): ParsedFetchArgs | null => {
  try {
    const parsed: unknown = JSON.parse(args);
    if (
      !isRecord(parsed) ||
      typeof parsed.url !== "string" ||
      parsed.url.trim() === ""
    ) {
      return null;
    }

    const result: ParsedFetchArgs = { url: parsed.url };
    if (typeof parsed.maxLength === "number") {
      result.maxLength = parsed.maxLength;
    }
    return result;
  } catch {
    return null;
  }
};

const parseSearchResult = (result: string | undefined): ParsedSearchResult => {
  if (!result) {
    return { type: "empty" };
  }

  try {
    const parsed: unknown = JSON.parse(result);
    if (!isRecord(parsed)) {
      return { type: "raw", text: result };
    }
    if (typeof parsed.error === "string") {
      return { type: "error", message: parsed.error };
    }

    if (Array.isArray(parsed.results)) {
      const results: SearchResultItem[] = parsed.results
        .filter(isRecord)
        .filter((r) => typeof r.title === "string" && typeof r.url === "string")
        .map((r) => ({
          title: r.title as string,
          url: r.url as string,
          snippet: typeof r.snippet === "string" ? (r.snippet as string) : "",
          displayUrl:
            typeof r.displayUrl === "string" ? (r.displayUrl as string) : "",
        }));

return {
        type: "success",
        query: typeof parsed.query === "string" ? parsed.query : "",
        results,
        totalResults:
          typeof parsed.totalResults === "number"
            ? parsed.totalResults
            : results.length,
        blockedCount:
          typeof parsed.blockedCount === "number" ? parsed.blockedCount : 0,
        blockedResults: Array.isArray(parsed.blockedResults)
          ? parsed.blockedResults
              .filter(isRecord)
              .filter(
                (r) => typeof r.title === "string" && typeof r.url === "string"
              )
              .map((r) => ({
                title: r.title as string,
                url: r.url as string,
                snippet:
                  typeof r.snippet === "string" ? (r.snippet as string) : "",
                displayUrl:
                  typeof r.displayUrl === "string"
                    ? (r.displayUrl as string)
                    : "",
              }))
          : undefined,
        blockedPatterns: Array.isArray(parsed.blockedPatterns)
          ? parsed.blockedPatterns.filter(
              (p): p is string => typeof p === "string"
            )
          : undefined,
        blockNote:
          typeof parsed.blockNote === "string" ? parsed.blockNote : undefined,
      };
    }

    if (typeof parsed.message === "string") {
      return { type: "error", message: parsed.message };
    }
    return { type: "raw", text: result };
  } catch {
    return { type: "raw", text: result };
  }
};

const TRUNCATION_MARKER = "[Content truncated...]";

const parseFetchResult = (result: string | undefined): ParsedFetchResult => {
  if (!result) {
    return { type: "empty" };
  }

  try {
    const parsed: unknown = JSON.parse(result);
    if (!isRecord(parsed)) {
      return { type: "raw", text: result };
    }
    if (typeof parsed.error === "string") {
      return { type: "error", message: parsed.error };
    }
    if (typeof parsed.url !== "string") {
      return { type: "raw", text: result };
    }

    // HTML 抓取返回字符串正文；图片抓取返回 [{text}, {image}] 内容块数组。
    let content = "";
    let image: FetchedImage | null = null;
    if (typeof parsed.content === "string") {
      content = parsed.content;
    } else if (Array.isArray(parsed.content)) {
      for (const block of parsed.content) {
        if (!isRecord(block)) {
          continue;
        }
        if (block.type === "text" && typeof block.text === "string") {
          content = content ? `${content}\n${block.text}` : block.text;
        } else if (
          block.type === "image" &&
          typeof block.data === "string" &&
          typeof block.mimeType === "string"
        ) {
          image = { data: block.data as string, mimeType: block.mimeType as string };
        }
      }
    }

    return {
      type: "success",
      url: parsed.url,
      title: typeof parsed.title === "string" ? parsed.title : "",
      content,
      textLength:
        typeof parsed.textLength === "number"
          ? parsed.textLength
          : content.length,
      contentPreview:
        typeof parsed.contentPreview === "string" ? parsed.contentPreview : "",
      image,
      truncated: content.includes(TRUNCATION_MARKER),
    };
  } catch {
    return { type: "raw", text: result };
  }
};

const getHost = (url: string): string => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

const truncateLabel = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max)}...` : value;

/** 在右侧面板的应用内浏览器中新建 tab 打开（渲染进程事件总线，RightPanel 订阅处理）。 */
const openInAppBrowser = (url: string): void => {
  rightPanelEvents.emit("open-browser-tab", { url });
};

/** 在系统浏览器中打开（主进程 setWindowOpenHandler 转交 shell.openExternal）。 */
const openExternalLink = (url: string): void => {
  window.open(url, "_blank");
};

const SearchToolCall = ({
  toolCall,
}: {
  toolCall: ToolCallInfo;
}): React.JSX.Element => {
  const { t } = useI18n();
  const parsedArgs = useMemo(
    () => parseSearchArgs(toolCall.arguments),
    [toolCall.arguments]
  );
  const parsedResult = useMemo(
    () => parseSearchResult(toolCall.result),
    [toolCall.result]
  );

  const isRunning = toolCall.status === "running";
  const query = parsedArgs?.query ?? "";
  const hasError = parsedResult.type === "error";
  const effectiveStatus = hasError ? "error" : toolCall.status;

  const resultCount =
    parsedResult.type === "success" ? parsedResult.totalResults : 0;
  const hasResults =
    parsedResult.type === "success" && parsedResult.results.length > 0;

  return (
    <ToolCallNode
      toolName={toolCall.name}
      badgeName={t("toolCall.websearch.searchName")}
      category="web"
      displayName={query ? truncateLabel(query, 60) : undefined}
      displayNameTitle={query || undefined}
      status={effectiveStatus}
      meta={
        parsedResult.type === "success" ? (
          <span className="tool-call-websearch-meta-group">
            {parsedResult.blockedCount && parsedResult.blockedCount > 0 ? (
              <span className="tool-call-websearch-count tool-call-websearch-count-blocked">
                {t("toolCall.websearch.blockedCount", {
                  values: { count: parsedResult.blockedCount },
                })}
              </span>
            ) : null}
            <span
              className={`tool-call-websearch-count ${
                hasResults ? "tool-call-websearch-count-active" : ""
              }`}
            >
              {t("toolCall.websearch.resultCount", {
                values: { count: resultCount },
              })}
            </span>
          </span>
        ) : null
      }
      className="tool-call-websearch"
    >
      <div className="tool-call-body tool-call-websearch-body">
        {/* 搜索参数 */}
        {parsedArgs ? (
          <div className="tool-call-websearch-params">
            <div className="tool-call-websearch-param-item">
              <Search size={11} aria-hidden="true" />
              <span className="tool-call-websearch-param-label">
                {t("toolCall.websearch.query")}
              </span>
              <code className="tool-call-websearch-param-value">
                {parsedArgs.query}
              </code>
            </div>

            {parsedArgs.maxResults !== undefined ? (
              <div className="tool-call-websearch-param-tags">
                <span className="tool-call-websearch-param-tag">
                  {t("toolCall.websearch.maxResults")}: {parsedArgs.maxResults}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* 错误 */}
        {parsedResult.type === "error" ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{parsedResult.message}</span>
          </div>
        ) : null}

        {/* 搜索结果列表 */}
        {parsedResult.type === "success" && hasResults ? (
          <div className="tool-call-websearch-results">
            {parsedResult.results.map((item, index) => (
              <article
                key={`${item.url}-${index}`}
                className="tool-call-websearch-result"
              >
                <div className="tool-call-websearch-result-head">
                  <span
                    className="tool-call-websearch-result-index"
                    aria-hidden="true"
                  >
                    {index + 1}
                  </span>
                  <button
                    type="button"
                    className="tool-call-websearch-result-title"
                    onClick={() => openInAppBrowser(item.url)}
                    title={`${item.url}\n${t("toolCall.websearch.openInBrowser")}`}
                  >
                    <span className="tool-call-websearch-result-title-text">
                      {item.title}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="tool-call-websearch-external"
                    onClick={() => openExternalLink(item.url)}
                    title={t("toolCall.websearch.openExternal")}
                    aria-label={t("toolCall.websearch.openExternal")}
                  >
                    <ExternalLink size={11} aria-hidden="true" />
                  </button>
                </div>
                {item.displayUrl ? (
                  <div className="tool-call-websearch-result-url">
                    <Globe size={10} aria-hidden="true" />
                    <span>{item.displayUrl}</span>
                  </div>
                ) : null}
                {item.snippet ? (
                  <p className="tool-call-websearch-result-snippet">
                    {item.snippet}
                  </p>
                ) : null}
              </article>
            ))}
          </div>
        ) : null}

{/* 无结果 */}
        {parsedResult.type === "success" && !hasResults ? (
          <div className="tool-call-websearch-empty">
            <Search size={14} aria-hidden="true" />
            <span>{t("toolCall.websearch.noResults")}</span>
          </div>
        ) : null}

        {/* 被屏蔽结果明细（屏蔽比例 >= 50% 时由主进程回传） */}
        {parsedResult.type === "success" &&
        parsedResult.blockedResults &&
        parsedResult.blockedResults.length > 0 ? (
          <details className="tool-call-websearch-blocked">
            <summary>
              <Ban size={11} aria-hidden="true" />
              <span>
                {t("toolCall.websearch.blockedResultsTitle", {
                  values: { count: parsedResult.blockedResults.length },
                })}
              </span>
            </summary>
            {parsedResult.blockedPatterns &&
            parsedResult.blockedPatterns.length > 0 ? (
              <div className="tool-call-websearch-blocked-rules">
                {parsedResult.blockedPatterns.map((pattern) => (
                  <code key={pattern}>{pattern}</code>
                ))}
              </div>
            ) : null}
            <ul className="tool-call-websearch-blocked-list">
              {parsedResult.blockedResults.map((item, index) => (
                <li key={`${item.url}-${index}`}>
                  <span className="tool-call-websearch-blocked-index">
                    {index + 1}
                  </span>
                  <span className="tool-call-websearch-blocked-title">
                    {item.title}
                  </span>
                  <span className="tool-call-websearch-blocked-url">
                    {item.displayUrl || getHost(item.url)}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}

        {/* 原始结果兜底 */}
        {parsedResult.type === "raw" ? (
          <section className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.websearch.result")}
            </span>
            <pre className="tool-call-section-pre">{parsedResult.text}</pre>
          </section>
        ) : null}

        {/* 等待 / 执行中 */}
        {parsedResult.type === "empty" ? (
          <div
            className={`tool-call-websearch-pending ${
              isRunning ? "tool-call-websearch-pending-running" : ""
            }`}
          >
            {isRunning ? (
              <Loader2
                className="tool-call-icon-spinning"
                size={14}
                aria-hidden="true"
              />
            ) : (
              <Globe size={14} aria-hidden="true" />
            )}
            <span>
              {isRunning
                ? t("toolCall.websearch.searching")
                : t("toolCall.websearch.waitingSearch")}
            </span>
          </div>
        ) : null}
      </div>
    </ToolCallNode>
  );
};

const FetchToolCall = ({
  toolCall,
}: {
  toolCall: ToolCallInfo;
}): React.JSX.Element => {
  const { t } = useI18n();
  const parsedArgs = useMemo(
    () => parseFetchArgs(toolCall.arguments),
    [toolCall.arguments]
  );
  const parsedResult = useMemo(
    () => parseFetchResult(toolCall.result),
    [toolCall.result]
  );

  const isRunning = toolCall.status === "running";
  const hasError = parsedResult.type === "error";
  const effectiveStatus = hasError ? "error" : toolCall.status;

  const targetUrl =
    (parsedResult.type === "success" ? parsedResult.url : "") ||
    parsedArgs?.url ||
    "";
  const host = targetUrl ? getHost(targetUrl) : "";

  const isImageResult =
    parsedResult.type === "success" && parsedResult.image !== null;

  return (
    <ToolCallNode
      toolName={toolCall.name}
      badgeName={t("toolCall.websearch.fetchName")}
      category="web"
      displayName={host ? truncateLabel(host, 60) : undefined}
      displayNameTitle={targetUrl || undefined}
      status={effectiveStatus}
      meta={
        parsedResult.type === "success" ? (
          isImageResult ? (
            <span className="tool-call-websearch-count tool-call-websearch-count-image">
              <ImageIcon size={10} aria-hidden="true" />
              {t("toolCall.websearch.image")}
            </span>
          ) : (
            <span className="tool-call-websearch-count tool-call-websearch-count-active">
              {t("toolCall.websearch.charCount", {
                values: { count: parsedResult.textLength.toLocaleString() },
              })}
            </span>
          )
        ) : null
      }
      className="tool-call-websearch"
    >
      <div className="tool-call-body tool-call-websearch-body">
        {/* 抓取参数 */}
        {parsedArgs ? (
          <div className="tool-call-websearch-params">
            <div className="tool-call-websearch-param-item">
              <Link2 size={11} aria-hidden="true" />
              <span className="tool-call-websearch-param-label">
                {t("toolCall.websearch.url")}
              </span>
              <span className="tool-call-websearch-param-value">
                {parsedArgs.url}
              </span>
            </div>

            {parsedArgs.maxLength !== undefined ? (
              <div className="tool-call-websearch-param-tags">
                <span className="tool-call-websearch-param-tag">
                  {t("toolCall.websearch.maxLength")}:{" "}
                  {parsedArgs.maxLength.toLocaleString()}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* 错误 */}
        {parsedResult.type === "error" ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{parsedResult.message}</span>
          </div>
        ) : null}

        {/* 抓取成功：页面信息 + 正文 / 图片 */}
        {parsedResult.type === "success" ? (
          <>
            <div className="tool-call-websearch-page">
              <div className="tool-call-websearch-page-title">
                {isImageResult ? (
                  <ImageIcon size={13} aria-hidden="true" />
                ) : (
                  <FileText size={13} aria-hidden="true" />
                )}
                <span
                  className="tool-call-websearch-page-title-text"
                  title={parsedResult.title || undefined}
                >
                  {parsedResult.title || host}
                </span>
              </div>
              <div className="tool-call-websearch-page-link-row">
                <button
                  type="button"
                  className="tool-call-websearch-page-link"
                  onClick={() => openInAppBrowser(parsedResult.url)}
                  title={`${parsedResult.url}\n${t("toolCall.websearch.openInBrowser")}`}
                >
                  <Globe size={10} aria-hidden="true" />
                  <span>{getHost(parsedResult.url)}</span>
                </button>
                <button
                  type="button"
                  className="tool-call-websearch-external"
                  onClick={() => openExternalLink(parsedResult.url)}
                  title={t("toolCall.websearch.openExternal")}
                  aria-label={t("toolCall.websearch.openExternal")}
                >
                  <ExternalLink size={10} aria-hidden="true" />
                </button>
              </div>
            </div>

            {parsedResult.image ? (
              <div className="tool-call-websearch-image">
                <img
                  src={`data:${parsedResult.image.mimeType};base64,${parsedResult.image.data}`}
                  alt={parsedResult.title || host}
                />
              </div>
            ) : null}

            {!isImageResult && parsedResult.contentPreview ? (
              <div className="tool-call-websearch-preview-wrap">
                <span className="tool-call-websearch-section-label">
                  {t("toolCall.websearch.preview")}
                </span>
                <pre className="tool-call-websearch-preview">
                  {parsedResult.contentPreview}
                </pre>
              </div>
            ) : null}

            {!isImageResult && parsedResult.content ? (
              <details className="tool-call-websearch-full">
                <summary>
                  {t("toolCall.websearch.fullContent")}
                  {parsedResult.truncated ? (
                    <span className="tool-call-websearch-truncated">
                      {t("toolCall.websearch.truncated")}
                    </span>
                  ) : null}
                </summary>
                <pre className="tool-call-section-pre">
                  {parsedResult.content}
                </pre>
              </details>
            ) : null}
          </>
        ) : null}

        {/* 原始结果兜底 */}
        {parsedResult.type === "raw" ? (
          <section className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.websearch.result")}
            </span>
            <pre className="tool-call-section-pre">{parsedResult.text}</pre>
          </section>
        ) : null}

        {/* 等待 / 执行中 */}
        {parsedResult.type === "empty" ? (
          <div
            className={`tool-call-websearch-pending ${
              isRunning ? "tool-call-websearch-pending-running" : ""
            }`}
          >
            {isRunning ? (
              <Loader2
                className="tool-call-icon-spinning"
                size={14}
                aria-hidden="true"
              />
            ) : (
              <Globe size={14} aria-hidden="true" />
            )}
            <span>
              {isRunning
                ? t("toolCall.websearch.fetching")
                : t("toolCall.websearch.waitingFetch")}
            </span>
          </div>
        ) : null}
      </div>
    </ToolCallNode>
  );
};

export const WebSearchToolCall = ({
  toolCall,
}: WebSearchToolCallProps): React.JSX.Element => {
  if (toolCall.name === "websearch-websearch-fetch") {
    return <FetchToolCall toolCall={toolCall} />;
  }
  return <SearchToolCall toolCall={toolCall} />;
};
