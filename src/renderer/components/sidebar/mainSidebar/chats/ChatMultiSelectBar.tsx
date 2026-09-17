import {
  Archive,
  ArchiveRestore,
  CheckSquare,
  Loader2,
  Trash2,
  X,
} from "lucide-react";
import type { RefObject } from "react";

import { useI18n } from "../../../../i18n";
import { Tooltip } from "../../../common/Tooltip";

export type ChatMultiSelectAction = {
  key: string;
  label: string;
  icon: "archive" | "restore" | "trash" | "spinner";
  disabled: boolean;
  danger?: boolean;
  onClick: () => void;
};

type ChatMultiSelectBarProps = {
  headerRef?: RefObject<HTMLDivElement | null>;
  selectedCount: number;
  allSelected: boolean;
  isExitDisabled: boolean;
  selectAllDisabled: boolean;
  onExit: () => void;
  onToggleSelectAll: () => void;
  actions: ChatMultiSelectAction[];
};

export function ChatMultiSelectBar({
  headerRef,
  selectedCount,
  allSelected,
  isExitDisabled,
  selectAllDisabled,
  onExit,
  onToggleSelectAll,
  actions,
}: ChatMultiSelectBarProps): React.JSX.Element {
  const { t } = useI18n();
  const selectAllLabel = allSelected
    ? t("sidebar.chatMultiSelectDeselectAll", { defaultValue: "Deselect all" })
    : t("sidebar.chatMultiSelectAll", { defaultValue: "Select all" });

  const renderIcon = (
    icon: ChatMultiSelectAction["icon"],
  ): React.JSX.Element => {
    switch (icon) {
      case "spinner":
        return <Loader2 size={13} className="spin" />;
      case "archive":
        return <Archive size={13} />;
      case "restore":
        return <ArchiveRestore size={13} />;
      default:
        return <Trash2 size={13} />;
    }
  };

  return (
    <div className="chat-multi-select-bar" ref={headerRef}>
      <button
        type="button"
        className="chat-multi-select-exit-btn"
        onClick={onExit}
        disabled={isExitDisabled}
        title={t("sidebar.chatMultiSelectExit", { defaultValue: "Exit" })}
      >
        <X size={14} />
      </button>
      <span className="chat-multi-select-count">
        {t("sidebar.chatMultiSelectCount", {
          defaultValue: "{{count}} selected",
          values: { count: selectedCount },
        })}
      </span>
      <div className="chat-multi-select-actions">
        <Tooltip content={selectAllLabel} placement="bottom">
          <button
            type="button"
            className="chat-multi-select-action-btn"
            onClick={onToggleSelectAll}
            disabled={selectAllDisabled}
          >
            <CheckSquare size={13} />
            <span>{selectAllLabel}</span>
          </button>
        </Tooltip>
        {actions.map((action) => (
          <Tooltip key={action.key} content={action.label} placement="bottom">
            <button
              type="button"
              className={`chat-multi-select-action-btn${
                action.danger ? " danger" : ""
              }`}
              onClick={action.onClick}
              disabled={action.disabled}
            >
              {renderIcon(action.icon)}
              <span>{action.label}</span>
            </button>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
