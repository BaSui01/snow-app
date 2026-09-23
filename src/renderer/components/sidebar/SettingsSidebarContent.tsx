import { ArrowLeft, Search, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useI18n } from "../../i18n";
import { SETTINGS_ITEMS, SETTINGS_VIEW_IDS } from "./settingsItems";
import {
  getSettingsPageItem,
  searchSettingsEntries,
  type SettingsSearchEntry,
  type SettingsSearchTrailItem,
} from "./settingsSearchMap";
import { requestSettingsSearchTarget } from "./settingsSearchNavigation";
import type { MainContentView } from "../mainContent/types";
import type { SidebarContentProps } from "./types";

/**
 * 面板内 tab 直达的视图别名：侧栏仍高亮所属设置项。
 * browser-devices = 浏览器设置面板的「显示尺寸设备」tab；
 * imagegen-settings = API 设置页的「图像生成」tab。
 */
const SETTINGS_VIEW_ALIASES: Partial<Record<MainContentView, MainContentView>> =
  {
    "browser-devices": "browser-settings",
    "imagegen-settings": "api-settings",
  };

type SettingsSearchGroup = {
  view: MainContentView;
  title: string;
  items: { entry: SettingsSearchEntry; index: number }[];
};

export function SettingsSidebarContent({
  activeMainView,
  onSelectMainView,
  onSwitchContent,
}: SidebarContentProps): React.JSX.Element {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const resolveLabel = useCallback(
    (item: SettingsSearchTrailItem): string =>
      item.labelKey
        ? t(item.labelKey, { defaultValue: item.label })
        : item.label,
    [t],
  );

  const isSearching = query.trim().length > 0;

  const results = useMemo(
    () => searchSettingsEntries(query, resolveLabel),
    [query, resolveLabel],
  );

  // 命中设置页本身时以分组标题呈现（点击直达该页），其余条目逐行列出。
  const rows = useMemo(
    () => results.filter((entry) => entry.kind !== "page"),
    [results],
  );

  const groups = useMemo<SettingsSearchGroup[]>(() => {
    const collected = new Map<MainContentView, SettingsSearchGroup>();

    rows.forEach((entry, index) => {
      const group = collected.get(entry.view);

      if (group) {
        group.items.push({ entry, index });
        return;
      }

      const pageItem = getSettingsPageItem(entry.view);

      collected.set(entry.view, {
        view: entry.view,
        title: pageItem
          ? t(pageItem.labelKey, { defaultValue: pageItem.defaultLabel })
          : entry.label,
        items: [{ entry, index }],
      });
    });

    return Array.from(collected.values());
  }, [rows, t]);

  useEffect(() => {
    itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const handleExitSettings = (): void => {
    onSwitchContent("main");

    if (SETTINGS_VIEW_IDS.has(activeMainView)) {
      onSelectMainView("chat");
    }
  };

  const closeSearch = (): void => {
    setQuery("");
    setActiveIndex(0);
    inputRef.current?.focus();
  };

  const handleSelectEntry = (entry: SettingsSearchEntry): void => {
    onSwitchContent("settings");
    onSelectMainView(entry.view);
    requestSettingsSearchTarget({
      view: entry.view,
      trail: entry.trail.map(resolveLabel),
      label: resolveLabel(entry),
    });
    closeSearch();
  };

  const handleSelectPage = (view: MainContentView): void => {
    onSwitchContent("settings");
    onSelectMainView(view);
    closeSearch();
  };

  const handleSearchKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement>,
  ): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSearch();
      return;
    }

    if (rows.length === 0) {
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((previous) => (previous + 1) % rows.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((previous) =>
        previous === 0 ? rows.length - 1 : previous - 1,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      const entry = rows[activeIndex];

      if (entry) {
        handleSelectEntry(entry);
      }
    }
  };

  const renderResult = (
    entry: SettingsSearchEntry,
    itemIndex: number,
  ): React.JSX.Element => {
    const pageItem = getSettingsPageItem(entry.view);
    const Icon = pageItem?.icon;
    const trailLabel = entry.trail.map(resolveLabel).join(" › ");

    return (
      <button
        key={entry.id}
        ref={(element) => {
          itemRefs.current[itemIndex] = element;
        }}
        className={`settings-search-result${
          itemIndex === activeIndex ? " active" : ""
        }`}
        onMouseEnter={() => setActiveIndex(itemIndex)}
        onClick={() => handleSelectEntry(entry)}
        type="button"
      >
        <span className="settings-search-result-icon">
          {Icon ? <Icon size={14} strokeWidth={1.8} /> : null}
        </span>
        <span className="settings-search-result-body">
          <span className="settings-search-result-title">
            {resolveLabel(entry)}
          </span>
          {trailLabel ? (
            <span className="settings-search-result-path">{trailLabel}</span>
          ) : null}
        </span>
      </button>
    );
  };

  return (
    <>
      <div className="sidebar-content-header">
        <button
          className="icon-btn ghost"
          onClick={handleExitSettings}
          type="button"
          aria-label={t("settings.backToMain", {
            defaultValue: "Back to main sidebar",
          })}
        >
          <ArrowLeft size={16} strokeWidth={1.8} />
        </button>
        <span className="sidebar-content-title">
          {t("settings.title", { defaultValue: "Settings" })}
        </span>
      </div>

      <div className="settings-search-bar">
        <Search
          className="settings-search-icon"
          size={14}
          strokeWidth={1.8}
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          className="settings-search-input"
          type="text"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={handleSearchKeyDown}
          placeholder={t("settings.searchPlaceholder", {
            defaultValue: "Search settings",
          })}
          autoComplete="off"
          spellCheck={false}
        />
        {isSearching && (
          <button
            className="icon-btn ghost settings-search-clear"
            type="button"
            onClick={() => {
              setQuery("");
              setActiveIndex(0);
              inputRef.current?.focus();
            }}
            aria-label={t("settings.searchClear", {
              defaultValue: "Clear search",
            })}
            title={t("settings.searchClear", { defaultValue: "Clear search" })}
          >
            <X size={13} strokeWidth={1.9} />
          </button>
        )}
      </div>

      {isSearching ? (
        <div className="settings-search-results">
          {results.length === 0 ? (
            <div className="settings-search-empty">
              {t("settings.searchEmpty", {
                defaultValue: "No matching settings",
              })}
            </div>
          ) : (
            groups.map((group) => {
              const Icon = getSettingsPageItem(group.view)?.icon;

              return (
                <div className="settings-search-group" key={group.view}>
                  <button
                    className="settings-search-group-title"
                    onClick={() => handleSelectPage(group.view)}
                    type="button"
                  >
                    {Icon ? <Icon size={13} strokeWidth={1.8} /> : null}
                    <span>{group.title}</span>
                  </button>
                  {group.items.map(({ entry, index }) =>
                    renderResult(entry, index),
                  )}
                </div>
              );
            })
          )}
        </div>
      ) : (
        <div className="settings-content">
          <div className="sidebar-section settings-menu-section">
            <div className="settings-list">
              {SETTINGS_ITEMS.map((item) => {
                const activeItemView =
                  SETTINGS_VIEW_ALIASES[activeMainView] ?? activeMainView;
                const isActive = item.view === activeItemView;

                return (
                  <button
                    key={item.id}
                    className={`settings-item ${isActive ? "active" : ""}`}
                    onClick={() => onSelectMainView(item.view)}
                    type="button"
                  >
                    <item.icon
                      className="settings-item-icon"
                      size={16}
                      strokeWidth={1.8}
                    />
                    <span className="settings-item-content">
                      <span className="settings-item-title">
                        {t(item.labelKey, { defaultValue: item.defaultLabel })}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
