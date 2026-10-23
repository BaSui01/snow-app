import { useMemo } from "react";
import {
  AlertCircle,
  CheckCircle,
  FileCode,
  Filter,
  Info,
  Loader2,
  Search,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";
import { localizeToolError } from "./shared/toolErrorDisplay";

type FindToolCallProps = {
  toolCall: ToolCallInfo;
};

type ParsedFindArgs = {
  pattern: string;
  /** 释义：模型用用户语言写的查找意图说明，替代原始 glob 展示给用户。 */
  description?: string;
  path?: string;
  maxResults?: number;
  /** 无损全量：包含默认跳过的重目录与 .gitignore 文件。 */
  searchAll?: boolean;
};

type ParsedFindResult =
  | {
      type: "success";
      backend: string;
      files: string[];
      totalMatches: number;
      truncated: boolean;
    }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 流式未闭合 JSON 兜底提前提取描述或 glob */
const extractStreamingFind = (
  args: string,
): { description?: string; pattern?: string } => {
  if (!args) return {};
  const descMatch = args.match(/"description"\s*:\s*"([^"]+)"/);
  const patMatch = args.match(/"pattern"\s*:\s*"([^"]+)"/);
  return {
    description: descMatch ? descMatch[1] : undefined,
    pattern: patMatch ? patMatch[1] : undefined,
  };
};

const parseArgs = (args: string): ParsedFindArgs | null => {
  try {
    const parsed: unknown = JSON.parse(args);
    if (!isRecord(parsed) || typeof parsed.pattern !== "string") {
      return null;
    }

    const result: ParsedFindArgs = { pattern: parsed.pattern };

    if (typeof parsed.description === "string" && parsed.description.trim()) {
      result.description = parsed.description;
    }
    if (typeof parsed.path === "string") {
      result.path = parsed.path;
    }
    if (typeof parsed.maxResults === "number") {
      result.maxResults = parsed.maxResults;
    }
    if (typeof parsed.searchAll === "boolean") {
      result.searchAll = parsed.searchAll;
    }

    return result;
  } catch {
    return null;
  }
};

