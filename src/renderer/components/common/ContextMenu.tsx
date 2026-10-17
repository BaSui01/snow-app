import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type ContextMenuItem = {
  id: string;
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  /** 置灰禁用（如对已删除文件执行打开操作）。 */
  disabled?: boolean;
  /** 危险操作样式（红色文字，如放弃修改）。 */
  danger?: boolean;
  /** 为 true 时在该项之前插入分隔线。 */
  separator?: boolean;
  /** 分隔线旁显示的分组文字（仅 separator 为 true 时生效）。 */
  separatorLabel?: string;
};

type ContextMenuProps = {
  /** 右键时的鼠标坐标（viewport 坐标）。 */
  x: number;
  y: number;
  /** 主菜单项。 */
  items: ContextMenuItem[];
  /** 分隔线下方的附加菜单项（如“关闭标签页”）。 */
  footerItems?: ContextMenuItem[];
  /** 附加菜单项上方分隔线旁显示的分组文字。 */
  footerLabel?: string;
  onClose: () => void;
  /** Opt-in focus and keyboard navigation; legacy callers retain their behavior. */
  keyboardNavigation?: boolean;
  returnFocusTo?: HTMLElement | null;
  ariaLabel?: string;
};

const MENU_MIN_WIDTH = 150;

/**
 * 通用右键菜单：portal 渲染在鼠标点击处，
 * 越界时自动收进视口；点击外部或按 Esc 关闭。
 */
export function ContextMenu({
  x,
  y,
  items,
  footerItems,
  footerLabel,
  onClose,
  keyboardNavigation = false,
  returnFocusTo,
  ariaLabel,
}: ContextMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [top, setTop] = useState(y);
  const [measuredLeft, setMeasuredLeft] = useState(x);

  // Legacy callers retain their original positioning and focus behavior.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    if (rect.bottom > window.innerHeight) {
      setTop(Math.max(8, window.innerHeight - rect.height - 8));
    } else if (rect.top < 8) {
      setTop(8);
    }
    if (keyboardNavigation) {
      setMeasuredLeft(
        Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      );
      menu
        .querySelector<HTMLButtonElement>(
          'button[role="menuitem"]:not(:disabled)',
        )
        ?.focus({ preventScroll: true });
    }
  }, [keyboardNavigation]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        if (keyboardNavigation) {
          event.preventDefault();
          event.stopPropagation();
          // Only explicit Escape restores focus, never cleanup or outside clicks.
          if (
            menuRef.current?.contains(document.activeElement) &&
            returnFocusTo?.isConnected
          )
            returnFocusTo.focus({ preventScroll: true });
        }
        onClose();
      }
    };
    const handleFocusIn = (event: FocusEvent): void => {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target)
      )
        onClose();
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown, keyboardNavigation);
    if (keyboardNavigation) window.addEventListener("focusin", handleFocusIn);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown, keyboardNavigation);
      if (keyboardNavigation)
        window.removeEventListener("focusin", handleFocusIn);
    };
  }, [onClose, keyboardNavigation, returnFocusTo]);

  const left = keyboardNavigation
    ? measuredLeft
    : Math.min(x, window.innerWidth - MENU_MIN_WIDTH - 8);

  const renderSeparator = (label?: string): React.JSX.Element =>
    label ? (
      <div
        className="context-menu-separator labeled"
        role="separator"
        aria-label={label}
      >
        <span className="context-menu-separator-label">{label}</span>
      </div>
    ) : (
      <div className="context-menu-separator" role="separator" />
    );

  const renderItem = (item: ContextMenuItem): React.JSX.Element => (
    <div key={item.id}>
      {item.separator && renderSeparator(item.separatorLabel)}
      <button
        type="button"
        className={`context-menu-item${item.disabled ? " disabled" : ""}${
          item.danger ? " danger" : ""
        }`}
        role="menuitem"
        disabled={item.disabled}
        onClick={item.onClick}
      >
        {item.icon}
        <span>{item.label}</span>
      </button>
    </div>
  );

  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      aria-label={ariaLabel}
      onKeyDown={
        keyboardNavigation
          ? (event) => {
              if (event.key === "Tab") {
                onClose();
                return;
              }
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
                return;
              event.preventDefault();
              event.stopPropagation();
              const buttons = Array.from(
                menuRef.current?.querySelectorAll<HTMLButtonElement>(
                  'button[role="menuitem"]:not(:disabled)',
                ) ?? [],
              );
              if (!buttons.length) return;
              const index = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? buttons.length - 1
                    : event.key === "ArrowDown"
                      ? (index + 1) % buttons.length
                      : (index - 1 + buttons.length) % buttons.length;
              buttons[next].focus({ preventScroll: true });
            }
          : undefined
      }
      style={{
        left: Math.max(8, left),
        top: Math.max(8, top),
        ...(keyboardNavigation
          ? {
              maxWidth: "calc(100vw - 16px)",
              maxHeight: "calc(100vh - 16px)",
              overflow: "auto",
            }
          : {}),
      }}
    >
      {items.map(renderItem)}
      {footerItems && footerItems.length > 0 && (
        <>
          {renderSeparator(footerLabel)}
          {footerItems.map(renderItem)}
        </>
      )}
    </div>,
    document.body,
  );
}
