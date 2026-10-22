import type { JSX } from "react";
import { AlertCircle } from "lucide-react";
import { useI18n } from "../../../../i18n";
import {
  formatBrowserDisplayJson,
  sanitizeBrowserDisplayValue,
} from "./browserToolPresentation";
import { localizeToolError } from "./shared/toolErrorDisplay";

type BrowserToolErrorProps = { message: string; compact?: boolean };
type ErrorSummary = { key: string; field?: string };

// Only known protocol wrappers are removed, and only from the beginning.
// Never search arbitrary page/evaluate error bodies for matching words.
const unwrapBrowserError = (message: string): string => {
  let result = message.trim();
  for (let index = 0; index < 12; index += 1) {
    const next = result
      .replace(/^Error invoking remote method\s+(['"])[^\r\n]*?\1:\s*/i, "")
      .replace(/^(?:Browser command failed|Error):\s*/i, "")
      .replace(/^(?:GenericFailure|InvalidArg)[:,]\s*/i, "")
      .replace(/^\[(?:GenericFailure|InvalidArg)\]\s*[,：:]?\s*/i, "")
      .trim();
    if (next === result) break;
    result = next;
  }
  return result;
};

// Unsuffixed validation errors are accepted only for actual browser parameters.
const BROWSER_FIELDS = new Set(
  "url reload ignoreCache initScript instanceId frameId selector text ref body promptText x y time textGone selectorGone timeoutMs expression function sourcePath args value elements submit exact dblClick delayMs files values key format quality fullPage action requestId msgid headers status accept dialogResponse filter fromSelector fromText fromRef toSelector toText toRef fromFrameId toFrameId width height viewport geolocation latitude longitude cpuThrottlingRate extraHttpHeaders count offset partition name params filePath durationMs maxLength maxNodes limit pageIdx pageSize static verbose domain state pattern contentType responseFilePath requestFilePath userAgent colorScheme networkConditions maxDurationMs maxFrames maxWidth categories insights insightId nodeIndex className nodeType minSelfSize isDetached sortBy topN baseFilePath currentFilePath deltaY position".split(
    " ",
  ),
);

const summarizeBrowserError = (message: string): ErrorSummary => {
  if (/^FRAME_REF_STALE(?:\s*:|$)/.test(message))
    return { key: "frameRefStale" };
  if (/^FRAME_STALE(?:\s*:|$)/.test(message)) return { key: "frameStale" };
  if (
    /^FRAME_CDP_UNAVAILABLE(?:\s*:|$)/.test(message) ||
    /^(?:Browser debugger|CDP(?: debugger)?) is unavailable(?:[;:.]|$)/i.test(
      message,
    )
  )
    return { key: "debuggerUnavailable" };

  if (
    /^url cannot be combined with reload=true for browser-navigate\.?$/.test(
      message,
    )
  )
    return { key: "navigateConflict" };
  if (
    /^x\/y coordinates are mutually exclusive with selector\/text\/ref for browser-click\.?$/.test(
      message,
    )
  )
    return { key: "coordinateConflict" };
  if (/^x and y must be provided together for browser-click\.?$/.test(message))
    return { key: "coordinatesRequired" };
  if (
    /^time is mutually exclusive with text\/textGone\/selector\/selectorGone for browser-wait\.?$/.test(
      message,
    )
  )
    return { key: "waitConflict" };
  if (
    /^One of time, text, textGone, selector, or selectorGone is required for browser-wait\.?$/.test(
      message,
    )
  )
    return { key: "waitRequired" };
  if (
    /^Either (?:selector, text, (?:ref, or x\+y|or (?:a frame-scoped )?ref)|(?:from|to)Selector, (?:from|to)Text, or (?:from|to)Ref) is required for browser-[\w-]+\.?$/.test(
      message,
    )
  )
    return { key: "targetRequired" };

  const empty =
    /^([A-Za-z][\w.]*) (?:must not be empty|must be a non-empty string)(?: when provided)?\.?$/.exec(
      message,
    );
  if (empty && BROWSER_FIELDS.has(empty[1]))
    return { key: "emptyField", field: empty[1] };
  const required =
    /^([A-Za-z][\w.]*) is required(?: unless reload=true)? for browser-[\w-]+(?: [\w-]+)?(?: unless reload=true)?\.?$/.exec(
      message,
    );
  if (required && BROWSER_FIELDS.has(required[1].split(".")[0]))
    return { key: "requiredField", field: required[1] };
  const type =
    /^([A-Za-z][\w.]*) must be (?:a string|a boolean|a number|an? object|an array(?: of strings)?|a positive integer|an integer)(?:( when provided)| for browser-[\w-]+(?: [\w-]+)?)?\.?$/.exec(
      message,
    );
  if (
    type &&
    (BROWSER_FIELDS.has(type[1].split(".")[0]) ||
      message.includes(" for browser-"))
  )
    return { key: "invalidType", field: type[1] };

  if (
    /^(?:Protocol error \([^\r\n)]+\):\s*)?Document needs to be requested first\.?$/.test(
      message,
    )
  )
    return { key: "documentNotReady" };
  if (/^Page tool not found(?:\s*:|$)/.test(message))
    return { key: "pageToolMissing" };
  if (
    /^(?:Protocol error \([^\r\n)]+\):\s*)?Invalid parameters(?:\s*:|\.?$)/i.test(
      message,
    )
  )
    return { key: "invalidParameters" };
  if (/^No handler registered(?: for\b|$)/i.test(message))
    return { key: "handlerUnavailable" };
  if (/^No embedded browser(?: is available\b|$)/i.test(message))
    return { key: "browserMissing" };
  if (
    /^(?:Browser(?: command| load| screenshot)?|Frame(?: wait)?|browser-[\w-]+) timed out(?:\b|$)/i.test(
      message,
    ) ||
    /^(?:Accessibility audit|Page facts collection|Heap snapshot capture) timed out(?:\b|$)/.test(
      message,
    )
  )
    return { key: "timedOut" };
  if (
    /^(?:Tab not shared with the agent|Tab [^\r\n]+ is not shared with the agent)(?:[.;]|$)/.test(
      message,
    )
  )
    return { key: "sharingRequired" };
  if (
    /^(?:BROWSER_ACCESS_DENIED|BROWSER_PERMISSION_DENIED|BROWSER_SHARE_DENIED)(?:\s*:|$)/.test(
      message,
    ) ||
    /^(?:(?:Browser|Browser agent|Agent browser) access (?:is )?(?:denied|disabled)|(?:Browser )?[Pp]ermission denied|(?:Browser )?[Ss]har(?:e|ing) request (?:was )?denied)(?:[.;:]|$)/.test(
      message,
    ) ||
    /^Browser access for the agent is turned off(?:\s*\(|$)/.test(message) ||
    /^The agent is not allowed to open\s/.test(message)
  )
    return { key: "accessDenied" };
  if (/^Screencast recorded no frames\.?$/.test(message))
    return { key: "noFrames" };
  return { key: "unknown" };
};

/** Display-only localization: neither the stored error nor the model result is modified. */
export const BrowserToolError = ({
  message,
  compact = false,
}: BrowserToolErrorProps): JSX.Element | null => {
  const { t } = useI18n();
  const normalized = unwrapBrowserError(message);
  const localized = localizeToolError(t, normalized);
  // Preserve the shared localizer's empty/denied suppression and known error codes.
  if (!localized) return null;
  const summary = summarizeBrowserError(normalized);
  const title =
    localized !== normalized
      ? localized
      : t(`toolCall.browser.errors.${summary.key}`, {
          values: summary.field ? { field: summary.field } : undefined,
        });
  const safeMessage = sanitizeBrowserDisplayValue(message);
  // The formatter also caps serialized output, including escape-heavy strings.
  const technicalDetails = formatBrowserDisplayJson(safeMessage);

  return (
    <section
      className="tool-call-section"
      style={{ minWidth: 0, gap: compact ? 2 : 4 }}
    >
      <div
        className="tool-call-error"
        style={compact ? { padding: "3px 6px" } : undefined}
      >
        <AlertCircle size={12} aria-hidden="true" />
        <span className="tool-call-error-title">{title}</span>
      </div>
      <details style={{ minWidth: 0 }}>
        <summary
          className="tool-call-section-label"
          style={{ cursor: "pointer", textTransform: "none" }}
        >
          {t("toolCall.browser.errors.technicalDetails")}
        </summary>
        <pre
          className="tool-call-section-pre"
          style={compact ? { maxHeight: 120 } : undefined}
        >
          {technicalDetails}
        </pre>
      </details>
    </section>
  );
};
