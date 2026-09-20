import { Plus } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * 「新建」加号按钮 + 下拉菜单（终端 / 浏览器 / 绘图 / 代码库）。
 * 被 TopBar（非 Windows）与 RightPanel 的 tab 操作区（Windows）复用，
 * 自身管理展开状态与点击外部关闭；onOpenChange 供父级同步（如
 * TopBar 需要切换 -webkit-app-region 以免下拉被拖拽区域拦截）。
 */
export type PlusMenuAction =
  "terminal" | "browser" | "drawing" | "codebase" | (string & {});

export type PlusMenuItem = {
  id: PlusMenuAction;
  label: string;
  icon: LucideIcon;
  /** 分组标识：与上一项不同时在下拉菜单中插入分隔线。 */
  section?: string;
  /** 自定义图标节点（插件图标等），优先于 icon。 */
  iconNode?: React.ReactNode;
  title?: string;
};

type PlusMenuButtonProps = {
  items: PlusMenuItem[];
  onAction: (actionId: PlusMenuAction) => void;
  onOpenChange?: (open: boolean) => void;
};

export const PlusMenuButton = ({
  items,
  onAction,
  onOpenChange,
}: PlusMenuButtonProps): React.JSX.Element => {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        onOpenChange?.(false);
      }
    };

    document.addEventListener("pointerdown", handleClickOutside, true);
    return () => {
      document.removeEventListener("pointerdown", handleClickOutside, true);
    };
  }, [isOpen, onOpenChange]);

  const toggleOpen = (): void => {
    const next = !isOpen;
    setIsOpen(next);
    onOpenChange?.(next);
  };

  const handleAction = (actionId: PlusMenuAction): void => {
    onAction(actionId);
    setIsOpen(false);
    onOpenChange?.(false);
  };

  return (
    <div className="top-bar-plus-menu" ref={menuRef}>
      <button
        className={`icon-btn ghost top-bar-plus-btn${isOpen ? " active" : ""}`}
        type="button"
        aria-label="New tab"
        title="New tab"
        aria-expanded={isOpen}
        onClick={toggleOpen}
      >
        <Plus size={16} strokeWidth={1.8} />
      </button>
      {isOpen && (
        <div className="top-bar-plus-dropdown">
          {items.map((item, index) => {
            const ItemIcon = item.icon;
            const previousSection = items[index - 1]?.section;
            return (
              <div className="top-bar-plus-dropdown-group" key={item.id}>
                {index > 0 &&
                  item.section &&
                  item.section !== previousSection && (
                    <div
                      className="top-bar-plus-dropdown-divider"
                      role="separator"
                    />
                  )}
                <button
                  className="top-bar-plus-dropdown-item"
                  type="button"
                  title={item.title ?? item.label}
                  onClick={() => handleAction(item.id)}
                >
                  {item.iconNode ?? <ItemIcon size={13} strokeWidth={1.8} />}
                  <span>{item.label}</span>
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
