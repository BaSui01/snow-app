import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Folder,
  Loader2,
  MessageSquareMore,
} from "lucide-react";

import { useI18n } from "../../../../i18n";
import { SidebarCollapse } from "../SidebarCollapse";
import { formatTimeLabel, parseDbTimestamp } from "../chatTimeGroup";
import type {
  CrossProjectNotification,
  CrossProjectNotificationGroup,
} from "../useCrossProjectNotifications";

type CrossProjectNotificationListProps = {
  groups: CrossProjectNotificationGroup[];
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenNotification: (
    group: CrossProjectNotificationGroup,
    notification: CrossProjectNotification,
  ) => void;
};

export function CrossProjectNotificationList({
  groups,
  isCollapsed,
  onToggleCollapsed,
  onOpenNotification,
}: CrossProjectNotificationListProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="cross-project-notifications">
      <button
        type="button"
        className="cross-project-notifications-header"
        onClick={onToggleCollapsed}
        aria-expanded={!isCollapsed}
        title={t("sidebar.crossProjectToggleCollapse", {
          defaultValue: "Collapse/expand other project notifications",
        })}
      >
        <ChevronRight
          size={12}
          className={
            isCollapsed ? "" : "cross-project-notifications-chevron--open"
          }
        />
        <span>
          {t("sidebar.crossProjectNotificationsTitle", {
            defaultValue: "Other projects",
          })}
        </span>
      </button>
      <SidebarCollapse open={!isCollapsed}>
        {groups.map((group) => (
          <div
            className="cross-project-notification-group"
            key={group.directoryId}
          >
            <div className="cross-project-notification-project">
              <Folder size={11} aria-hidden="true" />
              <span className="cross-project-notification-project-name">
                {group.directoryName}
              </span>
              <span className="cross-project-notification-project-count">
                {group.notifications.length}
              </span>
            </div>
            {group.notifications.map((notification) => {
              const conversation = notification.conversation;
              const displayName =
                conversation.summary ||
                conversation.title ||
                t("sidebar.untitledChat", {
                  defaultValue: "Untitled",
                });
              const parsedDate = parseDbTimestamp(conversation.updatedAt);
              const timeLabel = formatTimeLabel(parsedDate, new Date(), t);
              return (
                <button
                  type="button"
                  className="cross-project-notification-item"
                  key={conversation.conversationId}
                  onClick={() => onOpenNotification(group, notification)}
                  title={t("sidebar.crossProjectNotificationOpenTitle", {
                    values: {
                      project: group.directoryName,
                      conversation: displayName,
                    },
                    defaultValue: "Open {{conversation}} in {{project}}",
                  })}
                >
                  <span
                    className={`chat-item-icon${
                      notification.isAttentionRequired
                        ? " attention-required"
                        : notification.isStreaming
                          ? " streaming"
                          : notification.isCompleted
                            ? " completed"
                            : ""
                    }`}
                  >
                    {notification.isAttentionRequired ? (
                      <CircleAlert size={12} aria-hidden="true" />
                    ) : notification.isStreaming ? (
                      <Loader2 size={11} className="spin" aria-hidden="true" />
                    ) : notification.isCompleted ? (
                      <CheckCircle2 size={12} aria-hidden="true" />
                    ) : (
                      <MessageSquareMore size={11} aria-hidden="true" />
                    )}
                  </span>
                  <span className="list-label">{displayName}</span>
                  <span className="cross-project-notification-time">
                    {timeLabel}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </SidebarCollapse>
    </div>
  );
}