const parseResult = (result: string | undefined): ParsedFindResult => {
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

    if (Array.isArray(parsed.files)) {
      const files = parsed.files.filter(
        (file): file is string => typeof file === "string",
      );

      return {
        type: "success",
        backend:
          typeof parsed.backend === "string" ? parsed.backend : "unknown",
        files,
        totalMatches:
          typeof parsed.totalMatches === "number"
            ? parsed.totalMatches
            : files.length,
        truncated: parsed.truncated === true,
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

const getFileName = (filePath: string): string =>
  filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;

export const FindToolCall = ({
  toolCall,
}: FindToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const parsedArgs = useMemo(
    () => parseArgs(toolCall.arguments),
    [toolCall.arguments],
  );
  const parsedResult = useMemo(
    () => parseResult(toolCall.result),
    [toolCall.result],
  );

  const isRunning = toolCall.status === "running";

  const streamingFind = useMemo(
    () => (parsedArgs ? undefined : extractStreamingFind(toolCall.arguments)),
    [parsedArgs, toolCall.arguments],
  );
  const pattern = parsedArgs?.pattern ?? streamingFind?.pattern ?? "find";
  const searchPath = parsedArgs?.path ?? ".";
  const description = parsedArgs?.description ?? streamingFind?.description;
  const hasError = parsedResult.type === "error";
  const effectiveStatus = hasError ? "error" : toolCall.status;

  const files = parsedResult.type === "success" ? parsedResult.files : [];
  const fileCount =
    parsedResult.type === "success" ? parsedResult.totalMatches : files.length;

  return (
    <ToolCallNode
      toolName={toolCall.name}
      badgeName={t("toolCall.find.name")}
      category="search"
      displayName={
        description ??
        (pattern.length > 60 ? `${pattern.slice(0, 60)}...` : pattern)
      }
      displayNameTitle={description ? pattern : undefined}
      status={effectiveStatus}
      meta={
        parsedResult.type === "success" ? (
          <span
            className={`tool-call-grep-match-count ${
              fileCount > 0
                ? "tool-call-grep-has-matches"
                : "tool-call-grep-no-matches"
            }`}
          >
            {t("toolCall.find.fileCount", { values: { count: fileCount } })}
          </span>
        ) : null
      }
      className="tool-call-grep"
    >
      <div className="tool-call-body tool-call-grep-body">
        {parsedArgs?.description ? (
          <div className="tool-call-grep-description">
            <Info size={11} aria-hidden="true" />
            <span className="tool-call-grep-param-label">
              {t("toolCall.find.description")}
            </span>
            <span className="tool-call-grep-description-text">
              {parsedArgs.description}
            </span>
          </div>
        ) : null}

        {parsedArgs ? (
          <div className="tool-call-grep-params">
            <div className="tool-call-grep-param-item">
              <Search size={11} aria-hidden="true" />
              <span className="tool-call-grep-param-label">
                {t("toolCall.find.pattern")}
              </span>
              <code className="tool-call-grep-param-value">{pattern}</code>
            </div>

            <div className="tool-call-grep-param-item">
              <Filter size={11} aria-hidden="true" />
              <span className="tool-call-grep-param-label">
                {t("toolCall.find.path")}
              </span>
              <span className="tool-call-grep-param-value">{searchPath}</span>
            </div>

            {parsedArgs.maxResults !== undefined || parsedArgs.searchAll ? (
              <div className="tool-call-grep-param-meta">
                {parsedArgs.maxResults !== undefined ? (
                  <span className="tool-call-grep-param-tag">
                    {t("toolCall.find.maxResults")}: {parsedArgs.maxResults}
                  </span>
                ) : null}
                {parsedArgs.searchAll ? (
                  <span className="tool-call-grep-param-tag">
                    {t("toolCall.find.searchAll")}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {parsedResult.type === "success" ? (
          <div className="tool-call-grep-backend">
            <CheckCircle size={11} aria-hidden="true" />
            <span>
              {t("toolCall.find.backend")}: {parsedResult.backend}
            </span>
            {parsedResult.truncated ? (
              <span className="tool-call-grep-truncated">
                {t("toolCall.find.truncated")}
              </span>
            ) : null}
          </div>
        ) : null}

        {hasError ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{localizeToolError(t, parsedResult.message)}</span>
          </div>
        ) : null}

        {files.length > 0 ? (
          <div className="tool-call-grep-results">
            {files.map((filePath, index) => (
              <div
                key={`${filePath}-${index}`}
                className="tool-call-grep-file-group"
              >
                <div
                  className="tool-call-grep-file-header"
                  title={filePath}
                  data-path={filePath}
                >
                  <FileCode size={12} aria-hidden="true" />
                  <span
                    className="tool-call-grep-file-name"
                    data-path={filePath}
                  >
                    {getFileName(filePath)}
                  </span>
                  <span
                    className="tool-call-grep-file-path"
                    data-path={filePath}
                  >
                    {filePath}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {parsedResult.type === "success" && files.length === 0 ? (
          <div className="tool-call-grep-no-results">
            <Search size={14} aria-hidden="true" />
            <span>{t("toolCall.find.noFiles")}</span>
          </div>
        ) : null}

        {parsedResult.type === "raw" ? (
          <section className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.find.result")}
            </span>
            <pre className="tool-call-section-pre">{parsedResult.text}</pre>
          </section>
        ) : null}

        {parsedResult.type === "empty" ? (
          <div
            className={`tool-call-grep-pending ${
              isRunning ? "tool-call-grep-pending-running" : ""
            }`}
          >
            {isRunning ? (
              <Loader2
                className="tool-call-icon-spinning"
                size={14}
                aria-hidden="true"
              />
            ) : (
              <Search size={14} aria-hidden="true" />
            )}
            <span>
              {isRunning
                ? t("toolCall.find.running")
                : t("toolCall.find.waiting")}
            </span>
          </div>
        ) : null}
      </div>
    </ToolCallNode>
  );
};
