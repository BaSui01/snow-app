import {
  AlertTriangle,
  ChevronRight,
  Code2,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  Loader2,
  MessageSquarePlus,
  Pencil,
  Terminal,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../i18n";
import {
  getBrowserFileMimeType,
  localPathToFileUrl,
  openBrowserFile,
} from "../../utils/browserFileOpen";
import type { IdeInfo } from "../../../preload";
import { IdeIcon } from "../icons/ideIcons";
import { useMenuPosition } from "./mainSidebar/useMenuPosition";

type ExplorerEntryContextMenuProps = {
  entryName: string;
  entryPath: string;
  /** 目录时在终端中打开该目录；文件时打开其所在目录。 */
  isDirectory: boolean;
  /** SSH 远程条目不支持系统文件管理器与 IDE 打开方式。 */
  isSsh: boolean;
  /** 当前选中条目数；>1 时菜单切换为批量操作模式。 */
  selectedCount: number;
  onClose: () => void;
  onDelete: () => Promise<void>;
  /** 批量删除选中条目（selectedCount > 1 时使用）。 */
  onDeleteSelected?: () => Promise<void>;
  /** 批量复制选中路径（selectedCount > 1 时使用）。 */
  onCopySelectedPaths?: () => void;
  /** SSH：下载当前条目到本地（单条文件）。 */
  onDownloadToLocal?: () => void;
  /** SSH：批量下载选中条目（多选时使用）。 */
  onDownloadSelected?: () => void;
  /** SSH：上传文件到当前目录（目录条目）。 */
  onUploadToHere?: () => void;
  /** 将当前条目（多选时为整个选中集合）添加到聊天输入框。 */
  onAddToInput: () => void;
  onOpenTerminal?: (cwd: string) => void;
  onRename: (newName: string) => Promise<void>;
  position: { x: number; y: number };
};

export type MenuMode = "actions" | "delete" | "rename";

export function ExplorerEntryContextMenu({
  entryName,
  entryPath,
  isDirectory,
  isSsh,
  selectedCount,
  onClose,
  onDelete,
  onDeleteSelected,
  onCopySelectedPaths,
  onDownloadToLocal,
  onDownloadSelected,
  onUploadToHere,
  onAddToInput,
  onOpenTerminal,
  onRename,
  position,
}: ExplorerEntryContextMenuProps): React.JSX.Element {
  const { t } = useI18n();
  const isMultiSelect = selectedCount > 1;
  const [mode, setMode] = useState<MenuMode>("actions");
  const [newName, setNewName] = useState(entryName);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const [top, setTop] = useState(position.y);

  // 打开方式二级菜单：已安装 IDE 列表（仿工作区目录菜单的加载与悬停逻辑）。
  const [isOpenWithOpen, setIsOpenWithOpen] = useState(false);
  const [installedIdes, setInstalledIdes] = useState<IdeInfo[]>([]);
  const [isLoadingIdes, setIsLoadingIdes] = useState(false);
  const [ideError, setIdeError] = useState<string | null>(null);
  const [systemOpenError, setSystemOpenError] = useState<string | null>(null);
  const idesLoadedRef = useRef(false);
  const openWithItemRef = useRef<HTMLButtonElement | null>(null);
  const openWithPanelRef = useRef<HTMLDivElement | null>(null);
  const openWithCloseTimerRef = useRef<number | null>(null);

  const canOpenWith = !isSsh && Boolean(entryPath);
  // 系统默认应用仅面向文件；目录已由「在系统文件管理器中显示」覆盖。
  const canOpenWithSystemApp = canOpenWith && !isDirectory;

  // 三种模式（操作 / 重命名 / 删除确认）高度差异很大：每次切换都以右键点为锚
  // 重新计算纵向位置。只在上一次高度基础上做溢出修正会让变矮后的内容滞留在
  // 上一个更高的菜单被顶起后的位置（表现为确认框离鼠标很远），因此必须重锚。
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) {
      return;
    }
    const { height } = menu.getBoundingClientRect();
    setTop(Math.max(8, Math.min(position.y, window.innerHeight - height - 8)));
  }, [mode, position.y]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      // 二级菜单是独立 portal，需纳入内部判定，否则点击 IDE 项时
      // pointerdown 会先关闭整个菜单导致点击失效。
      if (
        target instanceof Node &&
        (menuRef.current?.contains(target) ||
          openWithPanelRef.current?.contains(target))
      ) {
        return;
      }
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  useEffect(() => {
    if (mode === "rename") {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [mode]);

  // 菜单打开且可用「打开方式」时，加载一次已安装 IDE 列表。
  useEffect(() => {
    if (mode !== "actions" || !canOpenWith || idesLoadedRef.current) {
      return;
    }
    idesLoadedRef.current = true;
    setIsLoadingIdes(true);
    setIdeError(null);
    window.snow
      .listInstalledIdes()
      .then((ides) => setInstalledIdes(ides))
      .catch((error) => {
        setIdeError(
          error instanceof Error
            ? error.message
            : t("sidebar.openWithError", {
                defaultValue: "Failed to detect installed IDEs",
              }),
        );
      })
      .finally(() => setIsLoadingIdes(false));
  }, [mode, canOpenWith, t]);

  // 鼠标从触发项移到二级菜单之间存在间隙，直接关闭会导致菜单闪烁。
  // 用短暂延时确认用户确实离开后再收起。
  const scheduleOpenWithClose = (): void => {
    if (openWithCloseTimerRef.current !== null) {
      window.clearTimeout(openWithCloseTimerRef.current);
    }
    openWithCloseTimerRef.current = window.setTimeout(() => {
      openWithCloseTimerRef.current = null;
      setIsOpenWithOpen(false);
    }, 150);
  };

  const cancelOpenWithClose = (): void => {
    if (openWithCloseTimerRef.current !== null) {
      window.clearTimeout(openWithCloseTimerRef.current);
      openWithCloseTimerRef.current = null;
    }
  };

  useEffect(
    () => () => {
      if (openWithCloseTimerRef.current !== null) {
        window.clearTimeout(openWithCloseTimerRef.current);
      }
    },
    [],
  );

  const { position: openWithPosition } = useMenuPosition({
    isOpen: isOpenWithOpen,
    placement: "auto-left-right",
    triggerRef: openWithItemRef,
    panelRef: openWithPanelRef,
  });

  const handleRenameSubmit = async (
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    const trimmedName = newName.trim();
    if (!trimmedName || isSubmitting) {
      return;
    }

    if (trimmedName === entryName) {
      onClose();
      return;
    }

    setIsSubmitting(true);
    try {
      await onRename(trimmedName);
      onClose();
    } catch {
      // The explorer surfaces operation errors in its content area.
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    try {
      if (isMultiSelect && onDeleteSelected) {
        await onDeleteSelected();
      } else {
        await onDelete();
      }
      onClose();
    } catch {
      // The explorer surfaces operation errors in its content area.
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOpenTerminalClick = (): void => {
    onClose();
    // 文件条目在终端中打开其所在目录（与文件查看器行为一致）。
    let cwd = entryPath;
    if (!isDirectory) {
      const lastSep = Math.max(
        entryPath.lastIndexOf("/"),
        entryPath.lastIndexOf("\\"),
      );
      cwd = lastSep === -1 ? entryPath : entryPath.slice(0, lastSep);
    }
    onOpenTerminal?.(cwd);
  };

  const handleShowInFolder = (): void => {
    onClose();
    void window.snow.showItemInFolder(entryPath).catch(() => {
      // 打开失败时静默忽略（例如路径已被删除）。
    });
  };

  // 成功关闭菜单；失败保留菜单并展示原因，避免错误一闪而过。
  const handleOpenWithSystemApp = (): void => {
    setSystemOpenError(null);
    void window.snow
      .openPathWithSystemApp(entryPath)
      .then((errorMessage) => {
        if (errorMessage) {
          setSystemOpenError(errorMessage);
        } else {
          onClose();
        }
      })
      .catch(() => {
        setSystemOpenError(
          t("sidebar.openWithSystemAppError", {
            defaultValue: "Failed to open with the system default app",
          }),
        );
      });
  };

  const handleCopyPath = (): void => {
    onClose();
    void window.snow.writeClipboardText(entryPath).catch(() => {
      // 剪贴板写入失败时静默忽略。
    });
  };

  const handleCopySelectedPaths = (): void => {
    onClose();
    onCopySelectedPaths?.();
  };

  // SSH 传输入口沿用「先关菜单再触发」的既有模式：错误由资源管理器内容区展示。
  const handleDownloadToLocal = (): void => {
    onClose();
    onDownloadToLocal?.();
  };

  const handleDownloadSelected = (): void => {
    onClose();
    onDownloadSelected?.();
  };

  const handleUploadToHere = (): void => {
    onClose();
    onUploadToHere?.();
  };

  const handleAddToInput = (): void => {
    onClose();
    onAddToInput();
  };

  const handleOpenInIde = (ide: IdeInfo): void => {
    // 先收起二级菜单；打开成功才关闭整个菜单，失败时保留菜单并
    // 重新展开二级菜单展示错误，避免错误信息一闪而过。
    setIsOpenWithOpen(false);
    void window.snow
      .openInIde(ide.id, entryPath)
      .then(() => onClose())
      .catch((error) => {
        setIdeError(
          error instanceof Error
            ? error.message
            : t("sidebar.openInIdeError", {
                defaultValue: "Failed to open project in IDE",
              }),
        );
        setIsOpenWithOpen(true);
      });
  };

  const handleOpenWithToggle = (event: React.SyntheticEvent): void => {
    event.stopPropagation();
    event.preventDefault();
    setIsOpenWithOpen((prev) => !prev);
  };

  const renderOpenWithItems = (): React.JSX.Element => (
    <>
      {isLoadingIdes ? (
        <div className="explorer-entry-context-menu-submenu-status">
          <Loader2 className="spin" size={12} />
          <span>
            {t("sidebar.openWithLoading", {
              defaultValue: "Detecting installed IDEs...",
            })}
          </span>
        </div>
      ) : installedIdes.length === 0 ? (
        <div className="explorer-entry-context-menu-submenu-status">
          <span>
            {t("sidebar.openWithEmpty", {
              defaultValue: "No installed IDEs detected",
            })}
          </span>
        </div>
      ) : (
        installedIdes.map((ide) => (
          <button
            key={ide.id}
            type="button"
            className="explorer-entry-context-menu-item"
            onClick={() => handleOpenInIde(ide)}
            role="menuitem"
            title={ide.executable}
          >
            <IdeIcon ideId={ide.id} size={13} />
            <span>{ide.name}</span>
          </button>
        ))
      )}
      {ideError ? (
        <div className="explorer-entry-context-menu-submenu-status error">
          <span>{ideError}</span>
        </div>
      ) : null}
    </>
  );

  const menuWidth = 208;
  const left = Math.min(position.x, window.innerWidth - menuWidth - 8);

  return createPortal(
    <div
      className="explorer-entry-context-menu"
      ref={menuRef}
      role="menu"
      style={{ left: Math.max(8, left), top: Math.max(8, top) }}
    >
      {mode === "actions" ? (
        isMultiSelect ? (
          <>
            <div className="explorer-entry-context-menu-heading">
              {t("sidebar.explorerMultiSelectCount", {
                defaultValue: "{{count}} selected",
                values: { count: selectedCount },
              })}
            </div>
            <button
              className="explorer-entry-context-menu-item"
              onClick={handleAddToInput}
              role="menuitem"
              type="button"
            >
              <MessageSquarePlus size={13} />
              <span>
                {t("sidebar.explorerMultiSelectAddToConversation", {
                  defaultValue: "Add {{count}} items to conversation",
                  values: { count: selectedCount },
                })}
              </span>
            </button>
            <button
              className="explorer-entry-context-menu-item"
              onClick={handleCopySelectedPaths}
              role="menuitem"
              type="button"
            >
              <Copy size={13} />
              <span>
                {t("sidebar.explorerMultiSelectCopyPaths", {
                  defaultValue: "Copy {{count}} paths",
                  values: { count: selectedCount },
                })}
              </span>
            </button>
            {isSsh && onDownloadSelected ? (
              <button
                className="explorer-entry-context-menu-item"
                onClick={handleDownloadSelected}
                role="menuitem"
                type="button"
              >
                <Download size={13} />
                <span>
                  {t("explorer.transferDownloadMulti", {
                    values: { count: selectedCount },
                  })}
                </span>
              </button>
            ) : null}
            <div className="explorer-entry-context-menu-separator" />
            <button
              className="explorer-entry-context-menu-item danger"
              onClick={() => setMode("delete")}
              role="menuitem"
              type="button"
            >
              <Trash2 size={13} />
              <span>
                {t("sidebar.explorerMultiSelectDelete", {
                  defaultValue: "Delete {{count}} items",
                  values: { count: selectedCount },
                })}
              </span>
            </button>
          </>
        ) : (
          <>
            <button
              className="explorer-entry-context-menu-item"
              onClick={handleAddToInput}
              role="menuitem"
              type="button"
            >
              <MessageSquarePlus size={13} />
              <span>
                {t("rightPanel.addToConversation", {
                  defaultValue: "Add to conversation",
                })}
              </span>
            </button>
            <button
              className="explorer-entry-context-menu-item"
              onClick={handleOpenTerminalClick}
              role="menuitem"
              type="button"
            >
              <Terminal size={13} />
              <span>
                {t("sidebar.explorerOpenInTerminal", {
                  defaultValue: "Open in Terminal",
                })}
              </span>
            </button>
            {canOpenWith &&
            !isDirectory &&
            getBrowserFileMimeType(entryPath) &&
            localPathToFileUrl(entryPath) ? (
              <button
                className="explorer-entry-context-menu-item"
                onClick={() => {
                  openBrowserFile(entryPath, isSsh);
                  onClose();
                }}
                role="menuitem"
                type="button"
              >
                <ExternalLink size={13} />
                <span>{t("toolCall.websearch.openInBrowser")}</span>
              </button>
            ) : null}
            {canOpenWithSystemApp ? (
              <button
                className="explorer-entry-context-menu-item"
                onClick={handleOpenWithSystemApp}
                role="menuitem"
                type="button"
              >
                <ExternalLink size={13} />
                <span>
                  {t("sidebar.explorerOpenWithSystemApp", {
                    defaultValue: "Open with System Default App",
                  })}
                </span>
              </button>
            ) : null}
            {systemOpenError ? (
              <div className="explorer-entry-context-menu-status error">
                <span>{systemOpenError}</span>
              </div>
            ) : null}
            {!isSsh ? (
              <button
                className="explorer-entry-context-menu-item"
                onClick={handleShowInFolder}
                role="menuitem"
                type="button"
              >
                <FolderOpen size={13} />
                <span>
                  {t("sidebar.explorerShowInFolder", {
                    defaultValue: "Show in System File Manager",
                  })}
                </span>
              </button>
            ) : null}
            <button
              className="explorer-entry-context-menu-item"
              onClick={handleCopyPath}
              role="menuitem"
              type="button"
            >
              <Copy size={13} />
              <span>
                {t("sidebar.explorerCopyPath", { defaultValue: "Copy Path" })}
              </span>
            </button>
            {isSsh && !isDirectory && onDownloadToLocal ? (
              <button
                className="explorer-entry-context-menu-item"
                onClick={handleDownloadToLocal}
                role="menuitem"
                type="button"
              >
                <Download size={13} />
                <span>{t("explorer.transferDownload")}</span>
              </button>
            ) : null}
            {isDirectory && onUploadToHere ? (
              <button
                className="explorer-entry-context-menu-item"
                onClick={handleUploadToHere}
                role="menuitem"
                type="button"
              >
                <Upload size={13} />
                <span>{t("explorer.transferUploadToHere")}</span>
              </button>
            ) : null}
            {canOpenWith ? (
              <span
                className="explorer-entry-context-menu-submenu-trigger"
                onMouseEnter={() => {
                  cancelOpenWithClose();
                  setIsOpenWithOpen(true);
                }}
                onMouseLeave={scheduleOpenWithClose}
              >
                <button
                  ref={openWithItemRef}
                  type="button"
                  className="explorer-entry-context-menu-item"
                  aria-expanded={isOpenWithOpen}
                  aria-haspopup="menu"
                  onClick={handleOpenWithToggle}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      handleOpenWithToggle(event);
                    }
                  }}
                  role="menuitem"
                >
                  <Code2 size={13} />
                  <span>
                    {t("sidebar.openWith", { defaultValue: "Open with" })}
                  </span>
                  <ChevronRight
                    size={12}
                    className="explorer-entry-context-menu-item-chevron"
                  />
                </button>
                {isOpenWithOpen
                  ? createPortal(
                      <div
                        ref={openWithPanelRef}
                        className="explorer-entry-context-menu explorer-entry-context-menu-submenu"
                        style={
                          openWithPosition
                            ? {
                                top: openWithPosition.top,
                                left: openWithPosition.left,
                              }
                            : undefined
                        }
                        role="menu"
                        onMouseEnter={() => {
                          cancelOpenWithClose();
                          setIsOpenWithOpen(true);
                        }}
                        onMouseLeave={scheduleOpenWithClose}
                      >
                        {renderOpenWithItems()}
                      </div>,
                      document.body,
                    )
                  : null}
              </span>
            ) : null}
            <div className="explorer-entry-context-menu-separator" />
            <button
              className="explorer-entry-context-menu-item"
              onClick={() => setMode("rename")}
              role="menuitem"
              type="button"
            >
              <Pencil size={13} />
              <span>
                {t("sidebar.explorerRename", { defaultValue: "Rename" })}
              </span>
            </button>
            <button
              className="explorer-entry-context-menu-item danger"
              onClick={() => setMode("delete")}
              role="menuitem"
              type="button"
            >
              <Trash2 size={13} />
              <span>
                {t("sidebar.explorerDelete", { defaultValue: "Delete" })}
              </span>
            </button>
          </>
        )
      ) : mode === "rename" ? (
        <form
          className="explorer-entry-context-menu-form"
          onSubmit={handleRenameSubmit}
        >
          <label htmlFor="explorer-entry-rename-input">
            {t("sidebar.explorerRename", { defaultValue: "Rename" })}
          </label>
          <input
            id="explorer-entry-rename-input"
            onChange={(event) => setNewName(event.target.value)}
            ref={renameInputRef}
            value={newName}
          />
          <div className="explorer-entry-context-menu-actions">
            <button
              disabled={isSubmitting}
              onClick={() => setMode("actions")}
              type="button"
            >
              {t("common.cancel", { defaultValue: "Cancel" })}
            </button>
            <button disabled={isSubmitting} type="submit">
              {t("common.confirm", { defaultValue: "Confirm" })}
            </button>
          </div>
        </form>
      ) : (
        <div className="explorer-entry-context-menu-confirm">
          <div className="explorer-entry-context-menu-confirm-message">
            <AlertTriangle size={14} />
            <span>
              {isMultiSelect
                ? t("sidebar.explorerMultiSelectDeleteConfirm", {
                    defaultValue:
                      "Delete {{count}} selected items? This cannot be undone.",
                    values: { count: selectedCount },
                  })
                : t("sidebar.explorerDeleteConfirm", {
                    defaultValue: "Delete '{{name}}'? This cannot be undone.",
                    values: { name: entryName },
                  })}
            </span>
          </div>
          <div className="explorer-entry-context-menu-actions">
            <button
              disabled={isSubmitting}
              onClick={() => setMode("actions")}
              type="button"
            >
              {t("common.cancel", { defaultValue: "Cancel" })}
            </button>
            <button
              className="danger"
              disabled={isSubmitting}
              onClick={() => void handleDelete()}
              type="button"
            >
              {isMultiSelect
                ? t("sidebar.explorerMultiSelectDelete", {
                    defaultValue: "Delete",
                    values: { count: selectedCount },
                  })
                : t("sidebar.explorerDelete", { defaultValue: "Delete" })}
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
