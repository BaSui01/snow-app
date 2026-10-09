import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  Copy,
  Image as ImageIcon,
  Loader2,
  ScanSearch,
  Sparkles,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { isRecord, truncateLabel } from "./imagegenUtils";
import { ToolCallNode } from "./shared/ToolCallNode";
import { localizeToolError } from "./shared/toolErrorDisplay";

type ImageDescribeToolCallProps = {
  toolCall: ToolCallInfo;
};

type ParsedDescribeArgs = {
  path: string;
  prompt?: string;
};

type ParsedDescribeResult =
  | { type: "success"; description: string }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

const describeImageCache = new Map<string, string>();

const parseDescribeArgs = (args: string): ParsedDescribeArgs | null => {
  try {
    const parsed: unknown = JSON.parse(args);
    if (
      !isRecord(parsed) ||
      typeof parsed.path !== "string" ||
      parsed.path.trim() === ""
    ) {
      return null;
    }
    const result: ParsedDescribeArgs = { path: parsed.path.trim() };
    if (typeof parsed.prompt === "string" && parsed.prompt.trim() !== "") {
      result.prompt = parsed.prompt.trim();
    }
    return result;
  } catch {
    return null;
  }
};

const parseDescribeResult = (
  result: string | undefined,
): ParsedDescribeResult => {
  if (!result) {
    return { type: "empty" };
  }
  try {
    const parsed: unknown = JSON.parse(result);
    if (!isRecord(parsed)) {
      return { type: "raw", text: result };
    }
    if (
      typeof parsed.description === "string" &&
      parsed.description.trim() !== ""
    ) {
      return { type: "success", description: parsed.description.trim() };
    }
    if (typeof parsed.error === "string") {
      return {
        type: "error",
        message:
          typeof parsed.message === "string" && parsed.message.trim() !== ""
            ? parsed.message
            : parsed.error,
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

const fileNameOf = (path: string): string =>
  path.split(/[\\/]/).filter(Boolean).pop() ?? path;

export const ImageDescribeToolCall = ({
  toolCall,
}: ImageDescribeToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const parsedArgs = useMemo(
    () => parseDescribeArgs(toolCall.arguments),
    [toolCall.arguments],
  );
  const parsedResult = useMemo(
    () => parseDescribeResult(toolCall.result),
    [toolCall.result],
  );

  const path = parsedArgs?.path ?? "";
  const isRunning = toolCall.status === "running";
  const isFailed = toolCall.status === "error";
  const effectiveStatus =
    isFailed || parsedResult.type === "error" ? "error" : toolCall.status;

  const [thumbSrc, setThumbSrc] = useState("");

  useEffect(() => {
    if (!path) {
      return;
    }
    const cached = describeImageCache.get(path);
    if (cached !== undefined) {
      setThumbSrc(cached);
      return;
    }
    let cancelled = false;
    void (async () => {
      let dataUrl: string | null = null;
      try {
        dataUrl = await window.snow.resolveUploadImage(path);
      } catch (error) {
        console.warn("[imagegen] resolveUploadImage failed for", path, error);
      }
      if (cancelled) {
        return;
      }
      const src = dataUrl ?? "";
      describeImageCache.set(path, src);
      setThumbSrc(src);
    })();
    return () => {
      cancelled = true;
    };
  }, [path]);

  const description =
    parsedResult.type === "success" ? parsedResult.description : "";

  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async (): Promise<void> => {
    if (description === "") {
      return;
    }
    try {
      await navigator.clipboard.writeText(description);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      console.warn("[imagegen] copy description failed", error);
    }
  }, [description]);

  const errorMessage =
    parsedResult.type === "error"
      ? localizeToolError(t, parsedResult.message)
      : isFailed && parsedResult.type === "raw"
        ? parsedResult.text
        : "";

  const fileName = path ? fileNameOf(path) : "";

  return (
    <ToolCallNode
      toolName={toolCall.name}
      badgeName={t("toolCall.imagegen.describeName")}
      category="image"
      displayName={fileName ? truncateLabel(fileName, 60) : undefined}
      displayNameTitle={path || undefined}
      displayNameDataPath={path || undefined}
      status={effectiveStatus}
      meta={
        parsedResult.type === "success" ? (
          <span className="tool-call-imagegen-count">
            {t("toolCall.imagegen.describeChars", {
              values: { count: description.length.toLocaleString() },
            })}
          </span>
        ) : null
      }
      className="tool-call-imagegen"
    >
      <div className="tool-call-body tool-call-imagegen-body">
        {parsedArgs ? (
          <div className="tool-call-imagegen-params">
            <div className="tool-call-imagegen-param-item">
              <ImageIcon size={11} aria-hidden="true" />
              <span className="tool-call-imagegen-param-label">
                {t("toolCall.imagegen.describeImage")}
              </span>
              <code className="tool-call-imagegen-param-value">
                {parsedArgs.path}
              </code>
            </div>
            {parsedArgs.prompt ? (
              <div className="tool-call-imagegen-param-item">
                <Sparkles size={11} aria-hidden="true" />
                <span className="tool-call-imagegen-param-label">
                  {t("toolCall.imagegen.describePrompt")}
                </span>
                <code className="tool-call-imagegen-param-value">
                  {parsedArgs.prompt}
                </code>
              </div>
            ) : null}
          </div>
        ) : null}

        {thumbSrc ? (
          <div className="tool-call-imagegen-describe-preview">
            <img
              src={thumbSrc}
              alt={fileName || t("toolCall.imagegen.describeImage")}
            />
          </div>
        ) : null}

        {errorMessage ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{errorMessage}</span>
          </div>
        ) : null}

        {parsedResult.type === "success" ? (
          <div className="tool-call-imagegen-describe-result">
            <div className="tool-call-imagegen-describe-head">
              <span className="tool-call-imagegen-describe-head-label">
                <ScanSearch size={11} aria-hidden="true" />
                {t("toolCall.imagegen.describeResult")}
              </span>
              <button
                type="button"
                className="tool-call-imagegen-describe-copy"
                onClick={() => void handleCopy()}
              >
                {copied ? (
                  <>
                    <Check size={11} aria-hidden="true" />
                    {t("toolCall.imagegen.describeCopied")}
                  </>
                ) : (
                  <>
                    <Copy size={11} aria-hidden="true" />
                    {t("toolCall.imagegen.describeCopy")}
                  </>
                )}
              </button>
            </div>
            <pre className="tool-call-imagegen-describe-text">
              {description}
            </pre>
          </div>
        ) : null}

        {parsedResult.type === "raw" && !isFailed ? (
          <section className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.imagegen.result")}
            </span>
            <pre className="tool-call-section-pre">{parsedResult.text}</pre>
          </section>
        ) : null}

        {parsedResult.type === "empty" ? (
          <div
            className={`tool-call-imagegen-describe-pending${
              isRunning ? " tool-call-imagegen-describe-pending-running" : ""
            }`}
          >
            {isRunning ? (
              <Loader2
                className="tool-call-icon-spinning"
                size={14}
                aria-hidden="true"
              />
            ) : (
              <ScanSearch size={14} aria-hidden="true" />
            )}
            <span>
              {isRunning
                ? t("toolCall.imagegen.describeAnalyzing")
                : t("toolCall.imagegen.describeWaiting")}
            </span>
          </div>
        ) : null}
      </div>
    </ToolCallNode>
  );
};
