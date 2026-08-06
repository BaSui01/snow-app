import {
  CircleDot,
  Ellipsis,
  FileSearch,
  Pencil,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useI18n } from "../../../i18n";
import { ConfirmDialog } from "../../common/ConfirmDialog";
import { useMenuPosition } from "./useMenuPosition";

type WorkspaceDirectoryMenuProps = {
  canDelete?: boolean;
  disabled?: boolean;
  /** 当前目录是否为活动目录（控制“设为活动目录”菜单项的显隐） */
  isActive?: boolean;
  onActivate?: () => void;
  onDelete: () => void;
  onOpenChange?: (isOpen: boolean) => void;
  onRename?: () => void;
  onShowDetails?: () => void;
  /** 右键菜单锚点（光标位置）：非空时菜单以该点定位并保持打开 */
  contextMenuAnchor?: { x: number; y: number } | null;
  /** 右键菜单关闭回调（父组件用于清空锚点） */
  onContextMenuClose?: () => void;
};

export function WorkspaceDirectoryMenu({
  canDelete = true,
  disabled,
  isActive = false,
  onActivate,
  onDelete,
  onOpenChange,
  onRename,
  onShowDetails,
  contextMenuAnchor = null,
  onContextMenuClose,
}: WorkspaceDirectoryMenuProps): React.JSX.Element {
  const { t } = useI18n();
  const [isButtonOpen, setIsButtonOpen] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  // 右键锚点存在时菜单即为打开状态
  const isOpen = isButtonOpen || contextMenuAnchor !== null;
  const containerRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const onContextMenuCloseRef = useRef(onContextMenuClose);
  onContextMenuCloseRef.current = onContextMenuClose;

  const { position: menuPosition } = useMenuPosition({
    isOpen,
    placement: "auto-up-down",
    triggerRef,
    panelRef: menuRef,
    anchorPoint: contextMenuAnchor,
  });

  useEffect(() => {
    onOpenChangeRef.current?.(isOpen);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    // 关闭菜单：清空按钮态与右键锚点态
    const closeMenu = (): void => {
      setIsButtonOpen(false);
      onContextMenuCloseRef.current?.();
      setShowConfirm(false);
    };

    const handleClickOutside = (event: MouseEvent): void => {
      // 右键按下不立即关闭：由 document 级 contextmenu 监听统一处理，
      // 允许在同一行上连续右键时直接重新定位菜单，避免闪烁。
      if (event.button === 2) {
        return;
      }

      const target = event.target as Node;

      if (
        (containerRef.current && containerRef.current.contains(target)) ||
        (menuRef.current && menuRef.current.contains(target))
      ) {
        return;
      }

      closeMenu();
    };

    // 其它区域右键时关闭本菜单（目标行会自行打开自己的菜单）。
    // 注意：右键发生在同一目录行内任意位置（而非仅三点按钮）时，
    // 需要让本行自行重新定位菜单，因此用 closest(".workspace-directory-row")
    // 比较所在行，而不能只用 containerRef（它只包裹三点按钮）。
    const handleGlobalContextMenu = (event: MouseEvent): void => {
      const target = event.target as Node;

      const isSameRow =
        target instanceof Element &&
        containerRef.current instanceof Element &&
        containerRef.current.closest(".workspace-directory-row") !== null &&
        containerRef.current.closest(".workspace-directory-row") ===
          target.closest(".workspace-directory-row");

      if (
        (containerRef.current && containerRef.current.contains(target)) ||
        (menuRef.current && menuRef.current.contains(target)) ||
        isSameRow
      ) {
        return;
      }

      closeMenu();
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("contextmenu", handleGlobalContextMenu);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("contextmenu", handleGlobalContextMenu);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  const handleToggle = (event: React.SyntheticEvent): void => {
    event.stopPropagation();
    event.preventDefault();
    // 点击 … 按钮切换按钮菜单；若右键菜单正打开则先清空锚点
    setIsButtonOpen((prev) => !prev);
    onContextMenuCloseRef.current?.();
    setShowConfirm(false);
  };

  const handleActivateClick = (): void => {
    onActivate?.();
    setIsButtonOpen(false);
    onContextMenuCloseRef.current?.();
  };

  const handleRenameClick = (): void => {
    onRename?.();
    setIsButtonOpen(false);
    onContextMenuCloseRef.current?.();
  };

  const handleDeleteClick = (): void => {
    setIsButtonOpen(false);
    onContextMenuCloseRef.current?.();
    setShowConfirm(true);
  };

  const handleShowDetailsClick = (): void => {
    setIsButtonOpen(false);
    onContextMenuCloseRef.current?.();
    setShowConfirm(false);
    onShowDetails?.();
  };

  const handleDeleteConfirm = (): void => {
    onDelete();
    setIsButtonOpen(false);
    onContextMenuCloseRef.current?.();
    setShowConfirm(false);
  };

  const handleDeleteCancel = (): void => {
    setShowConfirm(false);
  };

  return (
    <>
      <span className="workspace-directory-actions-wrapper" ref={containerRef}>
        <span
          aria-expanded={isOpen}
          aria-haspopup="menu"
          className="workspace-directory-actions"
          onClick={handleToggle}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              handleToggle(event);
            }
          }}
          ref={triggerRef}
          role="button"
          tabIndex={0}
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
                {!isActive ? (
                  <button
                    type="button"
                    className="workspace-directory-menu-item"
                    onClick={handleActivateClick}
                    role="menuitem"
                  >
                    <CircleDot size={13} />
                    <span>
                      {t("sidebar.directoryActionActivate", {
                        defaultValue: "Set as active",
                      })}
                    </span>
                  </button>
                ) : null}
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
                {onRename ? (
                  <button
                    type="button"
                    className="workspace-directory-menu-item"
                    onClick={handleRenameClick}
                    role="menuitem"
                  >
                    <Pencil size={13} />
                    <span>
                      {t("sidebar.directoryActionRename", {
                        defaultValue: "Rename",
                      })}
                    </span>
                  </button>
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
              </div>,
              document.body
            )
          : null}
      </span>
      <ConfirmDialog
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        confirmLabel={t("sidebar.deleteDirectory", { defaultValue: "Delete" })}
        message={t("sidebar.directoryDeleteConfirm", {
          defaultValue: "Are you sure you want to delete this directory?",
        })}
        onCancel={handleDeleteCancel}
        onConfirm={handleDeleteConfirm}
        open={showConfirm}
        title={t("sidebar.deleteDirectoryTitle", {
          defaultValue: "Delete directory",
        })}
        variant="danger"
      />
    </>
  );
}
