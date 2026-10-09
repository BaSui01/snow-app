import { useCallback, useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2, Search, Trash2, X } from "lucide-react";
import { useI18n } from "../../../i18n";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { WebsiteFavicon } from "../../rightPanel/browser/WebsiteFavicon";
import type { BrowserHistoryEntry } from "../../../../preload/modules/systemApi";

/**
 * 浏览器设置面板「历史记录」tab：
 *  - 搜索（标题 / 地址，由 Rust 侧检索排序）+ 分页加载；
 *  - 单条删除与「全部清空」（二次确认）；
 *  - 点击地址在内置浏览器打开。
 */

const PAGE_SIZE = 50;
/** 输入防抖：避免逐字符触发检索 */
const SEARCH_DEBOUNCE_MS = 200;

const displayUrl = (url: string): string =>
  url.replace(/^https?:\/\//i, "").replace(/\/+$/, "");

export function HistorySection(): React.JSX.Element {
  const { locale, t } = useI18n();
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<BrowserHistoryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  // 连续输入时丢弃过期查询结果（只认最后一次请求）。
  const requestRef = useRef(0);

  const load = useCallback(
    async (searchQuery: string, offset: number): Promise<void> => {
      const requestId = requestRef.current + 1;
      requestRef.current = requestId;
      if (offset === 0) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      let page: { items: BrowserHistoryEntry[]; total: number } = {
        items: [],
        total: 0,
      };
      try {
        page = await window.snow.browserHistoryList(
          searchQuery,
          offset,
          PAGE_SIZE,
        );
      } catch {
        page = { items: [], total: 0 };
      }
      if (requestId !== requestRef.current) {
        return;
      }
      setEntries((prev) =>
        offset === 0 ? page.items : [...prev, ...page.items],
      );
      setTotal(page.total);
      setLoading(false);
      setLoadingMore(false);
    },
    [],
  );

  // 打开 tab 立即加载；查询变化防抖后重新检索。
  useEffect(() => {
    const timer = window.setTimeout(
      () => {
        void load(query, 0);
      },
      query ? SEARCH_DEBOUNCE_MS : 0,
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [query, load]);

  const handleDelete = (entry: BrowserHistoryEntry): void => {
    setDeletingId(entry.id);
    void window.snow
      .browserHistoryDelete(entry.id)
      .then((removed) => {
        if (!removed) {
          return;
        }
        setEntries((prev) => prev.filter((item) => item.id !== entry.id));
        setTotal((prev) => Math.max(0, prev - 1));
      })
      .catch(() => {})
      .finally(() => setDeletingId(null));
  };

  const handleClearAll = async (): Promise<void> => {
    setClearing(true);
    try {
      await window.snow.browserHistoryClear();
      setEntries([]);
      setTotal(0);
    } catch {
      // 清空失败：保留现有列表，用户可重试
    } finally {
      setClearing(false);
      setClearConfirm(false);
    }
  };

  const handleOpen = (url: string): void => {
    window.snow.openBrowserTabInMainWindow({ url });
  };

  return (
    <div className="browser-settings-section">
      <div className="api-settings-form-section-header">
        <span className="api-settings-form-section-title">
          {t("settings.browserHistory")}
        </span>
        <button
          type="button"
          className="browser-settings-scan-action"
          onClick={() => setClearConfirm(true)}
          disabled={total === 0 || clearing}
        >
          <Trash2 size={13} strokeWidth={1.8} />
          <span>{t("settings.browserHistoryClearAll")}</span>
        </button>
      </div>

      <div className="api-settings-manual-form">
        <div className="api-settings-manual-header">
          <strong>{t("settings.browserHistoryManageTitle")}</strong>
          <span>{t("settings.browserHistoryHint")}</span>
        </div>

        <div className="api-settings-form-body">
          {loading ? (
            <div className="browser-settings-loading">
              <Loader2 size={16} strokeWidth={1.8} className="spin" />
            </div>
          ) : total === 0 && !query ? (
            <div className="browser-settings-empty">
              {t("settings.browserHistoryEmpty")}
            </div>
          ) : (
            <>
              <div className="browser-settings-search-row">
                <Search size={13} strokeWidth={1.8} />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("settings.browserHistorySearch")}
                  spellCheck={false}
                />
                {query && (
                  <button
                    type="button"
                    className="browser-settings-search-clear"
                    onClick={() => setQuery("")}
                    aria-label={t("common.clear", { defaultValue: "Clear" })}
                    title={t("common.clear", { defaultValue: "Clear" })}
                  >
                    <X size={13} strokeWidth={1.8} />
                  </button>
                )}
                {query && (
                  <span className="browser-settings-search-count">{total}</span>
                )}
              </div>

              {entries.length === 0 ? (
                <div className="browser-settings-empty">
                  {t("settings.browserHistorySearchEmpty")}
                </div>
              ) : (
                <div className="browser-settings-table-wrap">
                  <table className="browser-settings-table">
                    <thead>
                      <tr>
                        <th>{t("settings.browserHistoryTitle")}</th>
                        <th>{t("settings.browserHistoryUrl")}</th>
                        <th>{t("settings.browserHistoryVisitedAt")}</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map((entry) => (
                        <tr key={entry.id}>
                          <td className="browser-history-title-cell">
                            <WebsiteFavicon
                              url={entry.url}
                              size={13}
                              className="browser-history-favicon"
                            />
                            <span
                              className="browser-settings-table-host browser-history-title"
                              title={entry.title || entry.url}
                            >
                              {entry.title || displayUrl(entry.url)}
                            </span>
                          </td>
                          <td className="browser-history-url-cell">
                            <button
                              type="button"
                              className="browser-history-url"
                              onClick={() => handleOpen(entry.url)}
                              title={entry.url}
                            >
                              {displayUrl(entry.url)}
                            </button>
                          </td>
                          <td className="browser-history-time-cell">
                            {new Date(entry.lastVisitAt).toLocaleString(locale)}
                            <span className="browser-history-visits">
                              {` · ${t("settings.browserHistoryVisitCount", {
                                values: { count: entry.visitCount },
                                defaultValue: "{{count}} visits",
                              })}`}
                            </span>
                          </td>
                          <td className="browser-settings-table-actions">
                            <button
                              type="button"
                              className="browser-settings-icon-btn"
                              onClick={() => handleOpen(entry.url)}
                              aria-label={t("settings.browserHistoryOpen")}
                              title={t("settings.browserHistoryOpen")}
                            >
                              <ExternalLink size={13} strokeWidth={1.8} />
                            </button>
                            <button
                              type="button"
                              className="browser-settings-icon-btn is-danger"
                              onClick={() => handleDelete(entry)}
                              disabled={deletingId === entry.id}
                              aria-label={t("settings.browserHistoryDeleteOne")}
                              title={t("settings.browserHistoryDeleteOne")}
                            >
                              {deletingId === entry.id ? (
                                <Loader2
                                  size={13}
                                  strokeWidth={1.8}
                                  className="spin"
                                />
                              ) : (
                                <Trash2 size={13} strokeWidth={1.8} />
                              )}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {entries.length < total && (
                <div className="api-settings-actions browser-settings-actions">
                  <button
                    type="button"
                    className="api-settings-action-btn"
                    onClick={() => void load(query, entries.length)}
                    disabled={loadingMore}
                  >
                    {loadingMore ? (
                      <Loader2 size={15} className="spin" />
                    ) : null}
                    <span>{t("settings.browserHistoryLoadMore")}</span>
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={clearConfirm}
        title={t("settings.browserHistoryClearTitle")}
        message={t("settings.browserHistoryClearMessage")}
        confirmLabel={t("settings.browserHistoryClearAll")}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        variant="danger"
        isConfirming={clearing}
        onConfirm={() => void handleClearAll()}
        onCancel={() => setClearConfirm(false)}
      />
    </div>
  );
}
