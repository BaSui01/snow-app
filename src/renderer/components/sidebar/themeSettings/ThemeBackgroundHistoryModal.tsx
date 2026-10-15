/**
 * 历史背景图弹窗：列出受管背景图目录（~/.snowapp/backgrounds/）中的全部图片，
 * 支持多选重新加入当前列表，以及从磁盘删除不再需要的文件。
 *
 * 设计约定：从当前列表移除图片、重置主题都不会删除磁盘文件，文件始终保留
 * 在本目录中作为「历史」；只有在本弹窗中显式删除才会从磁盘移除。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, Trash2 } from "lucide-react";
import type { ThemeBackgroundHistoryEntry } from "../../../../preload/types/settings";
import { useI18n } from "../../../i18n";
import { themeBgUrl } from "../../../utils/themeBgUrl";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { Modal } from "../../common/Modal";

type ThemeBackgroundHistoryModalProps = {
  open: boolean;
  /** 当前列表中的图片路径（标记「已添加」并禁止重复选择） */
  activePaths: string[];
  onClose: () => void;
  /** 将选中的历史图片加入当前列表（不复制文件） */
  onAdd: (paths: string[]) => void;
  /** 从磁盘删除指定历史文件 */
  onDelete: (path: string) => Promise<void>;
};

export function ThemeBackgroundHistoryModal({
  open,
  activePaths,
  onClose,
  onAdd,
  onDelete,
}: ThemeBackgroundHistoryModalProps): React.JSX.Element {
  const { t } = useI18n();
  const [entries, setEntries] = useState<ThemeBackgroundHistoryEntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setError("");
    try {
      const list = await window.snow.listThemeBackgroundImages();
      if (isMountedRef.current) {
        setEntries(list);
      }
    } catch (e) {
      if (isMountedRef.current) {
        setError(
          e instanceof Error
            ? e.message
            : t("settings.themeBackgroundHistoryLoadError", {
                defaultValue: "Failed to load background history",
              }),
        );
      }
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [t]);

  // 每次打开时重载列表并清空选择，避免展示过期数据。
  useEffect(() => {
    if (!open) {
      return;
    }
    setSelected(new Set());
    setPendingDelete(null);
    void load();
  }, [open, load]);

  const activePathSet = useMemo(() => new Set(activePaths), [activePaths]);

  const toggleSelect = (path: string): void => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const handleAdd = (): void => {
    const paths = [...selected];
    if (paths.length === 0) {
      return;
    }
    onAdd(paths);
    setSelected(new Set());
  };

  const handleConfirmDelete = async (): Promise<void> => {
    if (!pendingDelete) {
      return;
    }
    setIsDeleting(true);
    try {
      await onDelete(pendingDelete);
    } finally {
      setIsDeleting(false);
      setPendingDelete(null);
      // 删除成功 / 失败后都重新拉取列表：成功时该文件消失，失败时保持原状。
      void load();
    }
  };

  return (
    <>
      <Modal
        open={open}
        title={t("settings.themeBackgroundHistoryTitle", {
          defaultValue: "Background image history",
        })}
        description={t("settings.themeBackgroundHistoryInfo", {
          defaultValue:
            "Pick previously used backgrounds to add them back to the list. Deleting also removes the file from disk.",
        })}
        closeLabel={t("settings.closeThemeSettings", {
          defaultValue: "Close theme settings",
        })}
        onClose={onClose}
        size="medium"
        footer={
          <button
            type="button"
            className="api-settings-form-btn primary"
            onClick={handleAdd}
            disabled={selected.size === 0 || isLoading}
          >
            <Check size={14} strokeWidth={2} />
            <span>
              {t("settings.themeBackgroundHistoryAdd", {
                defaultValue: "Add to list",
              })}
            </span>
          </button>
        }
      >
        {error ? <p className="theme-history-error">{error}</p> : null}
        {isLoading ? (
          <p className="theme-history-status">
            <Loader2 size={14} className="spin" aria-hidden="true" />
          </p>
        ) : entries.length === 0 ? (
          <p className="theme-history-status">
            {t("settings.themeBackgroundHistoryEmpty", {
              defaultValue: "No background history yet.",
            })}
          </p>
        ) : (
          <div className="theme-history-grid">
            {entries.map((entry) => {
              const isAdded = activePathSet.has(entry.path);
              const isSelected = selected.has(entry.path);
              return (
                <div
                  key={entry.path}
                  className={`theme-history-item${isAdded ? " added" : ""}${
                    isSelected ? " selected" : ""
                  }`}
                >
                  <button
                    type="button"
                    className="theme-history-item-select"
                    onClick={() => toggleSelect(entry.path)}
                    disabled={isAdded}
                    aria-pressed={isSelected}
                    title={
                      isAdded
                        ? t("settings.themeBackgroundHistoryAdded", {
                            defaultValue: "Added",
                          })
                        : entry.fileName
                    }
                  >
                    <img
                      src={themeBgUrl(entry.path)}
                      alt=""
                      className="theme-background-thumbnail"
                    />
                  </button>
                  {isAdded ? (
                    <span className="theme-history-item-badge">
                      <Check size={12} strokeWidth={2.6} />
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="theme-history-item-delete"
                    title={t("settings.themeBackgroundHistoryDelete", {
                      defaultValue: "Delete file",
                    })}
                    onClick={() => setPendingDelete(entry.path)}
                  >
                    <Trash2 size={12} strokeWidth={2} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("settings.themeBackgroundHistoryDelete", {
          defaultValue: "Delete file",
        })}
        message={t("settings.themeBackgroundHistoryDeleteConfirm", {
          defaultValue:
            "Delete this background image file? This cannot be undone.",
        })}
        confirmLabel={t("settings.delete", { defaultValue: "Delete" })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        variant="danger"
        onConfirm={() => {
          void handleConfirmDelete();
        }}
        onCancel={() => setPendingDelete(null)}
        isConfirming={isDeleting}
      />
    </>
  );
}
