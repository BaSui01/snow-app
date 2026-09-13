import type { SnowRemoteState } from "../renderer/types/remoteControl";
import { $ } from "./dom";
import { t } from "./i18n";
import { showNotice } from "./notice";
import { createNewChat } from "./threads";
import type { AppContext } from "./types";

/** 顶栏：侧边历史按钮、当前会话标题、工作区与运行状态徽标。 */
export const renderTopbar = (next: SnowRemoteState): void => {
  const active =
    next.conversations.find(
      (conversation) =>
        conversation.conversationId === next.activeConversationId,
    ) ?? null;
  const title = active
    ? active.summary || active.title
    : t("remote.threads.newConversation");
  $("threadTitle").textContent = title || t("remote.threads.untitled");
  $("threadSubtitle").textContent = next.workspace
    ? next.workspace.name
    : t("remote.threads.noWorkspace");
  $("statusDot").className =
    "status-dot" + (next.isStreaming ? " running" : "");
  const runBadge = $("runBadge");
  runBadge.textContent = next.isAborting
    ? t("remote.badge.aborting")
    : next.isStreaming
      ? t("remote.badge.running")
      : t("remote.badge.local");
  runBadge.style.color = next.isStreaming ? "var(--amber)" : "var(--green)";
};

export const initTopbar = (ctx: AppContext): void => {
  $("newChatButton").onclick = async () => {
    try {
      await createNewChat(ctx);
    } catch (error) {
      showNotice((error as Error).message, true);
    }
  };
};
