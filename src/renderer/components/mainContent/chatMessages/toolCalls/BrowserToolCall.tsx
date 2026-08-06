import { useMemo } from "react";
import {
  AlertCircle,
  AppWindow,
  Camera,
  Code2,
  ExternalLink,
  FileText,
  Fingerprint,
  Focus,
  Globe,
  Link2,
  Loader2,
  Locate,
  Lock,
  Monitor,
  MousePointerClick,
  Plus,
  Terminal,
  X,
  type LucideIcon,
} from "lucide-react";
import { useI18n } from "../../../../i18n";
import { rightPanelEvents } from "../../../rightPanel/rightPanelEvents";
import type { ToolCallInfo } from "../utils/conversationTypes";
import { ToolCallNode } from "./shared/ToolCallNode";

type BrowserToolCallProps = {
  toolCall: ToolCallInfo;
};

type BrowserOperation =
  | "create"
  | "navigate"
  | "click"
  | "screenshot"
  | "devtools"
  | "close"
  | "focus"
  | "list"
  | "wait"
  | "press_key"
  | "hover"
  | "navigate_back"
  | "navigate_forward"
  | "select_option"
  | "upload-file"
  | "back"
  | "forward";

type ParsedResult =
  | { type: "success"; data: Record<string, unknown> }
  | { type: "error"; message: string }
  | { type: "raw"; text: string }
  | { type: "empty" };

type ClickedElement = {
  tagName: string;
  id: string | null;
  text: string;
  href: string | null;
};

type ConsoleMessage = {
  level: number;
  message: string;
  line: number;
  sourceId: string;
  recordedAt: string;
};

type SnapshotLink = {
  text: string;
  href: string;
};

type SnapshotData = {
  url: string;
  title: string;
  readyState: string;
  contentType: string;
  characterSet: string;
  viewport: { width: number; height: number } | null;
  documentSize: { scrollWidth: number; scrollHeight: number } | null;
  text: string;
  links: SnapshotLink[];
};

type BrowserTab = {
  instanceId: string;
  title: string;
  isActive: boolean;
};

