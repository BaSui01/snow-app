import {
  Archive,
  Check,
  CheckSquare,
  ListChecks,
  Loader2,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useI18n } from "../../i18n";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { CustomSelect } from "../common/CustomSelect";
import { Modal } from "../common/Modal";
import type {
  MemoryKind,
  MemoryPage,
  MemoryRecord,
  MemoryStats,
  MemoryStatus,
} from "../../../preload";

const PAGE_SIZE = 30;

/** 关键词输入的防抖时长：停顿后才发起检索，避免逐字打满 IPC。 */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * /memory 面板「在项目记忆中定位」请求打开记忆库时携带的载荷：
 * 目标条目标题作为初始检索词。
 */
export type MemoryModalOpenDetail = {
  query: string;
};

/** /memory 面板请求打开记忆库并定位某条记忆的窗口事件。 */
export const OPEN_MEMORY_MODAL_EVENT = "project-memory:open-modal";

const KIND_KEYS: MemoryKind[] = [
  "fact",
  "decision",
  "preference",
  "pitfall",
  "task_state",
];

const STATUS_KEYS: MemoryStatus[] = ["active", "pending", "archived"];

const IMPORTANCE_LEVELS = [1, 2, 3, 4, 5];

type MemoryFilterStatus = "all" | MemoryStatus;
type MemoryFilterKind = "all" | MemoryKind;

/** 编辑表单的字段值（新建与编辑共用）。 */
type MemoryDraft = {
  title: string;
  content: string;
  kind: MemoryKind;
  importance: number;
  status: MemoryStatus;
  tags: string;
};

type MemoryModalProps = {
  open: boolean;
  directoryId: string;
  /**
   * 由 /memory 面板「在项目记忆中定位」传入的初始检索词；
   * 弹窗打开时把关键词填进搜索框并立即检索。
   */
  searchSeed?: string | null;
  onClose: () => void;
};

/** 转义正则元字符，用于把关键词安全地拼成高亮匹配模式。 */
const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 命中高亮：把关键词（整句 + 分词）在文本中的出现位置包成 <mark>。
 * 利用带捕获组的 split 特性——奇数下标即为命中片段。
 */
