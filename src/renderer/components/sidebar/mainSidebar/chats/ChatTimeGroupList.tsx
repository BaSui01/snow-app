import { Check, ChevronRight, Minus } from "lucide-react";
import { Fragment, type ReactNode } from "react";

import { useI18n } from "../../../../i18n";
import type { ChatConversationRecord } from "../../../../../preload";
import { SidebarCollapse } from "../SidebarCollapse";
import type { TimeGroup, TimeGroupKey } from "../chatTimeGroup";

type ChatTimeGroupListProps = {
  groups: TimeGroup[];
  collapsedGroupKeys: Record<string, boolean>;
  isMultiSelectMode: boolean;
  selectedIds: Set<string>;
  getGroupLabel: (key: TimeGroupKey) => string;
  onToggleGroupCollapsed: (key: TimeGroupKey) => void;
  isMultiSelectable: (conversation: ChatConversationRecord) => boolean;
  onToggleGroupSelect: (group: TimeGroup) => void;
  renderRow: (conversation: ChatConversationRecord) => ReactNode;
};

export function ChatTimeGroupList({
  groups,
  collapsedGroupKeys,
  isMultiSelectMode,
  selectedIds,
  getGroupLabel,
  onToggleGroupCollapsed,
  isMultiSelectable,
  onToggleGroupSelect,
  renderRow,
}: ChatTimeGroupListProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <>
      {groups.map((group) => {
        const isGroupCollapsed = collapsedGroupKeys[group.key] === true;
        // 分组粒度的选择状态：全部已选 / 部分已选 / 未选
        const groupSelectableIds = group.conversations
          .filter(isMultiSelectable)
          .map((conv) => conv.conversationId);
        const groupSelectedCount = groupSelectableIds.filter((id) =>
          selectedIds.has(id),
        ).length;
        const isGroupAllSelected =
          groupSelectableIds.length > 0 &&
          groupSelectedCount === groupSelectableIds.length;
        const isGroupPartialSelected =
          groupSelectedCount > 0 && !isGroupAllSelected;
        return (
          <div key={group.key}>
            <button
              type="button"
              className="chat-time-group-header"
              onClick={() => onToggleGroupCollapsed(group.key)}
              aria-expanded={!isGroupCollapsed}
              title={t("sidebar.chatToggleCollapse", {
                defaultValue: "Collapse/expand chats",
              })}
            >
              <ChevronRight
                size={12}
                className={
                  isGroupCollapsed ? "" : "chat-time-group-chevron--open"
                }
              />
              <span>{getGroupLabel(group.key)}</span>
              <span className="chat-time-group-count">
                {group.conversations.length}
              </span>
              {isMultiSelectMode && groupSelectableIds.length > 0 && (
                <span
                  className={`chat-time-group-select${
                    isGroupAllSelected ? " checked" : ""
                  }${isGroupPartialSelected ? " indeterminate" : ""}`}
                  role="checkbox"
                  aria-checked={
                    isGroupAllSelected
                      ? true
                      : isGroupPartialSelected
                        ? "mixed"
                        : false
                  }
                  title={
                    isGroupAllSelected
                      ? t("sidebar.chatMultiSelectGroupDeselect", {
                          defaultValue: "Deselect this group",
                        })
                      : t("sidebar.chatMultiSelectGroupSelect", {
                          defaultValue: "Select this group",
                        })
                  }
                  onClick={(event) => {
                    event.stopPropagation();
                    onToggleGroupSelect(group);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      onToggleGroupSelect(group);
                    }
                  }}
                  tabIndex={0}
                >
                  {isGroupAllSelected ? (
                    <Check size={11} strokeWidth={3} />
                  ) : isGroupPartialSelected ? (
                    <Minus size={11} strokeWidth={3} />
                  ) : null}
                </span>
              )}
            </button>
            <SidebarCollapse open={!isGroupCollapsed}>
              {group.conversations.map((conversation) => (
                <Fragment key={conversation.conversationId}>
                  {renderRow(conversation)}
                </Fragment>
              ))}
            </SidebarCollapse>
          </div>
        );
      })}
    </>
  );
}