type ScreenshotImage = {
  data: string;
  mimeType: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const parseArgs = (args: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(args);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const parseResult = (result: string | undefined): ParsedResult => {
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
    return { type: "success", data: parsed };
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

/** "browser-1751234567890-a1b2c3d4" -> "#a1b2c3d4"，完整 ID 放在 tooltip。 */
const shortInstanceId = (instanceId: string): string => {
  const segments = instanceId.split("-");
  const tail = segments[segments.length - 1];
  return tail ? `#${tail}` : instanceId;
};

/** 请求右侧面板切换到指定浏览器实例的 tab（RightPanel 订阅处理）。 */
const focusBrowserTab = (instanceId: string): void => {
  rightPanelEvents.emit("focus-browser-tab", { instanceId });
};

/** 请求右侧面板新建浏览器 tab（与 WebSearchToolCall 行为一致）。 */
const openInAppBrowser = (url: string): void => {
  rightPanelEvents.emit("open-browser-tab", { url });
};

/** 在系统浏览器中打开（主进程 setWindowOpenHandler 转交 shell.openExternal）。 */
const openExternalLink = (url: string): void => {
  window.open(url, "_blank");
};

const parseClickedElement = (value: unknown): ClickedElement | null => {
  if (!isRecord(value)) {
    return null;
  }
  return {
    tagName: asString(value.tagName) ?? "?",
    id: asString(value.id) ?? null,
    text: asString(value.text) ?? "",
    href: asString(value.href) ?? null,
  };
};

const parseConsoleMessages = (value: unknown): ConsoleMessage[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord).map((item) => ({
    level: asNumber(item.level) ?? 1,
    message: asString(item.message) ?? "",
    line: asNumber(item.line) ?? 0,
    sourceId: asString(item.sourceId) ?? "",
    recordedAt: asString(item.recordedAt) ?? "",
  }));
};

const parseSnapshot = (value: unknown): SnapshotData | null => {
  if (!isRecord(value)) {
    return null;
  }
  const viewport = isRecord(value.viewport) ? value.viewport : null;
  const documentSize = isRecord(value.document) ? value.document : null;
  const rawLinks = Array.isArray(value.links) ? value.links : [];
  return {
    url: asString(value.url) ?? "",
    title: asString(value.title) ?? "",
    readyState: asString(value.readyState) ?? "",
    contentType: asString(value.contentType) ?? "",
    characterSet: asString(value.characterSet) ?? "",
    viewport:
      viewport &&
      asNumber(viewport.width) !== undefined &&
      asNumber(viewport.height) !== undefined
        ? {
            width: asNumber(viewport.width) as number,
            height: asNumber(viewport.height) as number,
          }
        : null,
    documentSize:
      documentSize &&
      asNumber(documentSize.scrollWidth) !== undefined &&
      asNumber(documentSize.scrollHeight) !== undefined
        ? {
            scrollWidth: asNumber(documentSize.scrollWidth) as number,
            scrollHeight: asNumber(documentSize.scrollHeight) as number,
          }
        : null,
    text: asString(value.text) ?? "",
    links: rawLinks
      .filter(isRecord)
      .map((link) => ({
        text: asString(link.text) ?? "",
        href: asString(link.href) ?? "",
      }))
      .filter((link) => link.href !== ""),
  };
};

const parseBrowserTabs = (value: unknown): BrowserTab[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(isRecord)
    .filter((item) => asString(item.instanceId) !== undefined)
    .map((item) => ({
      instanceId: asString(item.instanceId) as string,
      title: asString(item.title) ?? "",
      isActive: item.isActive === true,
    }));
};

const parseScreenshotImage = (value: unknown): ScreenshotImage | null => {
  if (!Array.isArray(value)) {
    return null;
  }
  for (const block of value) {
    if (
      isRecord(block) &&
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      return { data: block.data, mimeType: block.mimeType };
    }
  }
  return null;
};

const consoleLevelKey = (level: number): string => {
  if (level <= 0) return "verbose";
  if (level === 1) return "info";
  if (level === 2) return "warning";
  return "error";
};

const sourceFileName = (sourceId: string): string => {
  if (!sourceId) {
    return "";
  }
  const segments = sourceId.split("/");
  return segments[segments.length - 1] || sourceId;
};

/* ---------------- 共享子组件 ---------------- */

/** 仿浏览器地址栏：安全锁 / Globe 图标 + 协议弱化 + 剩余部分。 */
const AddressBar = ({ url }: { url: string }): React.JSX.Element => {
  const isSecure = url.startsWith("https://");
  const separatorIndex = url.indexOf("://");
  const protocol = separatorIndex >= 0 ? url.slice(0, separatorIndex + 3) : "";
  const rest = separatorIndex >= 0 ? url.slice(separatorIndex + 3) : url;
  return (
    <div className="tool-call-browser-address" title={url}>
      {isSecure ? (
        <Lock size={11} aria-hidden="true" />
      ) : (
        <Globe size={11} aria-hidden="true" />
      )}
      {protocol ? (
        <span className="tool-call-browser-address-protocol">{protocol}</span>
      ) : null}
      <span className="tool-call-browser-address-rest">{rest}</span>
    </div>
  );
};

type TagTone = "blue" | "green" | "amber" | "neutral";

const Tag = ({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: TagTone;
}): React.JSX.Element => (
  <span className={`tool-call-browser-tag tool-call-browser-tag-${tone}`}>
    {children}
  </span>
);

/** 可点击的实例 ID 徽章：点击切换到对应浏览器 tab。 */
const InstanceChip = ({
  instanceId,
}: {
  instanceId: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="tool-call-browser-instance"
      onClick={() => focusBrowserTab(instanceId)}
      title={`${instanceId}\n${t("toolCall.browser.focusTab")}`}
    >
      <Fingerprint size={10} aria-hidden="true" />
      <span>{shortInstanceId(instanceId)}</span>
    </button>
  );
};

/** 页面信息卡：标题 + 定位按钮（切换 tab）+ 外链按钮。 */
const PageCard = ({
  title,
  url,
  instanceId,
}: {
  title: string;
  url: string;
  instanceId?: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  const host = url ? getHost(url) : "";
  return (
    <div className="tool-call-browser-page">
      <div className="tool-call-browser-page-title">
        <Globe size={13} aria-hidden="true" />
        <span className="tool-call-browser-page-title-text" title={title || url}>
          {title || host}
        </span>
      </div>
      <div className="tool-call-browser-page-row">
        {instanceId ? (
          <button
            type="button"
            className="tool-call-browser-page-link"
            onClick={() => focusBrowserTab(instanceId)}
            title={`${url}\n${t("toolCall.browser.focusTab")}`}
          >
            <Locate size={10} aria-hidden="true" />
            <span>{host || shortInstanceId(instanceId)}</span>
          </button>
        ) : null}
        {url && (url.startsWith("http://") || url.startsWith("https://")) ? (
          <button
            type="button"
            className="tool-call-browser-external"
            onClick={() => openExternalLink(url)}
            title={t("toolCall.browser.openExternal")}
            aria-label={t("toolCall.browser.openExternal")}
          >
            <ExternalLink size={10} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  );
};

/** 单行状态条：用于 create / close / focus / devtools-open 的完成态。 */
const StatusRow = ({
  icon: Icon,
  label,
  children,
}: {
  icon: LucideIcon;
  label: string;
  children?: React.ReactNode;
}): React.JSX.Element => (
  <div className="tool-call-browser-status">
    <Icon size={13} aria-hidden="true" />
    <span className="tool-call-browser-status-label">{label}</span>
    {children}
  </div>
);

/** 等待 / 执行中占位。 */
const PendingBlock = ({
  isRunning,
  runningLabel,
  waitingLabel,
}: {
  isRunning: boolean;
  runningLabel: string;
  waitingLabel: string;
}): React.JSX.Element => (
  <div
    className={`tool-call-browser-pending ${
      isRunning ? "tool-call-browser-pending-running" : ""
    }`}
  >
    {isRunning ? (
      <Loader2 className="tool-call-icon-spinning" size={14} aria-hidden="true" />
    ) : (
      <Globe size={14} aria-hidden="true" />
    )}
    <span>{isRunning ? runningLabel : waitingLabel}</span>
  </div>
);

/* ---------------- 各操作渲染 ---------------- */

const CreateView = ({
  args,
  data,
}: {
  args: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const argUrl = asString(args?.url);
  const instanceId = asString(data?.instanceId);
  const resultUrl = asString(data?.url);
  if (!argUrl && !instanceId) {
    return null;
  }
  return (
    <>
      {argUrl ? <AddressBar url={argUrl} /> : null}
      {instanceId ? (
        <StatusRow icon={Plus} label={t("toolCall.browser.created")}>
          <InstanceChip instanceId={instanceId} />
          {resultUrl ? <Tag tone="blue">{getHost(resultUrl)}</Tag> : null}
        </StatusRow>
      ) : null}
    </>
  );
};

const NavigateView = ({
  args,
  data,
}: {
  args: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const argUrl = asString(args?.url);
  const timeoutMs = asNumber(args?.timeoutMs);
  const instanceIdArg = asString(args?.instanceId);
  const resultUrl = asString(data?.url);
  const title = asString(data?.title);
  const instanceId = asString(data?.instanceId) ?? instanceIdArg;
  if (!argUrl && !data) {
    return null;
  }
  return (
    <>
      {argUrl ? <AddressBar url={argUrl} /> : null}
      {timeoutMs !== undefined || instanceIdArg ? (
        <div className="tool-call-browser-tags">
          {timeoutMs !== undefined ? (
            <Tag>
              {t("toolCall.browser.timeout")}: {timeoutMs.toLocaleString()}ms
            </Tag>
          ) : null}
          {instanceIdArg && instanceIdArg.toLowerCase() !== "current" ? (
            <Tag>{shortInstanceId(instanceIdArg)}</Tag>
          ) : null}
        </div>
      ) : null}
      {data ? (
        <PageCard
          title={title ?? ""}
          url={resultUrl ?? argUrl ?? ""}
          instanceId={instanceId}
        />
      ) : null}
    </>
  );
};

const ClickView = ({
  args,
  data,
}: {
  args: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const selector = asString(args?.selector);
  const text = asString(args?.text);
  const exact = args?.exact === true;
  const element = data ? parseClickedElement(data.element) : null;
  const resultUrl = asString(data?.url);
  const title = asString(data?.title);
  const instanceId = asString(data?.instanceId);
  if (!selector && !text && !element) {
    return null;
  }
  return (
    <>
      {selector || text ? (
        <div className="tool-call-browser-target">
          <MousePointerClick size={12} aria-hidden="true" />
          {selector ? (
            <code className="tool-call-browser-target-selector">{selector}</code>
          ) : null}
          {text ? (
            <span className="tool-call-browser-target-text">"{text}"</span>
          ) : null}
          {exact ? (
            <Tag tone="amber">{t("toolCall.browser.exactMatch")}</Tag>
          ) : null}
        </div>
      ) : null}
      {element ? (
        <div className="tool-call-browser-element">
          <div className="tool-call-browser-element-head">
            <span className="tool-call-browser-element-tagname">
              <Code2 size={10} aria-hidden="true" />
              {element.tagName}
            </span>
            {element.id ? (
              <span className="tool-call-browser-element-id">#{element.id}</span>
            ) : null}
            {element.text ? (
              <span
                className="tool-call-browser-element-text"
                title={element.text}
              >
                {truncateLabel(element.text, 80)}
              </span>
            ) : null}
          </div>
          {element.href ? (
            <div className="tool-call-browser-element-href">
              <Link2 size={10} aria-hidden="true" />
              <button
                type="button"
                className="tool-call-browser-element-href-link"
                onClick={() => openInAppBrowser(element.href as string)}
                title={`${element.href}\n${t("toolCall.browser.openInApp")}`}
              >
                {element.href}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {data ? (
        <PageCard
          title={title ?? ""}
          url={resultUrl ?? ""}
          instanceId={instanceId}
        />
      ) : null}
    </>
  );
};

const ScreenshotView = ({
  args,
  data,
}: {
  args: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const fullPageArg = args?.fullPage !== false;
  const fullPage = data ? data.fullPage !== false : fullPageArg;
  const image = data ? parseScreenshotImage(data.content) : null;
  const resultUrl = asString(data?.url);
  const title = asString(data?.title);
  const instanceId = asString(data?.instanceId);
  return (
    <>
      <div className="tool-call-browser-tags">
        <Tag tone={fullPage ? "blue" : "neutral"}>
          <Camera size={10} aria-hidden="true" />
          {fullPage
            ? t("toolCall.browser.fullPage")
            : t("toolCall.browser.viewportOnly")}
        </Tag>
      </div>
      {data ? (
        <PageCard
          title={title ?? ""}
          url={resultUrl ?? ""}
          instanceId={instanceId}
        />
      ) : null}
      {image ? (
        <div className="tool-call-browser-shot">
          <img
            src={`data:${image.mimeType};base64,${image.data}`}
            alt={title || resultUrl || "screenshot"}
          />
        </div>
      ) : null}
    </>
  );
};

const DevtoolsSnapshotView = ({
  snapshot,
  instanceId,
}: {
  snapshot: SnapshotData;
  instanceId?: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  const metaCells: Array<{ label: string; value: string }> = [
    { label: t("toolCall.browser.readyState"), value: snapshot.readyState },
    { label: t("toolCall.browser.contentType"), value: snapshot.contentType },
    ...(snapshot.viewport
      ? [
          {
            label: t("toolCall.browser.viewportSize"),
            value: `${snapshot.viewport.width} x ${snapshot.viewport.height}`,
          },
        ]
      : []),
    ...(snapshot.documentSize
      ? [
          {
            label: t("toolCall.browser.documentSize"),
            value: `${snapshot.documentSize.scrollWidth} x ${snapshot.documentSize.scrollHeight}`,
          },
        ]
      : []),
  ].filter((cell) => cell.value !== "");

  return (
    <>
      <PageCard
        title={snapshot.title}
        url={snapshot.url}
        instanceId={instanceId}
      />
      {metaCells.length > 0 ? (
        <div className="tool-call-browser-meta-grid">
          {metaCells.map((cell) => (
            <div key={cell.label} className="tool-call-browser-meta-cell">
              <span className="tool-call-browser-meta-label">{cell.label}</span>
              <span className="tool-call-browser-meta-value">{cell.value}</span>
            </div>
          ))}
        </div>
      ) : null}
      {snapshot.text ? (
        <div className="tool-call-browser-text-wrap">
          <span className="tool-call-browser-section-label">
            <FileText size={10} aria-hidden="true" />
            {t("toolCall.browser.pageText")}
          </span>
          <pre className="tool-call-browser-text">{snapshot.text}</pre>
        </div>
      ) : null}
      {snapshot.links.length > 0 ? (
        <details className="tool-call-browser-links">
          <summary>
            <Link2 size={10} aria-hidden="true" />
            {t("toolCall.browser.links")}
            <span className="tool-call-browser-links-count">
              {snapshot.links.length}
            </span>
          </summary>
          <div className="tool-call-browser-links-list">
            {snapshot.links.slice(0, 100).map((link, index) => (
              <div
                key={`${link.href}-${index}`}
                className="tool-call-browser-link-row"
              >
                <button
                  type="button"
                  className="tool-call-browser-link-text"
                  onClick={() => openInAppBrowser(link.href)}
                  title={`${link.href}\n${t("toolCall.browser.openInApp")}`}
                >
                  {link.text || getHost(link.href)}
                </button>
                <span className="tool-call-browser-link-host">
                  {getHost(link.href)}
                </span>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </>
  );
};

const DevtoolsConsoleView = ({
  messages,
}: {
  messages: ConsoleMessage[];
}): React.JSX.Element => {
  const { t } = useI18n();
  if (messages.length === 0) {
    return (
      <div className="tool-call-browser-empty">
        <Terminal size={14} aria-hidden="true" />
        <span>{t("toolCall.browser.noConsoleMessages")}</span>
      </div>
    );
  }
  return (
    <div className="tool-call-browser-console">
      {messages.map((item, index) => {
        const levelKey = consoleLevelKey(item.level);
        const source = sourceFileName(item.sourceId);
        return (
          <div
            key={`${item.recordedAt}-${index}`}
            className={`tool-call-browser-console-row tool-call-browser-console-${levelKey}`}
          >
            <span className="tool-call-browser-console-level">
              {t(`toolCall.browser.level.${levelKey}`)}
            </span>
            <span className="tool-call-browser-console-message">
              {item.message}
            </span>
            {source ? (
              <span className="tool-call-browser-console-source">
                {source}
                {item.line > 0 ? `:${item.line}` : ""}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};

const DevtoolsView = ({
  args,
  data,
}: {
  args: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const action = asString(args?.action) ?? "snapshot";
  const maxContentLength = asNumber(args?.maxContentLength);
  const clearConsole = args?.clearConsole === true;
  const instanceId = asString(data?.instanceId);

  const snapshot =
    action === "snapshot" && data ? parseSnapshot(data.snapshot) : null;
  const messages =
    action === "console" && data
      ? parseConsoleMessages(data.messages)
      : null;
  const opened = data?.opened === true;
  const resultUrl = asString(data?.url);
  const title = asString(data?.title);

  return (
    <>
      <div className="tool-call-browser-tags">
        <Tag tone="blue">
          <Terminal size={10} aria-hidden="true" />
          {action}
        </Tag>
        {action === "snapshot" && maxContentLength !== undefined ? (
          <Tag>
            {t("toolCall.browser.maxLength")}:{" "}
            {maxContentLength.toLocaleString()}
          </Tag>
        ) : null}
        {action === "console" && clearConsole ? (
          <Tag tone="amber">{t("toolCall.browser.clearConsole")}</Tag>
        ) : null}
      </div>

      {snapshot ? (
        <DevtoolsSnapshotView snapshot={snapshot} instanceId={instanceId} />
      ) : null}
      {messages ? <DevtoolsConsoleView messages={messages} /> : null}
      {opened ? (
        <StatusRow icon={Monitor} label={t("toolCall.browser.devtoolsOpened")}>
          {instanceId ? <InstanceChip instanceId={instanceId} /> : null}
        </StatusRow>
      ) : null}
      {action === "console" && data && resultUrl ? (
        <PageCard title={title ?? ""} url={resultUrl} instanceId={instanceId} />
      ) : null}
    </>
  );
};

const CloseFocusView = ({
  operation,
  args,
  data,
}: {
  operation: "close" | "focus";
  args: Record<string, unknown> | null;
  data: Record<string, unknown> | null;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  const instanceId =
    asString(data?.instanceId) ?? asString(args?.instanceId);
  if (!instanceId) {
    return null;
  }
  const done = data ? data.closed === true || data.focused === true : false;
  return (
    <StatusRow
      icon={operation === "close" ? X : Focus}
      label={
        done
          ? operation === "close"
            ? t("toolCall.browser.closed")
            : t("toolCall.browser.focused")
          : operation === "close"
          ? t("toolCall.browser.closingTarget")
          : t("toolCall.browser.focusingTarget")
      }
    >
      <InstanceChip instanceId={instanceId} />
    </StatusRow>
  );
};

const ListView = ({
  data,
}: {
  data: Record<string, unknown> | null;
}): React.JSX.Element | null => {
  const { t } = useI18n();
  if (!data) {
    return null;
  }
  const tabs = parseBrowserTabs(data.tabs);
  if (tabs.length === 0) {
    return (
      <div className="tool-call-browser-empty">
        <AppWindow size={14} aria-hidden="true" />
        <span>{t("toolCall.browser.noTabs")}</span>
      </div>
    );
  }
  return (
    <div className="tool-call-browser-tabs">
      {tabs.map((tab) => (
        <button
          key={tab.instanceId}
          type="button"
          className={`tool-call-browser-tab ${
            tab.isActive ? "tool-call-browser-tab-active" : ""
          }`}
          onClick={() => focusBrowserTab(tab.instanceId)}
          title={`${tab.instanceId}\n${t("toolCall.browser.focusTab")}`}
        >
          <span
            className={`tool-call-browser-tab-dot ${
              tab.isActive ? "tool-call-browser-tab-dot-active" : ""
            }`}
            aria-hidden="true"
          />
          <span className="tool-call-browser-tab-title">
            {tab.title || getHost(tab.instanceId)}
          </span>
          {tab.isActive ? (
            <span className="tool-call-browser-tab-flag">
              {t("toolCall.browser.activeTab")}
            </span>
          ) : null}
          <span className="tool-call-browser-tab-id">
            {shortInstanceId(tab.instanceId)}
          </span>
        </button>
      ))}
    </div>
  );
};

/* ---------------- 主组件 ---------------- */

const RUNNING_LABEL_KEYS: Record<BrowserOperation, string> = {
  create: "toolCall.browser.running.create",
  navigate: "toolCall.browser.running.navigate",
  click: "toolCall.browser.running.click",
  screenshot: "toolCall.browser.running.screenshot",
  devtools: "toolCall.browser.running.devtools",
  close: "toolCall.browser.running.close",
  focus: "toolCall.browser.running.focus",
  list: "toolCall.browser.running.list",
  wait: "toolCall.browser.running.wait",
  press_key: "toolCall.browser.running.press_key",
  hover: "toolCall.browser.running.hover",
  navigate_back: "toolCall.browser.running.navigate_back",
  navigate_forward: "toolCall.browser.running.navigate_forward",
  select_option: "toolCall.browser.running.select_option",
  "upload-file": "toolCall.browser.running.upload_file",
  back: "toolCall.browser.running.back",
  forward: "toolCall.browser.running.forward",
};

export const BrowserToolCall = ({
  toolCall,
}: BrowserToolCallProps): React.JSX.Element => {
  const { t } = useI18n();
  const operation = (
    toolCall.name.startsWith("browser-")
      ? toolCall.name.slice("browser-".length)
      : toolCall.name
  ) as BrowserOperation;

  const parsedArgs = useMemo(
    () => parseArgs(toolCall.arguments),
    [toolCall.arguments]
  );
  const parsedResult = useMemo(
    () => parseResult(toolCall.result),
    [toolCall.result]
  );

  const isRunning = toolCall.status === "running";
  const hasError = parsedResult.type === "error";
  const effectiveStatus = hasError ? "error" : toolCall.status;
  const data = parsedResult.type === "success" ? parsedResult.data : null;

  /* 头部 displayName：优先展示 URL host / 选择器 / 实例 ID 等上下文 */
  const argUrl = asString(parsedArgs?.url);
  const argSelector = asString(parsedArgs?.selector);
  const argText = asString(parsedArgs?.text);
  const argInstanceId = asString(parsedArgs?.instanceId);
  const resultUrl = asString(data?.url);
  const snapshotHost = (() => {
    const snapshot =
      operation === "devtools" && data ? parseSnapshot(data.snapshot) : null;
    return snapshot?.url ? getHost(snapshot.url) : "";
  })();

  let displayName: string | undefined;
  switch (operation) {
    case "create":
      displayName = argUrl ? getHost(argUrl) : t("toolCall.browser.newTab");
      break;
    case "navigate":
      displayName = argUrl ? getHost(argUrl) : undefined;
      break;
    case "click":
      displayName = argSelector
        ? truncateLabel(argSelector, 48)
        : argText
        ? truncateLabel(`"${argText}"`, 48)
        : undefined;
      break;
    case "screenshot":
      displayName = resultUrl ? getHost(resultUrl) : undefined;
      break;
    case "devtools":
      displayName = snapshotHost || (data?.url ? getHost(String(data.url)) : "");
      displayName = displayName || undefined;
      break;
    case "close":
    case "focus": {
      const instanceId = asString(data?.instanceId) ?? argInstanceId;
      displayName = instanceId ? shortInstanceId(instanceId) : undefined;
      break;
    }
    case "list":
      displayName = t("toolCall.browser.allTabs");
      break;
  }

  /* 头部 meta 徽章：按操作给出最有信息量的摘要 */
  const meta = (() => {
    if (!data) {
      return null;
    }
    switch (operation) {
      case "navigate": {
        const title = asString(data.title);
        return title ? (
          <span className="tool-call-browser-meta">
            <FileText size={10} aria-hidden="true" />
            {truncateLabel(title, 40)}
          </span>
        ) : null;
      }
      case "click": {
        const element = parseClickedElement(data.element);
        return element ? (
          <span className="tool-call-browser-meta tool-call-browser-meta-code">
            {element.tagName}
          </span>
        ) : null;
      }
      case "screenshot":
        return (
          <span className="tool-call-browser-meta tool-call-browser-meta-image">
            <Camera size={10} aria-hidden="true" />
            PNG
          </span>
        );
      case "devtools": {
        const action = asString(parsedArgs?.action) ?? "snapshot";
        if (action === "console") {
          const count = parseConsoleMessages(data.messages).length;
          return (
            <span className="tool-call-browser-meta">
              <Terminal size={10} aria-hidden="true" />
              {t("toolCall.browser.messageCount", { values: { count } })}
            </span>
          );
        }
        if (action === "snapshot") {
          const snapshot = parseSnapshot(data.snapshot);
          if (snapshot) {
            return (
              <span className="tool-call-browser-meta">
                {t("toolCall.browser.charCount", {
                  values: { count: snapshot.text.length.toLocaleString() },
                })}
              </span>
            );
          }
        }
        return null;
      }
      case "list": {
        const count = parseBrowserTabs(data.tabs).length;
        return (
          <span
            className={`tool-call-browser-meta ${
              count > 0 ? "tool-call-browser-meta-active" : ""
            }`}
          >
            <AppWindow size={10} aria-hidden="true" />
            {t("toolCall.browser.tabCount", { values: { count } })}
          </span>
        );
      }
      default:
        return null;
    }
  })();

  const renderSuccess = (): React.JSX.Element | null => {
    switch (operation) {
      case "create":
        return <CreateView args={parsedArgs} data={data} />;
      case "navigate":
        return <NavigateView args={parsedArgs} data={data} />;
      case "click":
        return <ClickView args={parsedArgs} data={data} />;
      case "screenshot":
        return <ScreenshotView args={parsedArgs} data={data} />;
      case "devtools":
        return <DevtoolsView args={parsedArgs} data={data} />;
      case "close":
      case "focus":
        return (
          <CloseFocusView operation={operation} args={parsedArgs} data={data} />
        );
      case "list":
        return <ListView data={data} />;
      default:
        return null;
    }
  };

  /* 未完成（等待/执行中）时，click / screenshot / devtools / close / focus
     也需要展示参数，让卡片在运行期间就有内容可看。 */
  const showArgsWhilePending =
    parsedResult.type === "empty" &&
    (operation === "click" ||
      operation === "screenshot" ||
      operation === "devtools" ||
      operation === "close" ||
      operation === "focus" ||
      operation === "create" ||
      operation === "navigate");

  return (
    <ToolCallNode
      toolName={toolCall.name}
      category="web"
      displayName={displayName}
      displayNameTitle={
        argUrl ??
        (operation === "click" ? (argSelector ?? argText) : undefined) ??
        asString(data?.instanceId) ??
        argInstanceId
      }
      status={effectiveStatus}
      meta={meta}
      className="tool-call-browser"
    >
      <div className="tool-call-body tool-call-browser-body">
        {parsedResult.type === "success" ? renderSuccess() : null}

        {showArgsWhilePending ? renderSuccess() : null}

        {/* 错误 */}
        {parsedResult.type === "error" ? (
          <div className="tool-call-error">
            <AlertCircle size={12} aria-hidden="true" />
            <span>{parsedResult.message}</span>
          </div>
        ) : null}

        {/* 原始结果兜底 */}
        {parsedResult.type === "raw" ? (
          <section className="tool-call-section">
            <span className="tool-call-section-label">
              {t("toolCall.browser.result")}
            </span>
            <pre className="tool-call-section-pre">{parsedResult.text}</pre>
          </section>
        ) : null}

        {/* 等待 / 执行中 */}
        {parsedResult.type === "empty" ? (
          <PendingBlock
            isRunning={isRunning}
            runningLabel={t(RUNNING_LABEL_KEYS[operation])}
            waitingLabel={t("toolCall.browser.waiting")}
          />
        ) : null}
      </div>
    </ToolCallNode>
  );
};
