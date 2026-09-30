import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { History, Star, X } from "lucide-react";
import { WebsiteFavicon } from "./WebsiteFavicon";
import { useI18n } from "../../../i18n";

/** 地址栏下拉建议：历史记录命中 + 未重复的书签命中。 */
export type AddressSuggestion = {
  key: string;
  kind: "history" | "bookmark";
  /** 历史条目 id（书签行不用于删除，留空串） */
  id: string;
  url: string;
  title: string;
  /** 访问次数与最近访问时间（书签行为 0） */
  visitCount: number;
  lastVisitAt: number;
};

export type BrowserAddressSuggestionsProps = {
  /** 地址栏容器：下拉的宽度与水平位置对齐它 */
  anchor: HTMLElement | null;
  suggestions: readonly AddressSuggestion[];
  highlightedIndex: number;
  /** 从历史记录中移除该条（书签行不显示删除按钮） */
  onRemove: (suggestion: AddressSuggestion) => void;
  onHighlight: (index: number) => void;
  onSelect: (suggestion: AddressSuggestion) => void;
};

const MAX_HEIGHT = 268;
const GAP = 4;
const MIN_WIDTH = 300;
const VIEWPORT_MARGIN = 8;

/** 展示用地址：去掉协议前缀与结尾斜杠。 */
const displayUrl = (url: string): string =>
  url.replace(/^https?:\/\//i, "").replace(/\/+$/, "");

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

type DropdownPosition = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  /** 下方空间不足时向上展开（配合 translateY(-100%) 定位） */
  flip: boolean;
};

/**
 * 地址栏补全下拉：portal 到 document.body 的 fixed 定位（与 BrowserMenu
 * 同模式），避免被 `.browser-panel` / `.browser-content` 的 overflow 裁剪。
 * 键盘焦点始终留在地址输入框，行高亮与选中由父组件驱动；容器上的
 * mousedown 一律 preventDefault，防止点击行时输入框失焦。
 */
export const BrowserAddressSuggestions = ({
  anchor,
  suggestions,
  highlightedIndex,
  onRemove,
  onHighlight,
  onSelect,
}: BrowserAddressSuggestionsProps): React.JSX.Element | null => {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<DropdownPosition | null>(null);

  useLayoutEffect(() => {
    if (!anchor) {
      setPosition(null);
      return;
    }
    const compute = (): void => {
      const rect = anchor.getBoundingClientRect();
      const width = Math.max(rect.width, MIN_WIDTH);
      const left = Math.max(
        VIEWPORT_MARGIN,
        Math.min(rect.left, window.innerWidth - VIEWPORT_MARGIN - width),
      );
      const spaceBelow =
        window.innerHeight - rect.bottom - GAP - VIEWPORT_MARGIN;
      const spaceAbove = rect.top - GAP - VIEWPORT_MARGIN;
      const flip = spaceBelow < MAX_HEIGHT && spaceAbove > spaceBelow;
      setPosition({
        top: flip ? rect.top - GAP : rect.bottom + GAP,
        left,
        width,
        maxHeight: Math.max(
          96,
          Math.min(MAX_HEIGHT, flip ? spaceAbove : spaceBelow),
        ),
        flip,
      });
    };
    compute();
    // 窗口尺寸/缩放变化时重新定位（独立窗口可自由缩放）。
    window.addEventListener("resize", compute);
    return () => {
      window.removeEventListener("resize", compute);
    };
  }, [anchor]);

  // 键盘上下移动高亮时保证对应行可见。
  useEffect(() => {
    if (highlightedIndex < 0) {
      return;
    }
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  if (!position) {
    return null;
  }

  return createPortal(
    <div
      ref={listRef}
      id="browser-address-suggestions"
      className="browser-address-suggestions"
      role="listbox"
      aria-label={t("browser.suggestionsTitle")}
      style={{
        top: position.top,
        left: position.left,
        width: position.width,
        maxHeight: position.maxHeight,
        transform: position.flip ? "translateY(-100%)" : undefined,
      }}
      onMouseDown={(e) => {
        // 保住地址输入框的焦点：点击行为完全由 click 事件处理。
        e.preventDefault();
      }}
    >
      {suggestions.map((suggestion, index) => (
        <div
          key={suggestion.key}
          id={`browser-address-suggestion-${index}`}
          role="option"
          aria-selected={index === highlightedIndex}
          className={`browser-address-suggestion${
            index === highlightedIndex ? " is-highlighted" : ""
          }`}
          onMouseMove={() => {
            if (index !== highlightedIndex) {
              onHighlight(index);
            }
          }}
          onClick={() => onSelect(suggestion)}
        >
          <WebsiteFavicon
            url={suggestion.url}
            size={14}
            className="browser-address-suggestion-icon"
          />
          <span className="browser-address-suggestion-main">
            <span className="browser-address-suggestion-title">
              {suggestion.title || hostOf(suggestion.url)}
            </span>
            <span className="browser-address-suggestion-url">
              {displayUrl(suggestion.url)}
            </span>
          </span>
          {suggestion.kind === "history" ? (
            <span
              className="browser-address-suggestion-meta"
              title={t("browser.suggestionVisits", {
                values: { count: suggestion.visitCount },
                defaultValue: "{{count}} visits",
              })}
            >
              <History size={12} strokeWidth={1.8} />
              <span>{suggestion.visitCount}</span>
            </span>
          ) : (
            <span className="browser-address-suggestion-meta">
              <Star size={12} strokeWidth={1.8} />
            </span>
          )}
          {suggestion.kind === "history" && (
            <button
              type="button"
              className="browser-address-suggestion-remove"
              aria-label={t("browser.suggestionRemove")}
              title={t("browser.suggestionRemove")}
              onClick={(e) => {
                e.stopPropagation();
                onRemove(suggestion);
              }}
            >
              <X size={12} strokeWidth={2} />
            </button>
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
};
