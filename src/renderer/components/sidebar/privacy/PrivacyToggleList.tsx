import type { LucideIcon } from "lucide-react";

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
  onToggle: (id: string, checked: boolean) => void;
  onToggleGroup: (ids: string[], checked: boolean) => void;
};

/** 分组开关列表：组头可整组启停，组内逐项启停。 */
export function PrivacyToggleList({
  groups,
  icon: Icon,
  disabled,
  onToggle,
  onToggleGroup,
}: PrivacyToggleListProps): React.JSX.Element {
  return (
    <div className="privacy-option-list">
      {groups.map((group) => {
        const ids = group.items.map((item) => item.id);
        const enabledCount = group.items.filter((item) => item.checked).length;
        const allChecked = enabledCount === group.items.length;
        return (
          <div className="privacy-option-group" key={group.id}>
            <div className="privacy-option-group-header">
              <span className="privacy-option-group-title">
                {group.title}
                <small>
                  {enabledCount}/{group.items.length}
                </small>
              </span>
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
            {group.items.map((item) => (
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
