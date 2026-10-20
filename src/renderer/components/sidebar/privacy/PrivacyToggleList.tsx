import { ChevronDown, type LucideIcon } from "lucide-react";
import { useState } from "react";

export type PrivacyToggleItem = {
  id: string;
  title: string;
  subtitle?: string;
  checked: boolean;
};

export type PrivacyToggleGroup = {
  id: string;
  title: string;
  items: PrivacyToggleItem[];
};

type PrivacyToggleListProps = {
  groups: PrivacyToggleGroup[];
  icon: LucideIcon;
  disabled: boolean;
  /** 分组是否默认收起，组头始终可手动展开/收起。 */
  defaultCollapsed?: boolean;
  onToggle: (id: string, checked: boolean) => void;
  onToggleGroup: (ids: string[], checked: boolean) => void;
};

/** 分组开关列表：组头可整组启停，组内逐项启停，组头可折叠。 */
export function PrivacyToggleList({
  groups,
  icon: Icon,
  disabled,
  defaultCollapsed = false,
  onToggle,
  onToggleGroup,
}: PrivacyToggleListProps): React.JSX.Element {
  const [collapsedOverrides, setCollapsedOverrides] = useState<
    Record<string, boolean>
  >({});
  return (
    <div className="privacy-option-list">
      {groups.map((group) => {
        const ids = group.items.map((item) => item.id);
        const enabledCount = group.items.filter((item) => item.checked).length;
        const allChecked = enabledCount === group.items.length;
        const collapsed = collapsedOverrides[group.id] ?? defaultCollapsed;
        return (
          <div className="privacy-option-group" key={group.id}>
            <div className="privacy-option-group-header">
              <button
                type="button"
                className={`privacy-option-group-toggle${collapsed ? " is-collapsed" : ""}`}
                onClick={() =>
                  setCollapsedOverrides((previous) => ({
                    ...previous,
                    [group.id]: !collapsed,
                  }))
                }
                aria-expanded={!collapsed}
              >
                <ChevronDown
                  className="privacy-option-group-chevron"
                  size={14}
                />
                <span className="privacy-option-group-title">
                  {group.title}
                  <small>
                    {enabledCount}/{group.items.length}
                  </small>
                </span>
              </button>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={() => onToggleGroup(ids, !allChecked)}
                  disabled={disabled}
                  hidden
                />
                <span className="toggle-slider" />
              </label>
            </div>
            {collapsed
              ? null
              : group.items.map((item) => (
                  <label
                    className="sub-agent-tool-option toggle-switch"
                    key={item.id}
                  >
                    <input
                      type="checkbox"
                      checked={item.checked}
                      onChange={() => onToggle(item.id, !item.checked)}
                      disabled={disabled}
                      hidden
                    />
                    <span className="toggle-slider" />
                    <Icon size={14} />
                    <span className="sub-agent-tool-option-content">
                      <strong>{item.title}</strong>
                      {item.subtitle ? <small>{item.subtitle}</small> : null}
                    </span>
                  </label>
                ))}
          </div>
        );
      })}
    </div>
  );
}