const HighlightedText = ({
  text,
  query,
}: {
  text: string;
  query: string;
}): React.JSX.Element => {
  const terms = [...new Set([query, ...query.split(/\s+/)])].filter(
    (term) => term.trim() !== "",
  );
  if (terms.length === 0) {
    return <>{text}</>;
  }
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  return (
    <>
      {text.split(pattern).map((part, index) =>
        index % 2 === 1 ? (
          <mark className="memory-search-mark" key={`${part}-${index}`}>
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
};

/**
 * 截取命中关键词附近的内容片段，让命中内容（而非标题）的条目也能被
 * 一眼看到；无命中返回 null（该条目的命中只可能来自标签）。
 */
const buildContentSnippet = (content: string, query: string): string | null => {
  const normalized = content.replace(/\s+/g, " ").trim();
  const lower = normalized.toLowerCase();
  const terms = [
    ...new Set([query.toLowerCase(), ...query.toLowerCase().split(/\s+/)]),
  ]
    .map((term) => term.trim())
    .filter((term) => term !== "");
  let hitIndex = -1;
  for (const term of terms) {
    const at = lower.indexOf(term);
    if (at < 0) continue;
    hitIndex = hitIndex < 0 ? at : Math.min(hitIndex, at);
  }
  if (hitIndex < 0) {
    return null;
  }
  const SNIPPET_LENGTH = 90;
  const offset = Math.max(0, hitIndex - 20);
  const snippet = normalized.slice(offset, offset + SNIPPET_LENGTH);
  return `${offset > 0 ? "…" : ""}${snippet}${
    offset + SNIPPET_LENGTH < normalized.length ? "…" : ""
  }`;
};

const draftFromRecord = (record: MemoryRecord): MemoryDraft => ({
  title: record.title,
  content: record.content,
  kind: (record.kind as MemoryKind) ?? "fact",
  importance: record.importance,
  status: (record.status as MemoryStatus) ?? "active",
  tags: record.tags.join(", "),
});

const emptyDraft = (): MemoryDraft => ({
  title: "",
  content: "",
  kind: "fact",
  importance: 2,
  status: "active",
  tags: "",
});

/** 当前正在编辑/查看的条目（来自列表）。 */
type Selection =
  | { mode: "none" }
  | { mode: "create" }
  | { mode: "edit"; record: MemoryRecord };

/**
 * 项目记忆管理弹窗：双栏布局（左侧筛选 + 列表，右侧详情编辑），
 * 参照 MemoModal 的成熟交互。浏览/新建/编辑/删除当前项目的持久记忆。
 */
export function MemoryModal({
  open,
  directoryId,
  searchSeed,
  onClose,
}: MemoryModalProps): React.JSX.Element {
  const { t } = useI18n();
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [filterStatus, setFilterStatus] = useState<MemoryFilterStatus>("all");
  const [filterKind, setFilterKind] = useState<MemoryFilterKind>("all");
  const [searchInput, setSearchInput] = useState("");
  /** 已生效的检索词（防抖后）；非空时列表走关键词检索而非分页浏览。 */
  const [activeQuery, setActiveQuery] = useState("");
  const [hitTotal, setHitTotal] = useState(0);
  const [selection, setSelection] = useState<Selection>({ mode: "none" });
  const [draft, setDraft] = useState<MemoryDraft>(emptyDraft());
  const [isSaving, setIsSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MemoryRecord | null>(null);
  const [isClearConfirmOpen, setIsClearConfirmOpen] = useState(false);
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [selectedMemoryIds, setSelectedMemoryIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [isBatchDeleting, setIsBatchDeleting] = useState(false);
  const [isBatchDeleteConfirmOpen, setIsBatchDeleteConfirmOpen] =
    useState(false);

  const requestIdRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const listScrollRef = useRef<HTMLDivElement>(null);

  const refreshStats = useCallback(() => {
    if (!directoryId) return;
    window.snow
      .getProjectMemoryStats(directoryId)
      .then(setStats)
      .catch(() => undefined);
  }, [directoryId]);

  const loadPage = useCallback(
    (offset: number, append: boolean) => {
      if (!directoryId) return;
      const requestId = ++requestIdRef.current;
      if (append) {
        setIsLoadingMore(true);
      } else {
        setIsLoading(true);
      }
      const statusFilter = filterStatus === "all" ? undefined : filterStatus;
      const kindFilter = filterKind === "all" ? undefined : filterKind;
      // 非空检索词走关键词检索（与 AI memory-search 同一套相关性排序），
      // 命中总数用于「共 N 条命中」提示；空检索词沿用浏览分页。
      const request: Promise<MemoryPage> = activeQuery
        ? window.snow.searchProjectMemories(
            directoryId,
            activeQuery,
            PAGE_SIZE,
            offset,
            statusFilter,
            kindFilter,
          )
        : window.snow.listProjectMemories(
            directoryId,
            PAGE_SIZE,
            offset,
            statusFilter,
            kindFilter,
          );
      request
        .then((page: MemoryPage) => {
          if (requestId !== requestIdRef.current) return;
          setMemories((prev) => {
            if (!append) return page.items;
            // 极端时序下同一页可能被请求两次，按 memoryId 去重防止重复条目
            const known = new Set(prev.map((item) => item.memoryId));
            return [
              ...prev,
              ...page.items.filter((item) => !known.has(item.memoryId)),
            ];
          });
          setHasMore(page.hasMore);
          setHitTotal(activeQuery ? page.total : 0);
        })
        .catch(() => {
          if (requestId === requestIdRef.current && !append) {
            setMemories([]);
            setHasMore(false);
            setHitTotal(0);
          }
        })
        .finally(() => {
          if (requestId === requestIdRef.current) {
            setIsLoading(false);
            setIsLoadingMore(false);
          }
          // 被竞态丢弃的旧请求也要释放加载锁，否则滚动加载会永久卡死
          loadingMoreRef.current = false;
        });
    },
    [directoryId, filterStatus, filterKind, activeQuery],
  );

  // 打开或筛选/关键词变化时重新加载第一页
  useEffect(() => {
    if (!open) return;
    setSelection({ mode: "none" });
    loadPage(0, false);
    refreshStats();
  }, [open, loadPage, refreshStats]);

  // 切换项目时清空检索与详情选择：记忆按项目隔离，旧关键词在新项目里无意义。
  useEffect(() => {
    setSearchInput("");
    setActiveQuery("");
    setHitTotal(0);
    setSelection({ mode: "none" });
  }, [directoryId]);

  // 由 /memory 面板跳转而来：把目标条目标题作为初始检索词直接生效。
  // 与「打开即加载」分开，避免用旧检索条件多查一次。
  useEffect(() => {
    if (!open || searchSeed == null) return;
    setSearchInput(searchSeed);
    setActiveQuery(searchSeed.trim());
  }, [open, searchSeed]);

  // 关键词防抖：输入停顿后才发起检索；清空立即回到浏览列表。
  useEffect(() => {
    const trimmed = searchInput.trim();
    if (trimmed === activeQuery) return;
    const timer = window.setTimeout(
      () => setActiveQuery(trimmed),
      trimmed === "" ? 0 : SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [searchInput, activeQuery]);

  // 关闭弹窗时重置多选与检索状态（下次打开从干净状态开始）
  useEffect(() => {
    if (open) return;
    setIsMultiSelectMode(false);
    setSelectedMemoryIds(new Set());
    setIsBatchDeleteConfirmOpen(false);
    setSearchInput("");
    setActiveQuery("");
    setHitTotal(0);
  }, [open]);

  const handleListScroll = () => {
    const el = listScrollRef.current;
    if (!el || !hasMore || isLoadingMore || loadingMoreRef.current) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 60) return;
    loadingMoreRef.current = true;
    loadPage(memories.length, true);
  };

  const handleStartCreate = () => {
    setSelection({ mode: "create" });
    setDraft(emptyDraft());
  };

  const handleSelect = (record: MemoryRecord) => {
    if (
      selection.mode === "edit" &&
      selection.record.memoryId === record.memoryId
    ) {
      setSelection({ mode: "none" });
      return;
    }
    setSelection({ mode: "edit", record });
    setDraft(draftFromRecord(record));
  };

  const handleCancelEdit = () => setSelection({ mode: "none" });

  const handleSave = async () => {
    const title = draft.title.trim();
    const content = draft.content.trim();
    if (!title || !content || isSaving) return;
    const tags = draft.tags
      .split(",")
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean);

    setIsSaving(true);
    try {
      if (selection.mode === "create") {
        await window.snow.createProjectMemory(
          directoryId,
          draft.kind,
          title,
          content,
          draft.importance,
          tags,
        );
      } else if (selection.mode === "edit") {
        await window.snow.updateProjectMemory(selection.record.memoryId, {
          kind: draft.kind,
          title,
          content,
          importance: draft.importance,
          status: draft.status,
          tags,
        });
      }
      setSelection({ mode: "none" });
      loadPage(0, false);
      refreshStats();
    } catch {
      // 保持编辑状态，用户可重试
    } finally {
      setIsSaving(false);
    }
  };

  const confirmDelete = async () => {
    const record = deleteTarget;
    setDeleteTarget(null);
    if (!record) return;
    try {
      await window.snow.deleteProjectMemory(record.memoryId);
      if (
        selection.mode === "edit" &&
        selection.record.memoryId === record.memoryId
      ) {
        setSelection({ mode: "none" });
      }
      loadPage(0, false);
      refreshStats();
    } catch {
      // Ignore
    }
  };

  const confirmClear = async () => {
    setIsClearConfirmOpen(false);
    if (!directoryId) return;
    try {
      await window.snow.clearProjectMemories(directoryId);
      setSelection({ mode: "none" });
      loadPage(0, false);
      refreshStats();
    } catch {
      // Ignore
    }
  };

  // ---------------------------------------------------------------------
  // 多选删除
  // ---------------------------------------------------------------------
  const handleEnterMultiSelect = () => {
    setIsMultiSelectMode(true);
    setSelection({ mode: "none" });
  };

  const handleExitMultiSelect = () => {
    setIsMultiSelectMode(false);
    setSelectedMemoryIds(new Set());
  };

  const handleToggleSelect = (memoryId: string) => {
    setSelectedMemoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(memoryId)) {
        next.delete(memoryId);
      } else {
        next.add(memoryId);
      }
      return next;
    });
  };

  // 全选只覆盖当前已加载条目（按钮文案同步为「全选已加载」）；
  // 滚动加载进来的新条目需要再次点击才能纳入选择。
  const isAllSelected =
    memories.length > 0 &&
    memories.every((item) => selectedMemoryIds.has(item.memoryId));

  const handleToggleSelectAll = () => {
    setSelectedMemoryIds(
      isAllSelected
        ? new Set()
        : new Set(memories.map((item) => item.memoryId)),
    );
  };

  const confirmBatchDelete = async () => {
    setIsBatchDeleteConfirmOpen(false);
    if (isBatchDeleting || selectedMemoryIds.size === 0) return;
    setIsBatchDeleting(true);
    try {
      await window.snow.deleteProjectMemoriesByIds([...selectedMemoryIds]);
      setSelectedMemoryIds(new Set());
      loadPage(0, false);
      refreshStats();
    } catch {
      // Ignore
    } finally {
      setIsBatchDeleting(false);
    }
  };

  const kindLabel = (kind: string) =>
    t(`memory.kind.${kind}`, {
      defaultValue:
        kind === "fact"
          ? "Fact"
          : kind === "decision"
            ? "Decision"
            : kind === "preference"
              ? "Preference"
              : kind === "pitfall"
                ? "Pitfall"
                : "Task State",
    });

  const statusLabel = (status: string) =>
    status === "pending"
      ? t("memory.statusPending", { defaultValue: "Pending" })
      : status === "archived"
        ? t("memory.statusArchived", { defaultValue: "Archived" })
        : t("memory.statusActive", { defaultValue: "Active" });

  // ---------------------------------------------------------------------
  // 左栏：筛选 + 统计 + 列表
  // ---------------------------------------------------------------------
  const renderSidebar = () => (
    <div className="memo-sidebar memory-sidebar">
      <div className="memo-sidebar-header">
        {isMultiSelectMode ? (
          <>
            <button
              className="memory-multi-select-exit-btn"
              disabled={isBatchDeleting}
              onClick={handleExitMultiSelect}
              title={t("memory.multiSelectExit", {
                defaultValue: "Exit multi-select",
              })}
              type="button"
            >
              <X size={14} strokeWidth={2} />
            </button>
            <span className="memory-multi-select-count">
              {t("memory.multiSelectCount", {
                defaultValue: "{{count}} selected",
                values: { count: selectedMemoryIds.size },
              })}
            </span>
            <div className="memory-multi-select-actions">
              <button
                className="memory-multi-select-action-btn"
                disabled={isBatchDeleting}
                onClick={handleToggleSelectAll}
                type="button"
              >
                <CheckSquare size={13} />
                <span>
                  {isAllSelected
                    ? t("memory.multiSelectDeselectAll", {
                        defaultValue: "Deselect all",
                      })
                    : t("memory.multiSelectAll", {
                        defaultValue: "Select all",
                      })}
                </span>
              </button>
              <button
                className="memory-multi-select-action-btn danger"
                disabled={isBatchDeleting || selectedMemoryIds.size === 0}
                onClick={() => setIsBatchDeleteConfirmOpen(true)}
                type="button"
              >
                {isBatchDeleting ? (
                  <Loader2 className="spin" size={13} />
                ) : (
                  <Trash2 size={13} />
                )}
                <span>
                  {isBatchDeleting
                    ? t("memory.multiSelectDeleting", {
                        defaultValue: "Deleting...",
                      })
                    : t("memory.multiSelectDelete", {
                        defaultValue: "Delete selected",
                      })}
                </span>
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="memo-filter-tabs">
              {(["all", ...STATUS_KEYS] as MemoryFilterStatus[]).map((key) => (
                <button
                  className={`memo-filter-tab${
                    filterStatus === key ? " active" : ""
                  }`}
                  key={key}
                  onClick={() => {
                    setFilterStatus(key);
                    setSelectedMemoryIds(new Set());
                  }}
                  type="button"
                >
                  {key === "all"
                    ? t("memory.filterAllStatuses", { defaultValue: "All" })
                    : statusLabel(key)}
                </button>
              ))}
            </div>
            <button
              aria-label={t("memory.multiSelect", {
                defaultValue: "Multi-select",
              })}
              className="memo-new-btn compact"
              disabled={memories.length === 0}
              onClick={handleEnterMultiSelect}
              title={t("memory.multiSelect", {
                defaultValue: "Multi-select",
              })}
              type="button"
            >
              <ListChecks size={15} strokeWidth={2.2} />
            </button>
            <button
              aria-label={t("memory.new", { defaultValue: "New" })}
              className="memo-new-btn compact"
              disabled={selection.mode === "create"}
              onClick={handleStartCreate}
              title={t("memory.new", { defaultValue: "New" })}
              type="button"
            >
              <Plus size={15} strokeWidth={2.2} />
            </button>
          </>
        )}
      </div>
      <div className="memory-search-row">
        <Search
          aria-hidden="true"
          className="memory-search-icon"
          size={13}
          strokeWidth={2}
        />
        <input
          aria-label={t("memory.searchPlaceholder", {
            defaultValue: "Search memories",
          })}
          className="memory-search-input"
          onChange={(event) => setSearchInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              setActiveQuery(searchInput.trim());
            } else if (event.key === "Escape") {
              // 有关键词时 ESC 只清空检索并吞掉事件（关闭弹窗留给下一次 ESC）；
              // 检索框为空时放行，由弹窗统一处理为「关闭模态框」。
              if (searchInput === "") {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              setSearchInput("");
              setActiveQuery("");
            }
          }}
          placeholder={t("memory.searchPlaceholder", {
            defaultValue: "Search memories",
          })}
          type="text"
          value={searchInput}
        />
        {searchInput !== "" && (
          <button
            aria-label={t("memory.searchClear", {
              defaultValue: "Clear search",
            })}
            className="memory-search-clear"
            onClick={() => {
              setSearchInput("");
              setActiveQuery("");
            }}
            title={t("memory.searchClear", { defaultValue: "Clear search" })}
            type="button"
          >
            <X size={12} strokeWidth={2.2} />
          </button>
        )}
      </div>
      <div className="memory-sidebar-subrow">
        <CustomSelect
          onChange={(value) => {
            setFilterKind(value as MemoryFilterKind);
            setSelectedMemoryIds(new Set());
          }}
          options={[
            {
              label: t("memory.filterAllKinds", { defaultValue: "All kinds" }),
              value: "all",
            },
            ...KIND_KEYS.map((kind) => ({
              label: kindLabel(kind),
              value: kind,
            })),
          ]}
          portal
          title={t("memory.filterKind", { defaultValue: "Kind" })}
          value={filterKind}
        />
        <span className="memory-sidebar-stats">
          {activeQuery
            ? t("memory.searchHits", {
                defaultValue: "{{count}} matches",
                values: { count: hitTotal },
              })
            : stats
              ? t("memory.statsCompact", {
                  defaultValue: "{{total}} entries",
                  values: { total: stats.total },
                })
              : ""}
        </span>
        <button
          className="memory-clear-btn"
          disabled={(stats?.total ?? 0) === 0}
          onClick={() => setIsClearConfirmOpen(true)}
          title={t("memory.clearAll", { defaultValue: "Clear all" })}
          type="button"
        >
          <Trash2 size={13} strokeWidth={1.9} />
        </button>
      </div>
      <div
        className="memo-list-scroll"
        onScroll={handleListScroll}
        ref={listScrollRef}
      >
        {isLoading ? (
          <div className="memory-list-empty">
            <Loader2 className="spin" size={16} />
          </div>
        ) : memories.length === 0 ? (
          <div className="memory-list-empty">
            {activeQuery
              ? t("memory.searchEmpty", {
                  defaultValue: 'No memories match "{{query}}".',
                  values: { query: activeQuery },
                })
              : stats?.total === 0
                ? t("memory.emptyHint", {
                    defaultValue:
                      "No memories yet. The AI saves what it learns via memory-save, or add one manually.",
                  })
                : t("memory.emptyFilterHint", {
                    defaultValue: "No memories match the current filter.",
                  })}
          </div>
        ) : (
          memories.map((record) => {
            const isSelected =
              selection.mode === "edit" &&
              selection.record.memoryId === record.memoryId;
            const isChecked = selectedMemoryIds.has(record.memoryId);
            const date = (record.updatedAt || record.createdAt).slice(0, 10);
            return (
              <div
                className={`memo-list-item memory-list-item${
                  isMultiSelectMode ? " multi-select" : ""
                }${
                  isSelected || (isMultiSelectMode && isChecked)
                    ? " selected"
                    : ""
                }${record.status === "archived" ? " archived" : ""}`}
                key={record.memoryId}
                onClick={
                  isMultiSelectMode
                    ? () => handleToggleSelect(record.memoryId)
                    : () => handleSelect(record)
                }
                role="button"
                tabIndex={0}
              >
                {isMultiSelectMode && (
                  <span
                    className={`memory-item-checkbox${isChecked ? " checked" : ""}`}
                  >
                    {isChecked ? <Check size={11} strokeWidth={3} /> : null}
                  </span>
                )}
                <div className="memory-list-item-main">
                  <div className="memory-list-item-title-row">
                    <span className={`memory-kind-badge ${record.kind}`}>
                      {kindLabel(record.kind)}
                    </span>
                    <span className="memory-list-item-title">
                      {activeQuery ? (
                        <HighlightedText
                          query={activeQuery}
                          text={record.title}
                        />
                      ) : (
                        record.title
                      )}
                    </span>
                  </div>
                  <div className="memory-list-item-meta">
                    <span className="memory-list-item-importance">
                      {"★".repeat(record.importance)}
                      <span className="memory-importance-dim">
                        {"★".repeat(5 - record.importance)}
                      </span>
                    </span>
                    <span>{date}</span>
                    {record.status !== "active" && (
                      <span className={`memory-status-badge ${record.status}`}>
                        {record.status === "archived" ? (
                          <Archive size={10} strokeWidth={2} />
                        ) : null}
                        {statusLabel(record.status)}
                      </span>
                    )}
                  </div>
                  {/* 检索态下补一行命中上下文，让「命中内容」的条目也能被定位 */}
                  {activeQuery !== "" &&
                    (() => {
                      const snippet = buildContentSnippet(
                        record.content,
                        activeQuery,
                      );
                      return snippet ? (
                        <div className="memory-list-item-snippet">
                          <HighlightedText query={activeQuery} text={snippet} />
                        </div>
                      ) : null;
                    })()}
                </div>
                {!isMultiSelectMode && (
                  <div className="memo-list-item-actions">
                    <button
                      aria-label={t("memory.delete", {
                        defaultValue: "Delete",
                      })}
                      className="memo-icon-btn danger"
                      onClick={(event) => {
                        event.stopPropagation();
                        setDeleteTarget(record);
                      }}
                      title={t("memory.delete", { defaultValue: "Delete" })}
                      type="button"
                    >
                      <Trash2 size={13} strokeWidth={1.9} />
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
        {isLoadingMore && (
          <div className="memory-list-empty">
            <Loader2 className="spin" size={14} />
          </div>
        )}
        {!hasMore && !isLoading && memories.length > 0 && (
          <div className="memo-all-loaded">
            {t("memory.allLoaded", { defaultValue: "All memories loaded" })}
          </div>
        )}
      </div>
    </div>
  );

  // ---------------------------------------------------------------------
  // 右栏：详情编辑表单
  // ---------------------------------------------------------------------
  const renderContent = () => {
    if (selection.mode === "none") {
      return (
        <div className="memory-content-empty">
          <span>
            {t("memory.selectHint", {
              defaultValue:
                "Select a memory to view and edit it, or create a new one.",
            })}
          </span>
        </div>
      );
    }

    const isCreate = selection.mode === "create";
    const editingRecord = selection.mode === "edit" ? selection.record : null;
    const date = editingRecord
      ? (editingRecord.updatedAt || editingRecord.createdAt).slice(0, 10)
      : "";

    return (
      <div className="memory-editor">
        <div className="memory-editor-header">
          <div className="memory-editor-meta">
            {isCreate ? (
              <span className="memory-kind-badge fact">
                {t("memory.new", { defaultValue: "New" })}
              </span>
            ) : (
              <>
                <span className={`memory-kind-badge ${draft.kind}`}>
                  {kindLabel(draft.kind)}
                </span>
                <span className="memory-editor-source">
                  {editingRecord?.source} · {date}
                </span>
                {editingRecord && editingRecord.conversationId && (
                  <span
                    className="memory-editor-conversation"
                    title={editingRecord.conversationId}
                  >
                    {t("memory.fromConversation", {
                      defaultValue: "from conversation",
                    })}
                  </span>
                )}
              </>
            )}
          </div>
          <div className="memory-editor-header-actions">
            {editingRecord && (
              <button
                aria-label={t("memory.delete", { defaultValue: "Delete" })}
                className="memo-icon-btn danger"
                disabled={isSaving}
                onClick={() => setDeleteTarget(editingRecord)}
                title={t("memory.delete", { defaultValue: "Delete" })}
                type="button"
              >
                <Trash2 size={15} strokeWidth={1.9} />
              </button>
            )}
            <button
              aria-label={t("common.cancel", { defaultValue: "Cancel" })}
              className="memo-icon-btn"
              disabled={isSaving}
              onClick={handleCancelEdit}
              title={t("common.cancel", { defaultValue: "Cancel" })}
              type="button"
            >
              <X size={15} strokeWidth={1.9} />
            </button>
          </div>
        </div>

        <input
          className="memory-editor-title"
          onChange={(event) =>
            setDraft((prev) => ({ ...prev, title: event.target.value }))
          }
          placeholder={t("memory.titlePlaceholder", {
            defaultValue: "Title (dedup key)",
          })}
          type="text"
          value={draft.title}
        />

        <div className="memory-editor-row">
          <CustomSelect
            onChange={(value) =>
              setDraft((prev) => ({
                ...prev,
                kind: value as MemoryKind,
              }))
            }
            options={KIND_KEYS.map((kind) => ({
              label: kindLabel(kind),
              value: kind,
            }))}
            portal
            title={t("memory.kindLabel", { defaultValue: "Kind" })}
            value={draft.kind}
          />
          <CustomSelect
            onChange={(value) =>
              setDraft((prev) => ({
                ...prev,
                importance: Number.parseInt(value, 10) || 2,
              }))
            }
            options={IMPORTANCE_LEVELS.map((level) => ({
              label: t("memory.importanceOption", {
                defaultValue: "Level {{level}} · {{name}}",
                values: {
                  level,
                  name: t(`memory.importance.name.${level}`, {
                    defaultValue: "",
                  }),
                },
              }),
              value: String(level),
            }))}
            portal
            renderOption={(option) => (
              <span className="memory-importance-option">
                <span className="memory-importance-option-name">
                  {option.label}
                </span>
                <span className="memory-importance-option-desc">
                  {t(`memory.importance.desc.${Number(option.value)}`, {
                    defaultValue: "",
                  })}
                </span>
              </span>
            )}
            title={t("memory.importanceLabel", {
              defaultValue: "Importance level",
            })}
            value={String(draft.importance)}
          />
          <CustomSelect
            onChange={(value) =>
              setDraft((prev) => ({
                ...prev,
                status: value as MemoryStatus,
              }))
            }
            options={STATUS_KEYS.map((status) => ({
              label: statusLabel(status),
              value: status,
            }))}
            portal
            title={t("memory.statusLabel", { defaultValue: "Status" })}
            value={draft.status}
          />
        </div>

        <textarea
          className="memory-editor-content"
          onChange={(event) =>
            setDraft((prev) => ({ ...prev, content: event.target.value }))
          }
          placeholder={t("memory.contentPlaceholder", {
            defaultValue: "Details (paths, commands, reasons...)",
          })}
          value={draft.content}
        />

        <input
          className="memory-editor-tags"
          onChange={(event) =>
            setDraft((prev) => ({ ...prev, tags: event.target.value }))
          }
          placeholder={t("memory.tagsPlaceholder", {
            defaultValue: "Tags (comma separated)",
          })}
          type="text"
          value={draft.tags}
        />

        <div className="memory-editor-actions">
          <button
            className="memory-editor-btn primary"
            disabled={isSaving || !draft.title.trim() || !draft.content.trim()}
            onClick={() => void handleSave()}
            type="button"
          >
            {isSaving ? (
              <Loader2 className="spin" size={14} />
            ) : (
              <Check size={14} strokeWidth={2.2} />
            )}
            <span>{t("memory.save", { defaultValue: "Save" })}</span>
          </button>
        </div>
      </div>
    );
  };

  return (
    <Modal
      className="memo-modal"
      closeLabel={t("common.close", { defaultValue: "Close" })}
      closeOnEscape
      onClose={onClose}
      open={open}
      size="large"
      title={t("memory.modalTitle", { defaultValue: "Project Memory" })}
    >
      <div className="memo-modal-layout">
        {renderSidebar()}
        <div className="memory-content">{renderContent()}</div>
      </div>
      <ConfirmDialog
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        confirmLabel={t("memory.delete", { defaultValue: "Delete" })}
        message={t("memory.deleteConfirm", {
          defaultValue: 'Delete the memory "{{title}}"?',
          values: { title: deleteTarget?.title ?? "" },
        })}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
        open={deleteTarget !== null}
        title={t("memory.deleteTitle", { defaultValue: "Delete memory" })}
        variant="danger"
      />
      <ConfirmDialog
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        confirmLabel={t("memory.clearAll", { defaultValue: "Clear all" })}
        message={t("memory.clearConfirm", {
          defaultValue:
            "Permanently delete ALL {{count}} memories of this project? This cannot be undone.",
          values: { count: stats?.total ?? 0 },
        })}
        onCancel={() => setIsClearConfirmOpen(false)}
        onConfirm={() => void confirmClear()}
        open={isClearConfirmOpen}
        title={t("memory.clearTitle", { defaultValue: "Clear memory bank" })}
        variant="danger"
      />
      <ConfirmDialog
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        confirmLabel={t("memory.multiSelectDelete", {
          defaultValue: "Delete selected",
        })}
        message={t("memory.multiSelectDeleteConfirm", {
          defaultValue:
            "Permanently delete the {{count}} selected memories? This cannot be undone.",
          values: { count: selectedMemoryIds.size },
        })}
        onCancel={() => setIsBatchDeleteConfirmOpen(false)}
        onConfirm={() => void confirmBatchDelete()}
        open={isBatchDeleteConfirmOpen}
        title={t("memory.deleteTitle", { defaultValue: "Delete memory" })}
        variant="danger"
      />
    </Modal>
  );
}
