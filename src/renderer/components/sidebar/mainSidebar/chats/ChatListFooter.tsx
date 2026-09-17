import { Loader2 } from "lucide-react";
import type { RefObject } from "react";

import { useI18n } from "../../../../i18n";

type ChatListFooterProps = {
  sentinelRef: RefObject<HTMLDivElement | null>;
  hasMore: boolean;
  isLoadingMore: boolean;
};

export function ChatListFooter({
  sentinelRef,
  hasMore,
  isLoadingMore,
}: ChatListFooterProps): React.JSX.Element {
  const { t } = useI18n();

  if (!hasMore) {
    return (
      <div className="chat-all-loaded">
        {t("sidebar.chatAllLoaded", {
          defaultValue: "All chats loaded",
        })}
      </div>
    );
  }

  return (
    <div
      className={`chat-load-more ${isLoadingMore ? "is-loading" : ""}`}
      ref={sentinelRef}
      role={isLoadingMore ? "status" : undefined}
      aria-live="polite"
      aria-label={
        isLoadingMore
          ? t("sidebar.chatLoadingMore", {
              defaultValue: "Loading more chats...",
            })
          : undefined
      }
    >
      {isLoadingMore ? (
        <>
          <Loader2 className="spin" size={14} aria-hidden="true" />
          <span>
            {t("sidebar.chatLoadingMore", {
              defaultValue: "Loading more chats...",
            })}
          </span>
        </>
      ) : null}
    </div>
  );
}