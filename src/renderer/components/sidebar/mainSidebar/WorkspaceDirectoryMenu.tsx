import {
  AlertTriangle,
  Braces,
  ChevronRight,
  Code2,
  Ellipsis,
  FileSearch,
  Loader2,
  MousePointer2,
  SquareTerminal,
  Terminal,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../../i18n";
import type { IdeInfo, WorkspaceDirectoryKind } from "../../../../preload";
import { useMenuPosition } from "./useMenuPosition";

type WorkspaceDirectoryMenuProps = {
  canDelete?: boolean;
  directoryPath?: string;
  disabled?: boolean;
  kind?: WorkspaceDirectoryKind;
  onDelete: () => void;
  onOpenChange?: (isOpen: boolean) => void;
  onShowDetails?: () => void;
};

const getIdeIcon = (ideId: string): React.JSX.Element => {
  if (ideId === "cursor") {
    return <MousePointer2 size={13} />;
  }
  if (ideId === "sublime" || ideId === "zed") {
    return <Terminal size={13} />;
  }
  if (
    ideId === "intellij" ||
    ideId === "webstorm" ||
    ideId === "pycharm" ||
    ideId === "goland" ||
    ideId === "clion" ||
    ideId === "phpstorm" ||
    ideId === "rubymine" ||
    ideId === "rider" ||
    ideId === "datagrip" ||
    ideId === "fleet"
  ) {
    return <Braces size={13} />;
  }
  if (ideId === "android-studio" || ideId === "xcode") {
    return <SquareTerminal size={13} />;
  }
  return <Code2 size={13} />;
};

export function WorkspaceDirectoryMenu({
  canDelete = true,
  directoryPath,
  disabled,
  kind,
  onDelete,
  onOpenChange,
  onShowDetails,
}: WorkspaceDirectoryMenuProps): React.JSX.Element {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [isOpenWithOpen, setIsOpenWithOpen] = useState(false);
  const [installedIdes, setInstalledIdes] = useState<IdeInfo[]>([]);
  const [isLoadingIdes, setIsLoadingIdes] = useState(false);
  const [ideError, setIdeError] = useState<string | null>(null);
  const containerRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const openWithItemRef = useRef<HTMLButtonElement>(null);
  const openWithPanelRef = useRef<HTMLDivElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const idesLoadedRef = useRef(false);
  const openWithCloseTimerRef = useRef<number | null>(null);

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
    []
  );

  const { position: menuPosition } = useMenuPosition({
    isOpen,
    placement: "auto-up-down",
    triggerRef,
    panelRef: menuRef,
  });

  const { position: openWithPosition } = useMenuPosition({
    isOpen: isOpenWithOpen,
    placement: "auto-left-right",
    triggerRef: openWithItemRef,
    panelRef: openWithPanelRef,
  });

  useEffect(() => {
    onOpenChangeRef.current?.(isOpen);
  }, [isOpen]);

  const canOpenWith = kind !== "ssh" && Boolean(directoryPath);

  useEffect(() => {
    if (!isOpen || !canOpenWith || idesLoadedRef.current) {
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
              })
        );
      })
      .finally(() => setIsLoadingIdes(false));
  }, [isOpen, canOpenWith, t]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleClickOutside = (event: MouseEvent): void => {
      const target = event.target as Node;

      if (
        (containerRef.current && containerRef.current.contains(target)) ||
        (menuRef.current && menuRef.current.contains(target)) ||
        // 二级菜单是独立 portal，不在外层菜单内部，需单独纳入内部判定，
        // 否则点击 IDE 项时 mousedown 会先关闭整个菜单导致点击失效
        (openWithPanelRef.current && openWithPanelRef.current.contains(target))
      ) {
        return;
      }

      setIsOpen(false);
      setShowConfirm(false);
      setIsOpenWithOpen(false);
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  const handleToggle = (event: React.SyntheticEvent): void => {
    event.stopPropagation();
    event.preventDefault();
    setIsOpen((prev) => !prev);
    setShowConfirm(false);
    setIsOpenWithOpen(false);
  };

  const handleDeleteClick = (): void => {
    setShowConfirm(true);
    setIsOpenWithOpen(false);
  };

  const handleShowDetailsClick = (): void => {
    setIsOpen(false);
    setShowConfirm(false);
    setIsOpenWithOpen(false);
    onShowDetails?.();
  };

  const handleDeleteConfirm = (): void => {
    onDelete();
    setIsOpen(false);
    setShowConfirm(false);
    setIsOpenWithOpen(false);
  };

  const handleDeleteCancel = (): void => {
    setShowConfirm(false);
  };

  const handleOpenWithToggle = (event: React.SyntheticEvent): void => {
    event.stopPropagation();
    event.preventDefault();
    setIsOpenWithOpen((prev) => !prev);
  };

  const handleOpenInIde = (ide: IdeInfo): void => {
    if (!directoryPath) {
      return;
    }
    void window.snow.openInIde(ide.id, directoryPath).catch((error) => {
      // 打开失败时重新展开二级菜单，让用户能看到具体错误
      setIdeError(
        error instanceof Error
          ? error.message
          : t("sidebar.openInIdeError", {
              defaultValue: "Failed to open project in IDE",
            })
      );
      setIsOpenWithOpen(true);
    });
    setIsOpen(false);
    setShowConfirm(false);
    setIsOpenWithOpen(false);
  };

  const renderOpenWithItems = (): React.JSX.Element => (
    <>
      {isLoadingIdes ? (
        <div className="workspace-directory-menu-submenu-status">
          <Loader2 className="spin" size={12} />
          <span>
            {t("sidebar.openWithLoading", {
              defaultValue: "Detecting installed IDEs...",
            })}
          </span>
        </div>
      ) : installedIdes.length === 0 ? (
        <div className="workspace-directory-menu-submenu-status">
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
            className="workspace-directory-menu-item"
            onClick={() => handleOpenInIde(ide)}
            role="menuitem"
            title={ide.executable}
          >
            {getIdeIcon(ide.id)}
            <span>{ide.name}</span>
          </button>
        ))
      )}
      {ideError ? (
        <div className="workspace-directory-menu-submenu-status error">
          <span>{ideError}</span>
        </div>
      ) : null}
    </>
  );

  return (
    <span className="workspace-directory-actions-wrapper" ref={containerRef}>
      <span
        className="workspace-directory-actions"
        ref={triggerRef}
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={handleToggle}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            handleToggle(event);
          }
        }}
      >
        <Ellipsis size={14} />
      </span>
      {isOpen
        ? createPortal(
            <div
              ref={menuRef}
              className="workspace-directory-menu"
              style={
                menuPosition
                  ? { top: menuPosition.top, left: menuPosition.left }
                  : undefined
              }
              role="menu"
            >
              {showConfirm ? (
                <>
                  <div className="workspace-directory-menu-confirm">
                    <AlertTriangle
                      size={13}
                      className="workspace-directory-menu-confirm-icon"
                    />
                    <span className="workspace-directory-menu-confirm-text">
                      {t("sidebar.directoryDeleteConfirm", {
                        defaultValue:
                          "Are you sure you want to delete this directory?",
                      })}
                    </span>
                  </div>
                  <div className="workspace-directory-menu-confirm-actions">
                    <button
                      type="button"
                      className="workspace-directory-menu-confirm-btn cancel"
                      onClick={handleDeleteCancel}
                    >
                      {t("common.cancel", { defaultValue: "Cancel" })}
                    </button>
                    <button
                      type="button"
                      className="workspace-directory-menu-confirm-btn delete"
                      onClick={handleDeleteConfirm}
                    >
                      {t("sidebar.deleteDirectory", {
                        defaultValue: "Delete",
                      })}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="workspace-directory-menu-item"
                    onClick={handleShowDetailsClick}
                    role="menuitem"
                  >
                    <FileSearch size={13} />
                    <span>
                      {t("sidebar.directoryDetails", {
                        defaultValue: "Details",
                      })}
                    </span>
                  </button>
                  {canOpenWith ? (
                    <span
                      className="workspace-directory-menu-submenu-trigger"
                      onMouseEnter={() => {
                        cancelOpenWithClose();
                        setIsOpenWithOpen(true);
                      }}
                      onMouseLeave={scheduleOpenWithClose}
                    >
                      <button
                        ref={openWithItemRef}
                        type="button"
                        className="workspace-directory-menu-item"
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
                          {t("sidebar.openWith", {
                            defaultValue: "Open with",
                          })}
                        </span>
                        <ChevronRight size={12} className="workspace-directory-menu-item-chevron" />
                      </button>
                      {isOpenWithOpen
                        ? createPortal(
                            <div
                              ref={openWithPanelRef}
                              className="workspace-directory-menu workspace-directory-menu-submenu"
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
                            document.body
                          )
                        : null}
                    </span>
                  ) : null}
                  {canDelete ? (
                    <button
                      type="button"
                      className="workspace-directory-menu-item danger"
                      disabled={disabled}
                      onClick={handleDeleteClick}
                      role="menuitem"
                    >
                      <Trash2 size={13} />
                      <span>
                        {t("sidebar.deleteDirectory", {
                          defaultValue: "Delete",
                        })}
                      </span>
                    </button>
                  ) : null}
                </>
              )}
            </div>,
            document.body
          )
        : null}
    </span>
  );
}
