import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  RefreshCw,
  Timer,
  Trash2,
  X,
} from "lucide-react";
import { AutoDismissNotice } from "../../AutoDismissNotice";
import { Modal } from "../../common/Modal";
import { UsageDateFilter } from "../usageSettings/UsageDateFilter";
import { useI18n } from "../../../i18n";
import type { AppLogPage, AppLogRecord } from "../../../../preload";
import type { UsageDatePreset } from "../usageSettings/types";

const PAGE_SIZE = 50;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// 请求日志开启时长（分钟）：默认 10，最小 3，最大 60。
const DURATION_MIN = 3;
const DURATION_MAX = 60;
const DURATION_PRESETS = [3, 5, 10, 15, 30, 60];

const formatCountdown = (ms: number): string => {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(
    2,
    "0"
  )}`;
};

type LogLevelFilter = "" | "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVEL_FILTERS: LogLevelFilter[] = ["", "DEBUG", "INFO", "WARN", "ERROR"];

type SystemLogsPanelProps = {
  onClose?: () => void;
};

const formatDateForInput = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const getMonthStart = (date: Date): Date =>
  new Date(date.getFullYear(), date.getMonth(), 1);

const getMonthEnd = (date: Date): Date =>
  new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);

const getPresetRange = (
  preset: UsageDatePreset,
  now: Date
): { since: Date; until: Date } => {
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  );
  switch (preset) {
    case "today":
      return { since: startOfToday, until: now };
    case "yesterday": {
      const yesterday = new Date(startOfToday.getTime() - ONE_DAY_MS);
      return {
        since: yesterday,
        until: new Date(
          yesterday.getFullYear(),
          yesterday.getMonth(),
          yesterday.getDate(),
          23,
          59,
          59,
          999
        ),
      };
    }
    case "last7days":
      return {
        since: new Date(startOfToday.getTime() - 6 * ONE_DAY_MS),
        until: now,
      };
    case "last30days":
      return {
        since: new Date(startOfToday.getTime() - 29 * ONE_DAY_MS),
        until: now,
      };
    case "thisMonth":
      return { since: getMonthStart(now), until: now };
    case "lastMonth": {
      const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return {
        since: getMonthStart(lastMonthDate),
        until: getMonthEnd(lastMonthDate),
      };
    }
    case "all":
      // 全部日期：不设边界，由调用方将 since/until 置空。
      return { since: now, until: now };
    case "custom":
    default:
      return { since: now, until: now };
  }
};

const formatTime = (value: string): string => {
  if (!value) return "";
  const date = new Date(value.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
};

const formatDate = (value: string): string => {
  if (!value) return "";
  const date = new Date(value.replace(" ", "T"));
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
};

const levelClass = (level: string): string => {
  switch (level) {
    case "DEBUG":
      return "debug";
    case "INFO":
      return "info";
    case "WARN":
      return "warn";
    case "ERROR":
      return "error";
    default:
      return "info";
  }
};

const hasDetail = (record: AppLogRecord): boolean =>
  Boolean(
    record.input ||
      record.output ||
      record.duration ||
      record.context ||
      record.error
  );

export function SystemLogsPanel({
  onClose,
}: SystemLogsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [records, setRecords] = useState<AppLogRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [levelFilter, setLevelFilter] = useState<LogLevelFilter>("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [confirmingClear, setConfirmingClear] = useState(false);
  const clearTimerRef = useRef<number | null>(null);

  const [requestLoggingEnabled, setRequestLoggingEnabled] = useState(false);
  const [showRequestLoggingDialog, setShowRequestLoggingDialog] =
    useState(false);
  const [durationMinutes, setDurationMinutes] = useState(10);
  const [loggingExpiresAt, setLoggingExpiresAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [copiedRowLabel, setCopiedRowLabel] = useState<string | null>(null);
  const copyResetTimerRef = useRef<number | null>(null);

  const [datePreset, setDatePreset] = useState<UsageDatePreset>("today");
  const [sinceDate, setSinceDate] = useState<string>(() =>
    formatDateForInput(getPresetRange("today", new Date()).since)
  );
  const [untilDate, setUntilDate] = useState<string>(() =>
    formatDateForInput(getPresetRange("today", new Date()).until)
  );

  const handlePresetChange = useCallback((preset: UsageDatePreset) => {
    setDatePreset(preset);
    if (preset === "all") {
      // 全部日期：清空日期边界，Rust 端空字符串跳过过滤。
      setSinceDate("");
      setUntilDate("");
    } else if (preset !== "custom") {
      const range = getPresetRange(preset, new Date());
      setSinceDate(formatDateForInput(range.since));
      setUntilDate(formatDateForInput(range.until));
    }
  }, []);

  const handleSinceDateChange = useCallback((value: string) => {
    setSinceDate(value);
    setDatePreset("custom");
  }, []);

  const handleUntilDateChange = useCallback((value: string) => {
    setUntilDate(value);
    setDatePreset("custom");
  }, []);

  const sinceDateTime = useMemo(
    () => (sinceDate ? `${sinceDate} 00:00:00` : ""),
    [sinceDate]
  );
  const untilDateTime = useMemo(
    () => (untilDate ? `${untilDate} 23:59:59` : ""),
    [untilDate]
  );

  const loadLogs = useCallback(
    async (pageOffset: number, level: LogLevelFilter) => {
      setIsLoading(true);
      setError("");
      try {
        const page: AppLogPage = await window.snow.listAppLogs(
          level,
          "",
          sinceDateTime,
          untilDateTime,
          PAGE_SIZE,
          pageOffset
        );
        setRecords(page.items ?? []);
        setTotal(page.total ?? 0);
        setOffset(pageOffset);
        setExpandedIds(new Set());
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : t("settings.systemLogsLoadError", {
                defaultValue: "Failed to load system logs.",
              })
        );
      } finally {
        setIsLoading(false);
      }
    },
    [sinceDateTime, untilDateTime, t]
  );

  useEffect(() => {
    void loadLogs(0, levelFilter);
  }, [loadLogs, levelFilter]);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current !== null) {
        window.clearTimeout(clearTimerRef.current);
      }
      if (copyResetTimerRef.current !== null) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);

  // 挂载时读取开关与过期时间；过期的遗留状态（开着但无有效过期时间）立即复位。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [enabled, expiry] = await Promise.all([
          window.snow.getRequestLogging(),
          window.snow.getRequestLoggingExpiry(),
        ]);
        if (cancelled) return;
        const now = Date.now();
        setNowMs(now);
        if (enabled && (expiry <= 0 || expiry <= now)) {
          setRequestLoggingEnabled(false);
          setLoggingExpiresAt(null);
          void window.snow.setRequestLogging(false).catch(() => undefined);
          void window.snow.setRequestLoggingExpiry(0).catch(() => undefined);
          return;
        }
        setRequestLoggingEnabled(enabled);
        setLoggingExpiresAt(enabled && expiry > 0 ? expiry : null);
      } catch {
        /* 读取失败保持默认关闭状态 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const disableRequestLogging = useCallback(
    async (expired: boolean) => {
      setRequestLoggingEnabled(false);
      setLoggingExpiresAt(null);
      try {
        await window.snow.setRequestLogging(false);
        await window.snow.setRequestLoggingExpiry(0);
        setNotice(
          expired
            ? t("settings.systemLogsRequestLoggingExpired", {
                defaultValue: "Request logging auto-disabled (timer expired).",
              })
            : t("settings.systemLogsRequestLoggingDisabled", {
                defaultValue: "Request logging disabled.",
              })
        );
      } catch (e) {
        setError(
          e instanceof Error
            ? e.message
            : t("settings.systemLogsRequestLoggingError", {
                defaultValue: "Failed to toggle request logging.",
              })
        );
      }
    },
    [t]
  );

  // 倒计时：每秒刷新显示；到点自动关闭（即使 Rust 后端也会强制停写，这里负责 UI 复位）。
  useEffect(() => {
    if (!requestLoggingEnabled || loggingExpiresAt === null) return;
    const tick = () => {
      const now = Date.now();
      setNowMs(now);
      if (now >= loggingExpiresAt) {
        void disableRequestLogging(true);
      }
    };
    tick();
    const intervalId = window.setInterval(tick, 1000);
    return () => window.clearInterval(intervalId);
  }, [requestLoggingEnabled, loggingExpiresAt, disableRequestLogging]);

  const handleRequestLoggingToggle = useCallback(() => {
    if (requestLoggingEnabled) {
      void disableRequestLogging(false);
      return;
    }
    setShowRequestLoggingDialog(true);
  }, [requestLoggingEnabled, disableRequestLogging]);

  const confirmRequestLogging = useCallback(async () => {
    setShowRequestLoggingDialog(false);
    const expiresAt = Date.now() + durationMinutes * 60_000;
    setRequestLoggingEnabled(true);
    setLoggingExpiresAt(expiresAt);
    setNowMs(Date.now());
    try {
      // 先写过期时间再开开关，避免“开关已开但还没有过期时间”的空窗。
      await window.snow.setRequestLoggingExpiry(expiresAt);
      await window.snow.setRequestLogging(true);
      setNotice(
        t("settings.systemLogsRequestLoggingEnabled", {
          defaultValue: "Request logging enabled.",
        })
      );
    } catch (e) {
      setRequestLoggingEnabled(false);
      setLoggingExpiresAt(null);
      setError(
        e instanceof Error
          ? e.message
          : t("settings.systemLogsRequestLoggingError", {
              defaultValue: "Failed to toggle request logging.",
            })
      );
    }
  }, [durationMinutes, t]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  const handleLevelFilter = useCallback((level: LogLevelFilter) => {
    setLevelFilter(level);
  }, []);

  const handleRefresh = useCallback(() => {
    void loadLogs(offset, levelFilter);
  }, [loadLogs, offset, levelFilter]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleCopyText = useCallback((text: string, label: string) => {
    navigator.clipboard.writeText(text).catch(() => undefined);
    setCopiedRowLabel(label);
    if (copyResetTimerRef.current !== null) {
      window.clearTimeout(copyResetTimerRef.current);
    }
    copyResetTimerRef.current = window.setTimeout(() => {
      setCopiedRowLabel(null);
      copyResetTimerRef.current = null;
    }, 2000);
  }, []);

  const handleClear = useCallback(async () => {
    if (!confirmingClear) {
      setConfirmingClear(true);
      clearTimerRef.current = window.setTimeout(() => {
        setConfirmingClear(false);
      }, 3000);
      return;
    }
    if (clearTimerRef.current !== null) {
      window.clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
    setConfirmingClear(false);
    try {
      await window.snow.clearAppLogs();
      setNotice(
        t("settings.systemLogsCleared", {
          defaultValue: "System logs cleared.",
        })
      );
      void loadLogs(0, levelFilter);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.systemLogsClearError", {
              defaultValue: "Failed to clear system logs.",
            })
      );
    }
  }, [confirmingClear, levelFilter, loadLogs, t]);

  const detailRows = useCallback(
    (record: AppLogRecord): { label: string; value: string }[] => {
      const rows: { label: string; value: string }[] = [];
      if (record.input) {
        rows.push({
          label: t("settings.systemLogsDetailInput", { defaultValue: "Input" }),
          value: record.input,
        });
      }
      if (record.output) {
        rows.push({
          label: t("settings.systemLogsDetailOutput", {
            defaultValue: "Output",
          }),
          value: record.output,
        });
      }
      if (record.duration) {
        rows.push({
          label: t("settings.systemLogsDetailDuration", {
            defaultValue: "Duration",
          }),
          value: record.duration,
        });
      }
      if (record.context) {
        rows.push({
          label: t("settings.systemLogsDetailContext", {
            defaultValue: "Context",
          }),
          value: record.context,
        });
      }
      if (record.error) {
        rows.push({
          label: t("settings.systemLogsDetailError", { defaultValue: "Error" }),
          value: record.error,
        });
      }
      return rows;
    },
    [t]
  );

  return (
    <div className="api-settings-page system-logs-page" role="region">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>
            {t("settings.systemLogsTitle", { defaultValue: "System logs" })}
          </strong>
          <span className="settings-item-description">
            {t("settings.systemLogsInfo", {
              defaultValue:
                "Unified diagnostic logs written by the main process and the renderer.",
            })}
          </span>
        </div>
        <div className="system-logs-header-actions">
          <button
            className="icon-btn ghost"
            onClick={handleRefresh}
            type="button"
            disabled={isLoading}
            aria-label={t("settings.systemLogsRefresh", {
              defaultValue: "Refresh logs",
            })}
            title={t("settings.systemLogsRefresh", {
              defaultValue: "Refresh logs",
            })}
          >
            <RefreshCw
              size={15}
              strokeWidth={1.8}
              className={isLoading ? "spin" : ""}
            />
          </button>
          <button
            className={`system-logs-clear-btn${
              confirmingClear ? " confirming" : ""
            }`}
            onClick={() => void handleClear()}
            type="button"
            disabled={total === 0 && !confirmingClear}
          >
            <Trash2 size={14} strokeWidth={1.8} />
            <span>
              {confirmingClear
                ? t("settings.systemLogsClearConfirm", {
                    defaultValue: "Confirm clear",
                  })
                : t("settings.systemLogsClear", { defaultValue: "Clear logs" })}
            </span>
          </button>
          {onClose && (
            <button
              className="icon-btn ghost"
              onClick={onClose}
              type="button"
              aria-label={t("settings.systemLogsClosePanel", {
                defaultValue: "Close system logs",
              })}
              title={t("settings.systemLogsClosePanel", {
                defaultValue: "Close system logs",
              })}
            >
              <X size={15} strokeWidth={1.8} />
            </button>
          )}
        </div>
      </div>

      <AutoDismissNotice
        message={error}
        tone="error"
        onDismiss={() => setError("")}
      />
      <AutoDismissNotice
        message={notice}
        tone="success"
        onDismiss={() => setNotice("")}
      />

      <div className="system-logs-filter-row">
        <div className="system-logs-level-chips" role="tablist">
          {LEVEL_FILTERS.map((level) => (
            <button
              key={level || "all"}
              type="button"
              role="tab"
              aria-selected={levelFilter === level}
              className={`system-logs-level-chip${
                levelFilter === level ? " active" : ""
              }${level ? ` ${levelClass(level)}` : ""}`}
              onClick={() => handleLevelFilter(level)}
            >
              {level ||
                t("settings.systemLogsLevelAll", { defaultValue: "All" })}
            </button>
          ))}
        </div>
      </div>

      <UsageDateFilter
        preset={datePreset}
        sinceDate={sinceDate}
        untilDate={untilDate}
        onPresetChange={handlePresetChange}
        onSinceDateChange={handleSinceDateChange}
        onUntilDateChange={handleUntilDateChange}
      />

      <div className="system-logs-request-logging-row">
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={requestLoggingEnabled}
            onChange={handleRequestLoggingToggle}
          />
          <span className="toggle-slider" />
          <span className="system-logs-request-logging-label">
            {t("settings.systemLogsRequestLogging", {
              defaultValue: "Request logging",
            })}
          </span>
        </label>
        {requestLoggingEnabled && loggingExpiresAt !== null && (
          <span
            className="system-logs-countdown-badge"
            title={t("settings.systemLogsRequestLoggingCountdownTitle", {
              defaultValue:
                "Request logging will auto-disable when the timer ends.",
            })}
          >
            <Timer size={12} strokeWidth={1.9} />
            <span className="system-logs-countdown-time">
              {formatCountdown(Math.max(0, loggingExpiresAt - nowMs))}
            </span>
          </span>
        )}
        <span className="settings-item-description">
          {t("settings.systemLogsRequestLoggingDescription", {
            defaultValue:
              "Record the full raw request JSON of every API call. Very high disk usage.",
          })}
        </span>
      </div>

      <Modal
        open={showRequestLoggingDialog}
        title={t("settings.systemLogsRequestLoggingDialogTitle", {
          defaultValue: "Enable request logging?",
        })}
        description={t("settings.systemLogsRequestLoggingWarning", {
          defaultValue:
            "Request logging records the full raw request JSON of every API call. This has very high disk usage and is not recommended for non-expert users.",
        })}
        closeLabel={t("settings.systemLogsRequestLoggingCancel", {
          defaultValue: "Cancel",
        })}
        onClose={() => setShowRequestLoggingDialog(false)}
        className="request-logging-modal"
        footer={
          <>
            <button
              type="button"
              className="confirm-dialog-btn cancel"
              onClick={() => setShowRequestLoggingDialog(false)}
            >
              {t("settings.systemLogsRequestLoggingCancel", {
                defaultValue: "Cancel",
              })}
            </button>
            <button
              type="button"
              className="confirm-dialog-btn confirm"
              onClick={() => void confirmRequestLogging()}
            >
              {t("settings.systemLogsRequestLoggingConfirm", {
                defaultValue: "Enable",
              })}
            </button>
          </>
        }
      >
        <div className="request-logging-duration">
          <div className="request-logging-duration-head">
            <span className="request-logging-duration-label">
              {t("settings.systemLogsRequestLoggingDuration", {
                defaultValue: "Auto-disable after",
              })}
            </span>
            <span className="request-logging-duration-value">
              {durationMinutes}
              <em>
                {t("settings.systemLogsRequestLoggingMinutes", {
                  defaultValue: "min",
                })}
              </em>
            </span>
          </div>
          <div className="request-logging-duration-presets">
            {DURATION_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                className={`request-logging-duration-preset${
                  durationMinutes === preset ? " active" : ""
                }`}
                onClick={() => setDurationMinutes(preset)}
              >
                {preset}
              </button>
            ))}
          </div>
          <input
            type="range"
            className="request-logging-duration-slider"
            min={DURATION_MIN}
            max={DURATION_MAX}
            step={1}
            value={durationMinutes}
            onChange={(event) => setDurationMinutes(Number(event.target.value))}
            aria-label={t("settings.systemLogsRequestLoggingDuration", {
              defaultValue: "Auto-disable after",
            })}
          />
          <div className="request-logging-duration-scale">
            <span>{DURATION_MIN}</span>
            <span>{DURATION_MAX}</span>
          </div>
          <p className="request-logging-duration-hint">
            {t("settings.systemLogsRequestLoggingAutoOffHint", {
              defaultValue:
                "Logging stops automatically when the timer ends — no need to turn it off manually.",
            })}
          </p>
        </div>
      </Modal>

      <div className="system-logs-stream-section">
        <div className="system-logs-stream-meta">
          <span className="settings-item-description">
            {t("settings.systemLogsTotalInfo", {
              defaultValue: "{{count}} entries",
              values: { count: total.toLocaleString() },
            })}
          </span>
        </div>

        <div className="system-logs-stream" aria-busy={isLoading}>
          {isLoading ? (
            <div className="system-logs-state">
              {t("settings.systemLogsLoading", { defaultValue: "Loading..." })}
            </div>
          ) : records.length === 0 ? (
            <div className="system-logs-state">
              {t("settings.systemLogsEmpty", {
                defaultValue: "No log entries for the current filters.",
              })}
            </div>
          ) : (
            records.map((record) => {
              const expanded = expandedIds.has(record.id);
              const detail = hasDetail(record);
              const rows = detailRows(record);
              return (
                <div
                  key={record.id}
                  className={`system-logs-entry${expanded ? " expanded" : ""}`}
                >
                  <button
                    type="button"
                    className="system-logs-entry-head"
                    onClick={() => detail && toggleExpand(record.id)}
                    aria-expanded={detail ? expanded : undefined}
                  >
                    <span className="system-logs-entry-time">
                      <span className="system-logs-entry-date">
                        {formatDate(record.createdAt)}
                      </span>
                      <span className="system-logs-entry-clock">
                        {formatTime(record.createdAt)}
                      </span>
                    </span>
                    <span
                      className={`system-logs-level-badge ${levelClass(
                        record.level
                      )}`}
                    >
                      {record.level}
                    </span>
                    <span
                      className={`system-logs-source-tag ${
                        record.source === "renderer" ? "renderer" : "main"
                      }`}
                    >
                      {record.source}
                    </span>
                    <span
                      className="system-logs-entry-location"
                      title={`${record.module}:${record.func}${
                        record.line !== undefined && record.line !== null
                          ? `:${record.line}`
                          : ""
                      }`}
                    >
                      {record.module}
                      {record.func ? `.${record.func}` : ""}
                    </span>
                    <span className="system-logs-entry-message">
                      {record.message || "-"}
                    </span>
                    {detail && (
                      <ChevronDown
                        size={14}
                        strokeWidth={1.8}
                        className="system-logs-entry-chevron"
                      />
                    )}
                  </button>
                  {detail && expanded && (
                    <div className="system-logs-entry-detail">
                      {rows.map((row) => (
                        <div key={row.label} className="system-logs-detail-row">
                          <div className="system-logs-detail-label-row">
                            <span className="system-logs-detail-label">
                              {row.label}
                            </span>
                            <button
                              type="button"
                              className={`system-logs-detail-copy-btn${
                                copiedRowLabel === row.label ? " copied" : ""
                              }`}
                              onClick={() =>
                                handleCopyText(row.value, row.label)
                              }
                              aria-label={t("settings.systemLogsCopy", {
                                defaultValue: "Copy",
                              })}
                              title={t("settings.systemLogsCopy", {
                                defaultValue: "Copy",
                              })}
                            >
                              {copiedRowLabel === row.label ? (
                                <Check size={12} strokeWidth={1.8} />
                              ) : (
                                <Copy size={12} strokeWidth={1.8} />
                              )}
                            </button>
                          </div>
                          <span className="system-logs-detail-value">
                            {row.value}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {total > PAGE_SIZE && (
          <div className="usage-pagination">
            <button
              className="usage-pagination-btn"
              onClick={() =>
                void loadLogs(Math.max(0, offset - PAGE_SIZE), levelFilter)
              }
              disabled={offset === 0 || isLoading}
              type="button"
              aria-label={t("settings.systemLogsPrevPage", {
                defaultValue: "Previous page",
              })}
            >
              <ChevronLeft size={16} strokeWidth={1.8} />
            </button>
            <span className="usage-pagination-info">
              {t("settings.systemLogsPageInfo", {
                defaultValue: "Page {{current}} of {{total}}",
                values: { current: currentPage, total: totalPages },
              })}
            </span>
            <button
              className="usage-pagination-btn"
              onClick={() =>
                void loadLogs(
                  Math.min((totalPages - 1) * PAGE_SIZE, offset + PAGE_SIZE),
                  levelFilter
                )
              }
              disabled={currentPage >= totalPages || isLoading}
              type="button"
              aria-label={t("settings.systemLogsNextPage", {
                defaultValue: "Next page",
              })}
            >
              <ChevronRight size={16} strokeWidth={1.8} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
