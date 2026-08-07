import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Download,
  FolderCog,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useI18n } from "../../i18n";
import { ConfirmDialog } from "../common/ConfirmDialog";
import type {
  ImageAlbumRecord,
  ImageLibraryRecord,
} from "../../../preload";

type RatioFilter = "all" | "landscape" | "square" | "portrait";
type TimeFilter = "all" | "today" | "7d" | "30d";

/** data URL → Blob（不走 fetch：CSP connect-src 不允许 data:） */
const dataUrlToBlob = (dataUrl: string): Blob => {
  const [header, base64] = dataUrl.split(",");
  const mimeType =
    /^data:([^;]+)/.exec(header)?.[1] ?? "application/octet-stream";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
};

/** 图片 data URL 进程内缓存，避免重复 IPC */
const imageDataCache = new Map<string, string>();

const saveBlob = async (dataUrl: string, filename: string): Promise<void> => {
  const blob = dataUrlToBlob(dataUrl);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const ratioKind = (record: ImageLibraryRecord): RatioFilter => {
  if (!record.width || !record.height) return "all";
  const ratio = record.width / record.height;
  if (ratio > 1.05) return "landscape";
  if (ratio < 0.95) return "portrait";
  return "square";
};

type ImageLibraryPanelProps = {
  onClose: () => void;
};

export const ImageLibraryPanel = ({
  onClose,
}: ImageLibraryPanelProps): React.JSX.Element => {
  const { t } = useI18n();
  const [items, setItems] = useState<ImageLibraryRecord[]>([]);
  const [albums, setAlbums] = useState<ImageAlbumRecord[]>([]);
  /** 当前选中的相册："all" = 全部，"" = 未分类，其他 = 相册 id */
  const [activeAlbum, setActiveAlbum] = useState<string>("all");
  const [creatingAlbum, setCreatingAlbum] = useState(false);
  const [newAlbumName, setNewAlbumName] = useState("");
  const [renamingAlbumId, setRenamingAlbumId] = useState<string | null>(null);
  const [renameAlbumName, setRenameAlbumName] = useState("");
  const [pendingAlbumDelete, setPendingAlbumDelete] =
    useState<ImageAlbumRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [root, setRoot] = useState("");
  const [customDir, setCustomDir] = useState("");
  const [changingDir, setChangingDir] = useState(false);
  const [ratioFilter, setRatioFilter] = useState<RatioFilter>("all");
  const [timeFilter, setTimeFilter] = useState<TimeFilter>("all");
  const [modelFilter, setModelFilter] = useState("all");
  const [providerFilter, setProviderFilter] = useState("all");
  const [dataUrls, setDataUrls] = useState<Record<string, string>>({});
  const [lightbox, setLightbox] = useState<ImageLibraryRecord | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingDeletion, setPendingDeletion] =
    useState<ImageLibraryRecord | null>(null);
  /** 待确认迁移的目标目录（null 表示无待确认迁移） */
  const [pendingMigration, setPendingMigration] = useState<{
    target: string;
    dirLabel: string;
  } | null>(null);
  /** 迁移进度（null 表示未在迁移） */
  const [migration, setMigration] = useState<{
    total: number;
    copied: number;
  } | null>(null);
  const [rollingBack, setRollingBack] = useState(false);
  /** 用户请求取消迁移（chunk 循环之间检查） */
  const migrationCancelledRef = useRef(false);
  /** 组件卸载时若迁移仍进行中，触发回滚 */
  const migrationActiveRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [records, rootPath, savedDir, albumRecords] = await Promise.all([
        window.snow.listImageLibrary(),
        window.snow.getImageLibraryRoot().catch(() => ""),
        window.snow.getImageLibraryDir().catch(() => ""),
        window.snow.listImageAlbums().catch(() => []),
      ]);
      setItems(records);
      setAlbums(albumRecords);
      setRoot(rootPath);
      setCustomDir(savedDir);
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError)
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 批量解析缩略图 data URL（带缓存）
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next: Record<string, string> = {};
      for (const record of items) {
        if (cancelled) break;
        const cached = imageDataCache.get(record.relativePath);
        if (cached) {
          next[record.relativePath] = cached;
          continue;
        }
        try {
          const dataUrl = await window.snow.resolveLibraryImage(
            record.relativePath
          );
          if (dataUrl) {
            imageDataCache.set(record.relativePath, dataUrl);
            next[record.relativePath] = dataUrl;
          }
        } catch {
          // 单张失败不中断
        }
      }
      if (!cancelled && Object.keys(next).length > 0) {
        setDataUrls((prev) => ({ ...prev, ...next }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [items]);

  const models = useMemo(
    () => [...new Set(items.map((item) => item.model).filter(Boolean))].sort(),
    [items]
  );
  const providers = useMemo(
    () =>
      [...new Set(items.map((item) => item.provider).filter(Boolean))].sort(),
    [items]
  );

  const filtered = useMemo(() => {
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const dayMs = 24 * 60 * 60 * 1000;
    return items.filter((item) => {
      // 相册过滤："all" = 全部；"" = 未分类；其他 = 指定相册
      if (activeAlbum === "none") {
        if (item.albumId !== null) {
          return false;
        }
      } else if (activeAlbum !== "all" && item.albumId !== activeAlbum) {
        return false;
      }
      if (ratioFilter !== "all" && ratioKind(item) !== ratioFilter) {
        return false;
      }
      if (modelFilter !== "all" && item.model !== modelFilter) {
        return false;
      }
      if (providerFilter !== "all" && item.provider !== providerFilter) {
        return false;
      }
      if (timeFilter !== "all") {
        const created = new Date(item.createdAt.replace(" ", "T")).getTime();
        const limit =
          timeFilter === "today"
            ? todayStart.getTime()
            : timeFilter === "7d"
            ? now - 7 * dayMs
            : now - 30 * dayMs;
        if (!Number.isFinite(created) || created < limit) {
          return false;
        }
      }
      return true;
    });
  }, [items, activeAlbum, ratioFilter, timeFilter, modelFilter, providerFilter]);

  // ------------------------------------------------------------------
  // 相册操作
  // ------------------------------------------------------------------

  const confirmCreateAlbum = async (): Promise<void> => {
    const name = newAlbumName.trim();
    if (!name) {
      setCreatingAlbum(false);
      return;
    }
    try {
      const album = await window.snow.createImageAlbum(name);
      setAlbums((prev) => [album, ...prev]);
      setNewAlbumName("");
      setCreatingAlbum(false);
      setActiveAlbum(album.id);
    } catch (albumError) {
      console.warn("[image-library] create album failed", albumError);
      setCreatingAlbum(false);
    }
  };

  const startRenameAlbum = (album: ImageAlbumRecord): void => {
    setRenamingAlbumId(album.id);
    setRenameAlbumName(album.name);
  };

  const confirmRenameAlbum = async (albumId: string): Promise<void> => {
    const name = renameAlbumName.trim();
    setRenamingAlbumId(null);
    if (!name) {
      return;
    }
    try {
      const updated = await window.snow.renameImageAlbum(albumId, name);
      setAlbums((prev) =>
        prev.map((album) => (album.id === albumId ? updated : album))
      );
    } catch (renameError) {
      console.warn("[image-library] rename album failed", renameError);
    }
  };

  const confirmDeleteAlbum = async (): Promise<void> => {
    const album = pendingAlbumDelete;
    if (!album) {
      return;
    }
    setPendingAlbumDelete(null);
    try {
      await window.snow.deleteImageAlbum(album.id);
      setAlbums((prev) => prev.filter((item) => item.id !== album.id));
      // 相册内图片置为未分类，同步本地状态
      setItems((prev) =>
        prev.map((item) =>
          item.albumId === album.id ? { ...item, albumId: null } : item
        )
      );
      if (activeAlbum === album.id) {
        setActiveAlbum("all");
      }
    } catch (deleteError) {
      console.warn("[image-library] delete album failed", deleteError);
    }
  };

  /** 移动图片到相册（value 为空 = 未分类） */
  const moveToAlbum = async (
    record: ImageLibraryRecord,
    albumId: string
  ): Promise<void> => {
    const target = albumId || null;
    if (target === record.albumId) {
      return;
    }
    try {
      await window.snow.setImageAlbum(record.id, target);
      setItems((prev) =>
        prev.map((item) =>
          item.id === record.id ? { ...item, albumId: target } : item
        )
      );
      // 刷新相册计数与封面（懒刷新：移入/移出后重新拉取相册列表）
      const albumRecords = await window.snow
        .listImageAlbums()
        .catch(() => null);
      if (albumRecords) {
        setAlbums(albumRecords);
      }
    } catch (moveError) {
      console.warn("[image-library] move image failed", moveError);
    }
  };

  /** 请求删除图片（弹出确认对话框）。 */
  const requestDelete = (record: ImageLibraryRecord): void => {
    setPendingDeletion(record);
  };

  /** 确认删除图片。 */
  const confirmDelete = async (): Promise<void> => {
    const record = pendingDeletion;
    if (!record) {
      return;
    }
    setPendingDeletion(null);
    setDeletingId(record.id);
    try {
      await window.snow.deleteImageLibraryImage(record.id);
      imageDataCache.delete(record.relativePath);
      setItems((prev) => prev.filter((item) => item.id !== record.id));
      if (lightbox?.id === record.id) {
        setLightbox(null);
      }
    } finally {
      setDeletingId(null);
    }
  };

  const handleDownload = async (record: ImageLibraryRecord): Promise<void> => {
    const dataUrl =
      dataUrls[record.relativePath] ??
      (await window.snow.resolveLibraryImage(record.relativePath));
    if (!dataUrl) {
      return;
    }
    await saveBlob(
      dataUrl,
      record.fileName || record.relativePath.split("/").pop() || "image.png"
    );
  };

  /** 切换目录后刷新根路径与缩略图缓存。 */
  const applyNewRoot = async (target: string): Promise<void> => {
    setCustomDir(target);
    const newRoot = await window.snow.getImageLibraryRoot().catch(() => "");
    setRoot(newRoot);
    imageDataCache.clear();
    setDataUrls({});
  };

  /** 图库为空时直接切换目录（无需迁移）。 */
  const switchDirDirect = async (target: string): Promise<void> => {
    setChangingDir(true);
    try {
      await window.snow.setImageLibraryDir(target);
      await applyNewRoot(target);
    } finally {
      setChangingDir(false);
    }
  };

  /** 确认迁移：prepare → 分批复制 → commit；取消则回滚。 */
  const confirmMigration = async (): Promise<void> => {
    const pending = pendingMigration;
    if (!pending) {
      return;
    }
    setPendingMigration(null);
    migrationCancelledRef.current = false;
    migrationActiveRef.current = true;
    setChangingDir(true);
    try {
      const total = await window.snow.prepareImageLibraryMigration(
        pending.target
      );
      if (total === 0) {
        // 无需迁移（目标与当前相同或图库为空）：直接切换
        await window.snow.setImageLibraryDir(pending.target);
        await applyNewRoot(pending.target);
        return;
      }
      setMigration({ total, copied: 0 });
      let done = false;
      while (!done) {
        if (migrationCancelledRef.current) {
          break;
        }
        const progress = await window.snow.migrateImageLibraryChunk();
        setMigration({ total: progress.total, copied: progress.copied });
        done = progress.done;
      }
      if (migrationCancelledRef.current) {
        // 用户取消：删除已复制文件，保持旧目录
        setRollingBack(true);
        await window.snow.rollbackImageLibraryMigration();
        return;
      }
      await window.snow.commitImageLibraryMigration();
      await applyNewRoot(pending.target);
    } catch (migrationError) {
      // 出错自动回滚，保持旧目录
      try {
        await window.snow.rollbackImageLibraryMigration();
      } catch {
        // 回滚失败不阻断错误提示
      }
      setError(
        migrationError instanceof Error
          ? migrationError.message
          : String(migrationError)
      );
    } finally {
      setRollingBack(false);
      setMigration(null);
      migrationActiveRef.current = false;
      setChangingDir(false);
      await load();
    }
  };

  const cancelMigration = (): void => {
    migrationCancelledRef.current = true;
  };

  const handleChangeDir = async (): Promise<void> => {
    const selected = await window.snow.selectImageDirectory(
      t("settings.imageLibrarySelectDir")
    );
    if (!selected) return;
    if (items.length > 0) {
      // 已有图片：先确认再迁移
      setPendingMigration({ target: selected, dirLabel: selected });
      return;
    }
    await switchDirDirect(selected);
  };

  const handleResetDir = async (): Promise<void> => {
    if (items.length > 0) {
      // 已有图片：先确认再迁移回默认目录
      setPendingMigration({
        target: "",
        dirLabel: t("settings.imageLibraryDefaultDir"),
      });
      return;
    }
    await switchDirDirect("");
  };

  const lightboxDataUrl = lightbox ? dataUrls[lightbox.relativePath] ?? "" : "";

  useEffect(() => {
    if (!lightbox) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setLightbox(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [lightbox]);

  // 迁移进行中关闭面板：触发回滚，避免遗留未完成的迁移日志
  useEffect(() => {
    return () => {
      if (migrationActiveRef.current) {
        void window.snow.rollbackImageLibraryMigration().catch(() => {});
      }
    };
  }, []);

  return (
    <div className="api-settings-page image-library-page">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>{t("settings.imageLibrary")}</strong>
          <span className="settings-item-description">
            {t("settings.imageLibraryDescription")}
          </span>
        </div>
        <div className="image-library-actions">
          <button
            type="button"
            className="icon-btn ghost"
            onClick={() => void load()}
            title={t("settings.imageLibraryRefresh")}
            aria-label={t("settings.imageLibraryRefresh")}
          >
            <RefreshCw size={15} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className="icon-btn ghost"
            onClick={onClose}
            aria-label={t("toolCall.imagegen.close")}
            title={t("toolCall.imagegen.close")}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      {root ? (
        <div className="image-library-root-bar" title={root}>
          {changingDir ? (
            <Loader2
              size={12}
              className="tool-call-icon-spinning"
              aria-hidden="true"
            />
          ) : (
            <FolderOpen size={12} aria-hidden="true" />
          )}
          <span className="image-library-root-path">{root}</span>
          <button
            type="button"
            className="image-library-root-action"
            onClick={() => void handleChangeDir()}
            disabled={changingDir}
            title={t("settings.imageLibraryChangeDir")}
          >
            <FolderCog size={11} aria-hidden="true" />
            <span>{t("settings.imageLibraryChangeDir")}</span>
          </button>
          {customDir ? (
            <button
              type="button"
              className="image-library-root-action"
              onClick={() => void handleResetDir()}
              disabled={changingDir}
              title={t("settings.imageLibraryResetDir")}
            >
              <X size={11} aria-hidden="true" />
              <span>{t("settings.imageLibraryResetDir")}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {/* 相册栏 */}
      <div className="image-library-albums">
        <button
          type="button"
          className={`image-library-album-chip${
            activeAlbum === "all" ? " active" : ""
          }`}
          onClick={() => setActiveAlbum("all")}
        >
          <ImageIcon size={12} aria-hidden="true" />
          {t("settings.imageLibraryAlbumAll")}
        </button>
        <button
          type="button"
          className={`image-library-album-chip${
            activeAlbum === "none" ? " active" : ""
          }`}
          onClick={() => setActiveAlbum("none")}
        >
          <FolderOpen size={12} aria-hidden="true" />
          {t("settings.imageLibraryAlbumNone")}
        </button>
        {albums.map((album) => (
          <span
            key={album.id}
            className={`image-library-album-chip-wrap${
              activeAlbum === album.id ? " active" : ""
            }`}
          >
            {renamingAlbumId === album.id ? (
              <input
                className="image-library-album-rename-input"
                value={renameAlbumName}
                autoFocus
                onChange={(event) => setRenameAlbumName(event.target.value)}
                onBlur={() => void confirmRenameAlbum(album.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void confirmRenameAlbum(album.id);
                  }
                  if (event.key === "Escape") {
                    setRenamingAlbumId(null);
                  }
                }}
              />
            ) : (
              <>
                <button
                  type="button"
                  className="image-library-album-chip"
                  onClick={() => setActiveAlbum(album.id)}
                  title={`${album.name} · ${album.imageCount}`}
                >
                  <FolderOpen size={12} aria-hidden="true" />
                  <span className="image-library-album-chip-name">
                    {album.name}
                  </span>
                  <span className="image-library-album-chip-count">
                    {album.imageCount}
                  </span>
                </button>
                <span className="image-library-album-chip-actions">
                  <button
                    type="button"
                    title={t("settings.imageLibraryAlbumRename")}
                    aria-label={t("settings.imageLibraryAlbumRename")}
                    onClick={() => startRenameAlbum(album)}
                  >
                    <Pencil size={10} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="danger"
                    title={t("settings.imageLibraryAlbumDelete")}
                    aria-label={t("settings.imageLibraryAlbumDelete")}
                    onClick={() => setPendingAlbumDelete(album)}
                  >
                    <Trash2 size={10} aria-hidden="true" />
                  </button>
                </span>
              </>
            )}
          </span>
        ))}
        {creatingAlbum ? (
          <input
            className="image-library-album-rename-input"
            placeholder={t("settings.imageLibraryAlbumNewPlaceholder")}
            value={newAlbumName}
            autoFocus
            onChange={(event) => setNewAlbumName(event.target.value)}
            onBlur={() => void confirmCreateAlbum()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void confirmCreateAlbum();
              }
              if (event.key === "Escape") {
                setCreatingAlbum(false);
                setNewAlbumName("");
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="image-library-album-add"
            onClick={() => setCreatingAlbum(true)}
            title={t("settings.imageLibraryAlbumCreate")}
          >
            <FolderPlus size={12} aria-hidden="true" />
            {t("settings.imageLibraryAlbumCreate")}
          </button>
        )}
      </div>

      {migration ? (
        <div className="image-library-migrate-bar" role="status">
          <div className="image-library-migrate-info">
            <Loader2
              size={12}
              className="tool-call-icon-spinning"
              aria-hidden="true"
            />
            <span>
              {rollingBack
                ? t("settings.imageLibraryMigrateRollingBack")
                : t("settings.imageLibraryMigrateProgress", {
                    values: {
                      current: migration.copied,
                      total: migration.total,
                    },
                  })}
            </span>
            {!rollingBack ? (
              <button
                type="button"
                className="image-library-migrate-cancel"
                onClick={cancelMigration}
              >
                {t("settings.cancel", { defaultValue: "Cancel" })}
              </button>
            ) : null}
          </div>
          <div className="image-library-migrate-progress-bar">
            <div
              className="image-library-migrate-progress-fill"
              style={{
                width: `${
                  migration.total > 0
                    ? Math.min(
                        100,
                        Math.round((migration.copied / migration.total) * 100)
                      )
                    : 0
                }%`,
              }}
            />
          </div>
        </div>
      ) : null}

      <div className="image-library-toolbar">
        <div className="image-library-filter-group">
          {(
            [
              ["all", t("settings.imageLibraryFilterAll")],
              ["landscape", t("settings.imageLibraryFilterLandscape")],
              ["square", t("settings.imageLibraryFilterSquare")],
              ["portrait", t("settings.imageLibraryFilterPortrait")],
            ] as [RatioFilter, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`image-library-filter-btn${
                ratioFilter === value ? " active" : ""
              }`}
              onClick={() => setRatioFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="image-library-filter-group">
          {(
            [
              ["all", t("settings.imageLibraryTimeAll")],
              ["today", t("settings.imageLibraryTimeToday")],
              ["7d", t("settings.imageLibraryTime7d")],
              ["30d", t("settings.imageLibraryTime30d")],
            ] as [TimeFilter, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`image-library-filter-btn${
                timeFilter === value ? " active" : ""
              }`}
              onClick={() => setTimeFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {providers.length > 1 ? (
          <select
            className="image-library-select"
            value={providerFilter}
            onChange={(event) => setProviderFilter(event.target.value)}
            aria-label={t("toolCall.imagegen.provider")}
          >
            <option value="all">{t("settings.imageLibraryProviderAll")}</option>
            {providers.map((provider) => (
              <option key={provider} value={provider}>
                {provider}
              </option>
            ))}
          </select>
        ) : null}
        {models.length > 1 ? (
          <select
            className="image-library-select"
            value={modelFilter}
            onChange={(event) => setModelFilter(event.target.value)}
            aria-label={t("toolCall.imagegen.model")}
          >
            <option value="all">{t("settings.imageLibraryModelAll")}</option>
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        ) : null}
        <span className="image-library-count">
          {t("settings.imageLibraryCount", {
            values: { count: filtered.length },
          })}
        </span>
      </div>

      <div className="image-library-content">
        {loading ? (
          <div className="image-library-state" role="status">
            <Loader2
              className="tool-call-icon-spinning"
              size={20}
              aria-hidden="true"
            />
            <span>{t("common.loading")}</span>
          </div>
        ) : error ? (
          <div className="image-library-state">
            <span className="tool-call-error">{error}</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="image-library-state">
            <ImageIcon size={26} aria-hidden="true" />
            <span>{t("settings.imageLibraryEmpty")}</span>
          </div>
        ) : (
          <div className="image-library-grid">
            {filtered.map((record) => {
              const src = dataUrls[record.relativePath];
              return (
                <div
                  key={record.id}
                  className="image-library-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => setLightbox(record)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      setLightbox(record);
                    }
                  }}
                  title={record.prompt || record.fileName}
                >
                  {src ? (
                    <img src={src} alt={record.prompt || record.fileName} />
                  ) : (
                    <div className="image-library-card-placeholder">
                      <Loader2
                        className="tool-call-icon-spinning"
                        size={16}
                        aria-hidden="true"
                      />
                    </div>
                  )}
                  <div className="image-library-card-meta">
                    <span className="image-library-card-model">
                      {record.model || record.provider || "—"}
                    </span>
                    <span className="image-library-card-date">
                      {record.createdAt}
                    </span>
                  </div>
                  <div
                    className="image-library-card-actions"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <select
                      className="image-library-card-album-select"
                      value={record.albumId ?? ""}
                      onChange={(event) =>
                        void moveToAlbum(record, event.target.value)
                      }
                      onClick={(event) => event.stopPropagation()}
                      title={t("settings.imageLibraryAlbumMove")}
                      aria-label={t("settings.imageLibraryAlbumMove")}
                    >
                      <option value="">
                        {t("settings.imageLibraryAlbumNone")}
                      </option>
                      {albums.map((album) => (
                        <option key={album.id} value={album.id}>
                          {album.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="image-library-card-btn"
                      onClick={() => void handleDownload(record)}
                      title={t("toolCall.imagegen.download")}
                      aria-label={t("toolCall.imagegen.download")}
                    >
                      <Download size={12} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="image-library-card-btn danger"
                      onClick={() => requestDelete(record)}
                      disabled={deletingId === record.id}
                      title={t("settings.imageLibraryDelete")}
                      aria-label={t("settings.imageLibraryDelete")}
                    >
                      {deletingId === record.id ? (
                        <Loader2
                          className="tool-call-icon-spinning"
                          size={12}
                          aria-hidden="true"
                        />
                      ) : (
                        <Trash2 size={12} aria-hidden="true" />
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {lightbox && lightboxDataUrl
        ? createPortal(
            <div
              className="tool-call-imagegen-lightbox"
              onClick={() => setLightbox(null)}
              role="presentation"
            >
              <img
                src={lightboxDataUrl}
                alt={lightbox.prompt || lightbox.fileName}
                onClick={(event) => event.stopPropagation()}
              />
              <div
                className="tool-call-imagegen-lightbox-toolbar"
                onClick={(event) => event.stopPropagation()}
              >
                <span className="image-library-lightbox-meta">
                  {lightbox.model ? `${lightbox.model} · ` : ""}
                  {lightbox.provider ? `${lightbox.provider} · ` : ""}
                  {lightbox.createdAt}
                </span>
                <button
                  type="button"
                  className="tool-call-imagegen-download"
                  onClick={() => void handleDownload(lightbox)}
                >
                  <Download size={13} aria-hidden="true" />
                  {t("toolCall.imagegen.download")}
                </button>
                <button
                  type="button"
                  className="tool-call-imagegen-lightbox-close"
                  onClick={() => setLightbox(null)}
                  aria-label={t("toolCall.imagegen.close")}
                >
                  ✕
                </button>
              </div>
            </div>,
            document.body
          )
        : null}

      <ConfirmDialog
        open={pendingDeletion !== null}
        title={t("settings.imageLibraryDeleteTitle", {
          defaultValue: "Delete image",
        })}
        message={t("settings.imageLibraryDeleteConfirm", {
          defaultValue:
            "Delete this image? It will also be removed from the conversation.",
        })}
        confirmLabel={t("settings.imageLibraryDelete", {
          defaultValue: "Delete",
        })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDeletion(null)}
        variant="danger"
      />

      <ConfirmDialog
        open={pendingMigration !== null}
        title={t("settings.imageLibraryMigrateTitle", {
          defaultValue: "Migrate images",
        })}
        message={t("settings.imageLibraryMigrateConfirm", {
          defaultValue: "Migrate images to the new directory?",
          values: {
            count: items.length,
            dir: pendingMigration?.dirLabel ?? "",
          },
        })}
        confirmLabel={t("settings.imageLibraryMigrateStart", {
          defaultValue: "Start migration",
        })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => void confirmMigration()}
        onCancel={() => setPendingMigration(null)}
      />

      <ConfirmDialog
        open={pendingAlbumDelete !== null}
        title={t("settings.imageLibraryAlbumDeleteTitle", {
          defaultValue: "Delete album",
        })}
        message={t("settings.imageLibraryAlbumDeleteConfirm", {
          defaultValue:
            'Delete album "{{name}}"? Its {{count}} image(s) will be kept (moved to Uncategorized).',
          values: {
            name: pendingAlbumDelete?.name ?? "",
            count: pendingAlbumDelete?.imageCount ?? 0,
          },
        })}
        confirmLabel={t("settings.imageLibraryAlbumDelete", {
          defaultValue: "Delete",
        })}
        cancelLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onConfirm={() => void confirmDeleteAlbum()}
        onCancel={() => setPendingAlbumDelete(null)}
        variant="danger"
      />
    </div>
  );
};
