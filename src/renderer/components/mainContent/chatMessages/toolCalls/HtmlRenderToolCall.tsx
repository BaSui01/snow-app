import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AppWindow,
  Check,
  CodeXml,
  Copy,
  Download,
  Eye,
  Loader2,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import { rightPanelEvents } from "../../../rightPanel/rightPanelEvents";
import {
  htmlPreviewUrl,
  type HtmlPreviewDocument,
} from "../../../../../shared/htmlPreview";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { CodeHighlightView } from "./shared/CodeHighlightView";
import { ToolCallNode } from "./shared/ToolCallNode";
import { localizeToolError } from "./shared/toolErrorDisplay";

type HtmlRenderToolCallProps = {
  toolCall: ToolCallInfo;
};

type ViewMode = "preview" | "source";

type RenderResult = {
  success: boolean;
  title: string;
  height: number | null;
  error: string | null;
};

/** 预览区默认高度（工具未指定 height 时）。 */
const DEFAULT_PREVIEW_HEIGHT = 480;

/**
 * iframe 沙箱权限：预览文档由 html-preview:// 按文档独立源加载，与应用页面
 * 不同源，因此可放开脚本与同源存储；不授予 allow-top-navigation，页面无法
 * 把应用主框架导航走。新窗口经主窗口 setWindowOpenHandler 交给系统浏览器。
 */
const PREVIEW_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseArgs = (raw: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const parseResult = (
  raw: string | undefined,
  status: ToolCallInfo["status"],
): RenderResult => {
  const empty: RenderResult = {
    success: false,
    title: "",
    height: null,
    error: null,
  };
  if (!raw) {
    return empty;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return empty;
    }
    if (typeof parsed.error === "string") {
      return { ...empty, error: parsed.error };
    }
    return {
      success: parsed.success === true,
      title: typeof parsed.title === "string" ? parsed.title : "",
      height: typeof parsed.height === "number" ? parsed.height : null,
      error: null,
    };
  } catch {
    // 执行失败时结果可能是纯文本错误信息
    return status === "error" ? { ...empty, error: raw } : empty;
  }
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};

