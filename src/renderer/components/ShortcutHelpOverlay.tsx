import { Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "./common/Modal";
import { useI18n } from "../i18n";
import { useKeyboardShortcutsSettings } from "./KeyboardShortcutsProvider";
import { shortcutEvents } from "./shortcutEvents";
import {
  SHORTCUT_ACTIONS,
  SHORTCUT_GROUP_ORDER,
  SHORTCUT_META,
  keyToDisplay,
  type ShortcutGroup,
} from "../utils/shortcutUtils";

const GROUP_TITLE_KEYS: Record<
  ShortcutGroup,
  { key: string; fallback: string }
> = {
  conversation: {
    key: "settings.shortcutGroupConversation",
    fallback: "Conversation",
  },
  navigation: {
    key: "settings.shortcutGroupNavigation",
    fallback: "Navigation",
  },
  window: {
    key: "settings.shortcutGroupWindow",
    fallback: "Window & global",
  },
};

/**
 * 快捷键帮助浮层：show-shortcut-help 事件（默认 mod+/）唤起，
 * 与设置面板共用 SHORTCUT_ACTIONS + SHORTCUT_META + 快捷键设置数据源，
 * 改键位后浮层立即同步。
 * 顶部提供搜索：按描述、键位文本或分组名过滤条目。
 */
export function ShortcutHelpOverlay(): React.JSX.Element {
  const { t } = useI18n();
  const { settings, registerScopedHandler } = useKeyboardShortcutsSettings();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return shortcutEvents.on("show-shortcut-help", () => {
      setOpen((prev) => !prev);
    });
  }, []);

  // 浮层打开期间接管 cancelSession（默认 ESC）：只关闭浮层，
  // 绝不冒泡到全局「中断会话」处理器误停 AI 会话。
  useEffect(() => {
    if (!open) return;
    return registerScopedHandler(
      "cancelSession",
      () => setOpen(false),
      () => true,
    );
  }, [open, registerScopedHandler]);

  // 关闭时清空搜索，下次打开回到完整列表；
  // 打开后聚焦搜索框（在 Modal 自身聚焦逻辑之后执行）。
  useEffect(() => {
    if (open) {
      searchInputRef.current?.focus();
    } else {
      setQuery("");
    }
  }, [open]);

  const clearQuery = useCallback(() => {
    setQuery("");
    searchInputRef.current?.focus();
  }, []);

  const groups = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return SHORTCUT_GROUP_ORDER.map((group) => {
      const title = t(GROUP_TITLE_KEYS[group].key, {
        defaultValue: GROUP_TITLE_KEYS[group].fallback,
      });
      // 命中分组名时整组保留
      const groupMatched =
        keyword.length > 0 && title.toLowerCase().includes(keyword);
      const items = SHORTCUT_ACTIONS.filter(
        (action) => SHORTCUT_META[action].group === group,
      )
        .map((action) => {
          const meta = SHORTCUT_META[action];
          const key = settings[action]?.key ?? "";
          return {
            action,
            key,
            keyText: key ? keyToDisplay(key) : "",
            desc: t(meta.descKey, { defaultValue: meta.descDefault }),
          };
        })
        .filter((item) => {
          if (!keyword || groupMatched) return true;
          return (
            item.desc.toLowerCase().includes(keyword) ||
            item.keyText.toLowerCase().includes(keyword) ||
            item.key.toLowerCase().includes(keyword)
          );
        });
      return { group, title, items };
    }).filter((entry) => entry.items.length > 0);
  }, [query, settings, t]);

  const hasResult = groups.length > 0;

  return (
    <Modal
      open={open}
      title={t("settings.shortcutHelpTitle", {
        defaultValue: "Keyboard shortcuts",
      })}
      closeLabel={t("settings.closePanel", { defaultValue: "Close" })}
      onClose={() => setOpen(false)}
      size="large"
      closeOnEscape
      className="shortcut-help-modal"
    >
      <div className="shortcut-help-body">
        <div className="shortcut-help-search">
          <Search
            className="shortcut-help-search-icon"
            size={14}
            strokeWidth={1.8}
            aria-hidden="true"
          />
          <input
            ref={searchInputRef}
            className="shortcut-help-search-input"
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // 输入法组合期间的 ESC 只取消候选，不冒泡关闭浮层
              if (event.nativeEvent.isComposing) {
                event.stopPropagation();
              }
            }}
            placeholder={t("settings.shortcutHelpSearchPlaceholder", {
              defaultValue: "Search shortcuts",
            })}
            aria-label={t("settings.shortcutHelpSearchPlaceholder", {
              defaultValue: "Search shortcuts",
            })}
            autoComplete="off"
            spellCheck={false}
          />
          {query.length > 0 && (
            <button
              className="icon-btn ghost shortcut-help-search-clear"
              type="button"
              onClick={clearQuery}
              aria-label={t("settings.searchClear", {
                defaultValue: "Clear search",
              })}
              title={t("settings.searchClear", {
                defaultValue: "Clear search",
              })}
            >
              <X size={14} strokeWidth={1.9} />
            </button>
          )}
        </div>

        <div className="shortcut-help-content">
          {hasResult ? (
            groups.map(({ group, title, items }) => (
              <section className="shortcut-help-group" key={group}>
                <h3 className="shortcut-help-group-title">{title}</h3>
                <ul className="shortcut-help-list">
                  {items.map((item) => (
                    <li className="shortcut-help-item" key={item.action}>
                      <span className="shortcut-help-key">{item.keyText}</span>
                      <span className="shortcut-help-desc">{item.desc}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          ) : (
            <div className="shortcut-help-empty">
              {t("settings.shortcutHelpSearchEmpty", {
                defaultValue: "No matching shortcuts",
              })}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
