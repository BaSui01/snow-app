import { ChevronDown, ChevronUp } from "lucide-react";
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useI18n } from "../../../../i18n";
import { HoverCopyButton } from "../../../common/HoverCopyButton";

// 行内代码 / Windows 路径 / 多段或 ./ ~/ 开头的 POSIX 路径
const INLINE_CODE_RE =
  /`[^`\n]+`|[A-Za-z]:[\\/][^\s`'"，。；：、（）()<>]*|(?:~|\.{1,2})\/[\w.@/-]+|\/[\w.@-]+(?:\/[\w.@-]+)+\/?/g;

// 命令行（整行等宽）
const COMMAND_LINE_RE =
  /^\s*(?:\$\s|>\s|(?:npm|npx|pnpm|yarn|cargo|git|node|python3?|pip3?|cd|ls|rm|mv|cp|mkdir|docker|make|go|bash|sh)\s)/;

/** 把一行文本中的路径/行内代码渲染为等宽片段。 */
export const renderPromptInline = (
  line: string,
  keyPrefix = "",
): ReactNode[] => {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const match of line.matchAll(INLINE_CODE_RE)) {
    const index = match.index ?? 0;
    const value = match[0];
    const isBacktick = value.startsWith("`");
    // 前一字符为单词字符时不是独立路径（如 a/b/c、https://）
    if (!isBacktick && index > 0 && /\w/.test(line[index - 1])) continue;
    if (index > last) nodes.push(line.slice(last, index));
    nodes.push(
      <code key={`${keyPrefix}${index}`} className="prompt-inline-code">
        {isBacktick ? value.slice(1, -1) : value}
      </code>,
    );
    last = index + value.length;
  }
  if (last < line.length) nodes.push(line.slice(last));
  return nodes;
};

export const isPromptCommandLine = (line: string): boolean =>
  COMMAND_LINE_RE.test(line);

/** 提示词规模：字符数与行数。 */
export const getPromptStats = (
  text: string,
): { chars: number; lines: number } => ({
  chars: Array.from(text).length,
  lines: text ? text.split("\n").length : 0,
});

type PromptPreviewProps = {
  text: string;
  label?: string;
  /** 收起时显示的行数 */
  collapsedLines?: number;
  className?: string;
};

/** 只读提示词块：规模提示 + 展开/收起 + 复制，保留换行并突出路径/命令。 */
export const PromptPreview = ({
  text,
  label,
  collapsedLines = 3,
  className,
}: PromptPreviewProps): React.JSX.Element => {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const normalized = useMemo(() => text.replace(/\r\n/g, "\n"), [text]);
  const lines = useMemo(() => normalized.split("\n"), [normalized]);
  const stats = useMemo(() => getPromptStats(normalized), [normalized]);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || expanded) return;
    const measure = (): void => {
      setOverflowing(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [normalized, expanded]);

  const canToggle = expanded || overflowing;
  const rootClassName = [
    "prompt-preview",
    expanded ? "is-expanded" : "",
    !expanded && overflowing ? "is-overflowing" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={rootClassName}
      style={{ "--prompt-preview-lines": collapsedLines } as CSSProperties}
    >
      <div className="prompt-preview-head">
        <span className="prompt-preview-label">
          {label ?? t("chat.promptPreview.label")}
        </span>
        <span className="prompt-preview-stats">
          {t("chat.promptPreview.stats", {
            values: { chars: stats.chars, lines: stats.lines },
          })}
        </span>
        <span className="prompt-preview-actions">
          {canToggle ? (
            <button
              type="button"
              className="prompt-preview-toggle"
              aria-expanded={expanded}
              onClick={() => setExpanded((prev) => !prev)}
            >
              {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              {expanded ? t("chat.message.collapse") : t("chat.message.expand")}
            </button>
          ) : null}
          <HoverCopyButton
            text={normalized}
            className="prompt-preview-copy"
            label={t("common.copy")}
          />
        </span>
      </div>
      <div ref={bodyRef} className="prompt-preview-body">
        {lines.map((line, index) =>
          line.trim() ? (
            <div
              key={index}
              className={`prompt-preview-line${
                isPromptCommandLine(line) ? " is-command" : ""
              }`}
            >
              {renderPromptInline(line, `${index}-`)}
            </div>
          ) : (
            <div
              key={index}
              className="prompt-preview-gap"
              aria-hidden="true"
            />
          ),
        )}
      </div>
    </div>
  );
};