export const HtmlRenderToolCall = ({
  toolCall,
}: HtmlRenderToolCallProps): React.JSX.Element => {
  const { t } = useI18n();

  const parsedArgs = useMemo(
    () => parseArgs(toolCall.arguments),
    [toolCall.arguments],
  );
  const html = typeof parsedArgs?.html === "string" ? parsedArgs.html : "";
  const argTitle =
    typeof parsedArgs?.title === "string" ? parsedArgs.title.trim() : "";

  const result = useMemo(
    () => parseResult(toolCall.result, toolCall.status),
    [toolCall.result, toolCall.status],
  );
  const errorMessage = result.error;
  const effectiveStatus = errorMessage ? "error" : toolCall.status;
  const isReady =
    toolCall.status === "completed" && result.success && html.length > 0;
  const isWorking =
    !errorMessage &&
    (toolCall.status === "pending" || toolCall.status === "running");

  const [viewMode, setViewMode] = useState<ViewMode>("preview");
  const [previewDocument, setPreviewDocument] =
    useState<HtmlPreviewDocument | null>(null);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // 进入视口后才物化缓存并挂载 iframe：长会话里的历史卡片不会一次性
  // 全部加载页面。
  useEffect(() => {
    if (!isReady || isVisible) {
      return;
    }
    const element = panelRef.current;
    if (!element) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [isReady, isVisible]);

  // 物化预览缓存（内容寻址，已存在时 Rust 直接跳过写入；缓存被清理后
  // 由此自愈）。
  useEffect(() => {
    if (!isReady || !isVisible) {
      return;
    }
    let cancelled = false;
    window.snow
      .prepareHtmlPreview(html, argTitle || undefined)
      .then((prepared) => {
        if (!cancelled) {
          setPreviewDocument(prepared);
          setPrepareError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPrepareError(
            error instanceof Error ? error.message : String(error),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isReady, isVisible, html, argTitle]);

  const title = previewDocument?.title || result.title || argTitle;
  const previewHeight = result.height ?? DEFAULT_PREVIEW_HEIGHT;

  const handleCopy = useCallback((): void => {
    void navigator.clipboard.writeText(html).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [html]);

  const handleDownload = useCallback((): void => {
    setIsSaving(true);
    window.snow
      .saveHtmlPreview(html, title || undefined)
      .catch((error: unknown) => {
        console.error("[html-render] save failed:", error);
      })
      .finally(() => setIsSaving(false));
  }, [html, title]);

  const handleOpenInBrowser = useCallback((): void => {
    const open = (prepared: HtmlPreviewDocument): void => {
      rightPanelEvents.emit("open-browser-tab", { url: prepared.fileUrl });
    };
    if (previewDocument) {
      open(previewDocument);
      return;
    }
    window.snow
      .prepareHtmlPreview(html, argTitle || undefined)
      .then((prepared) => {
        setPreviewDocument(prepared);
        open(prepared);
      })
      .catch((error: unknown) => {
        console.error("[html-render] open in browser failed:", error);
      });
  }, [previewDocument, html, argTitle]);

  const renderPreview = (): React.JSX.Element => {
    if (prepareError) {
      return (
        <div className="html-render-placeholder html-render-placeholder--error">
          <AlertCircle size={14} aria-hidden="true" />
          <span>{prepareError}</span>
        </div>
      );
    }
    if (!previewDocument) {
      return (
        <div className="html-render-placeholder">
          <Loader2
            className="tool-call-icon-spinning"
            size={14}
            aria-hidden="true"
          />
          <span>{t("toolCall.htmlRender.loading")}</span>
        </div>
      );
    }
    return (
      <iframe
        className="html-render-frame"
        src={htmlPreviewUrl(previewDocument.id)}
        title={title || t("toolCall.htmlRender.preview")}
        sandbox={PREVIEW_SANDBOX}
        referrerPolicy="no-referrer"
      />
    );
  };

  return (
    <ToolCallNode
      toolName={toolCall.name}
      category="html"
      displayName={title || (isReady ? "HTML" : null)}
      displayNameTitle={title || undefined}
      status={effectiveStatus}
      defaultOpen={isReady}
      meta={
        previewDocument ? (
          <span className="html-render-size">
            {formatBytes(previewDocument.bytes)}
          </span>
        ) : null
      }
      className="html-render-tool-call"
    >
      <div className="tool-call-body html-render-body">
        {isReady ? (
          <div className="html-render-panel" ref={panelRef}>
            <div className="html-render-toolbar">
              <div className="html-render-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewMode === "preview"}
                  className={`html-render-tab${viewMode === "preview" ? " is-active" : ""}`}
                  onClick={() => setViewMode("preview")}
                >
                  <Eye size={12} aria-hidden="true" />
                  <span>{t("toolCall.htmlRender.preview")}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={viewMode === "source"}
                  className={`html-render-tab${viewMode === "source" ? " is-active" : ""}`}
                  onClick={() => setViewMode("source")}
                >
                  <CodeXml size={12} aria-hidden="true" />
                  <span>{t("toolCall.htmlRender.source")}</span>
                </button>
              </div>
              <div className="html-render-actions">
                <button
                  type="button"
                  className="html-render-action"
                  onClick={handleCopy}
                  title={t("toolCall.htmlRender.copySource")}
                >
                  {copied ? (
                    <Check size={12} aria-hidden="true" />
                  ) : (
                    <Copy size={12} aria-hidden="true" />
                  )}
                  <span>{copied ? t("common.copied") : t("common.copy")}</span>
                </button>
                <button
                  type="button"
                  className="html-render-action"
                  onClick={handleDownload}
                  disabled={isSaving}
                  title={t("toolCall.htmlRender.downloadTitle")}
                >
                  <Download size={12} aria-hidden="true" />
                  <span>{t("toolCall.htmlRender.download")}</span>
                </button>
                <button
                  type="button"
                  className="html-render-action"
                  onClick={handleOpenInBrowser}
                  title={t("toolCall.htmlRender.openInBrowserTitle")}
                >
                  <AppWindow size={12} aria-hidden="true" />
                  <span>{t("toolCall.htmlRender.openInBrowser")}</span>
                </button>
              </div>
            </div>
            {viewMode === "preview" ? (
              <div
                className="html-render-frame-wrap"
                style={{ height: previewHeight }}
              >
                {renderPreview()}
              </div>
            ) : (
              <CodeHighlightView
                className="html-render-source"
                code={html}
                language="xml"
                maxHeight={previewHeight}
              />
            )}
          </div>
        ) : null}

        {errorMessage ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{localizeToolError(t, errorMessage)}</span>
          </div>
        ) : null}

        {isWorking ? (
          <div className="html-render-pending">
            <Loader2
              className="tool-call-icon-spinning"
              size={14}
              aria-hidden="true"
            />
            <span>{t("toolCall.htmlRender.generating")}</span>
          </div>
        ) : null}
      </div>
    </ToolCallNode>
  );
};
