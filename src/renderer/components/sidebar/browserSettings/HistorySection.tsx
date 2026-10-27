import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useI18n } from "../../../i18n";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { WebsiteFavicon } from "../../rightPanel/browser/WebsiteFavicon";
import type { BrowserHistoryEntry } from "../../../../preload/modules/systemApi";

/**
 * 浏览器设置面板「历史记录」tab：
 *  - 搜索（标题 / 地址，由 Rust 侧检索排序）+ 页码分页；
 *  - 列表撑满可用高度，内部滚动；
 *  - 单条删除与「全部清空」（二次确认）；
 *  - 点击地址在内置浏览器打开。
 */

/** 每页条数 */
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
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clearConfirm, setClearConfirm] = useState(false);
  const [clearing, setClearing] = useState(false);
  // 连续输入时丢弃过期查询结果（只认最后一次请求）。
  const requestRef = useRef(0);
  const tableWrapRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(
    async (searchQuery: string, targetPage: number): Promise<void> => {
      const requestId = requestRef.current + 1;
      requestRef.current = requestId;
      setBusy(true);
      let result: { items: BrowserHistoryEntry[]; total: number } = {
        items: [],
        total: 0,
      };
      try {
        result = await window.snow.browserHistoryList(
          searchQuery,
          (targetPage - 1) * PAGE_SIZE,
          PAGE_SIZE,
        );
      } catch {
        result = { items: [], total: 0 };
      }
      if (requestId !== requestRef.current) {
        return;
      }
      setEntries(result.items);
      setTotal(result.total);
      setLoading(false);
      setBusy(false);
    },
    [],
  );

  // 打开 tab 立即加载；查询变化防抖后回到第一页重新检索。
  useEffect(() => {
    const timer = window.setTimeout(
      () => {
        setPage(1);
        void load(query, 1);
      },
      query ? SEARCH_DEBOUNCE_MS : 0,
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [query, load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const goToPage = (targetPage: number): void => {
    const clamped = Math.min(Math.max(1, targetPage), totalPages);
    if (clamped === page) {
      return;
    }
    if (tableWrapRef.current) {
      tableWrapRef.current.scrollTop = 0;
    }
    setPage(clamped);
    void load(query, clamped);
  };

  const handleDelete = (entry: BrowserHistoryEntry): void => {
    setDeletingId(entry.id);
    void window.snow
      .browserHistoryDelete(entry.id)
      .then((removed) => {
        if (!removed) {
          return;
        }
        const remaining = entries.filter((item) => item.id !== entry.id);
        setEntries(remaining);
        setTotal((prev) => Math.max(0, prev - 1));
        // 本页删空且不是第一页：退回上一页重新加载。
        if (remaining.length === 0 && page > 1) {
          goToPage(page - 1);
        }
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
      setPage(1);
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
    <div className="browser-settings-section browser-history-section">
      <div className="api-settings-form-section-header">
        <span className="api-settings-form-section-title">
          {t("settings.browserHistory")}
        </span>
        <button
          type="button"
          className="browser-settings-scan-action"
          onClick={() => setClearConfirm(true)}
          disabled={total === 0 || clearing || busy}
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
                <div
                  className={`browser-settings-table-wrap browser-history-table-wrap${
                    busy ? " is-busy" : ""
                  }`}
                  ref={tableWrapRef}
                >
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

              {entries.length > 0 && (
                <div className="browser-history-footer">
                  <span className="browser-history-total">
                    {t("settings.browserHistoryTotal", {
                      values: { count: total },
                      defaultValue: "{{count}} entries",
                    })}
                  </span>
                  <div className="browser-history-pagination">
                    <button
                      type="button"
                      className="browser-history-page-btn"
                      onClick={() => goToPage(page - 1)}
                      disabled={busy || page <= 1}
                      aria-label={t("settings.browserHistoryPrevPage", {
                        defaultValue: "Previous page",
                      })}
                      title={t("settings.browserHistoryPrevPage", {
                        defaultValue: "Previous page",
                      })}
                    >
                      <ChevronLeft size={13} strokeWidth={1.8} />
                    </button>
                    <span className="browser-history-page-info">
                      {t("settings.browserHistoryPageInfo", {
                        values: { current: page, total: totalPages },
                        defaultValue: "Page {{current}} / {{total}}",
                      })}
                    </span>
                    <button
                      type="button"
                      className="browser-history-page-btn"
                      onClick={() => goToPage(page + 1)}
                      disabled={busy || page >= totalPages}
                      aria-label={t("settings.browserHistoryNextPage", {
                        defaultValue: "Next page",
                      })}
                      title={t("settings.browserHistoryNextPage", {
                        defaultValue: "Next page",
                      })}
                    >
                      <ChevronRight size={13} strokeWidth={1.8} />
                    </button>
                  </div>
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
