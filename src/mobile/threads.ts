import type {
  SnowRemoteConversation,
  SnowRemoteState,
} from "../renderer/types/remoteControl";
import {
  fetchMoreConversations,
  selectConversation,
  startNewChat,
} from "./api";
import { $, escapeHtml } from "./dom";
import { relativeTime } from "./format";
import { t } from "./i18n";
import { showNotice } from "./notice";
import {
  beginOverlay,
  closeOverlays,
  hideOverlays,
  rememberOverlayTrigger,
} from "./overlays";
import type { AppContext } from "./types";

/**
 * 会话选择列表（左侧抽屉），按工作区分组。
 *
 * 分页模型：
 * - state 每轮提供每个工作区的最新一页（conversationTotals 里带总数）；
 * - 「加载更多」按 offset = 该组已加载条目数向前翻页，结果累积在
 *   extraByDirectory，与会话内记录一样不受 state 窗口滑动影响；
 * - 列表渲染带签名比较：数据未变化时完全不触碰 DOM（每轮轮询零成本），
 *   只有内容/加载状态变化才重建。
 */

/** 每次「加载更多」的分页大小（与 bridge 首屏页长同量级）。 */
const THREADS_PAGE_SIZE = 20;

/** 通过「加载更多」追加的条目（offset > 首屏页），key = directoryId。 */
const extraByDirectory = new Map<string, SnowRemoteConversation[]>();
/** 分页响应里的总数覆盖（state.conversationTotals 的补充/刷新）。 */
const totalOverrides = new Map<string, number>();
let loadingDirectory: string | null = null;
let lastState: SnowRemoteState | null = null;
let renderedKey = "";

type ThreadGroup = {
  name: string;
  directoryId: string;
  items: SnowRemoteConversation[];
  total: number;
};

/** state 首页 + 本地加载的更多页，按工作区合并去重并排序。 */
const buildGroups = (next: SnowRemoteState): ThreadGroup[] => {
  const groups = new Map<string, ThreadGroup>();
  const stateIds = new Set(
    next.conversations.map((conversation) => conversation.conversationId),
  );
  const add = (conversation: SnowRemoteConversation): void => {
    const name =
      conversation.workspaceName || t("remote.threads.otherWorkspace");
    let group = groups.get(conversation.directoryId);
    if (!group) {
      group = {
        name,
        directoryId: conversation.directoryId,
        items: [],
        total: 0,
      };
      groups.set(conversation.directoryId, group);
    }
    group.items.push(conversation);
  };

  for (const conversation of next.conversations) add(conversation);
  for (const [directoryId, extra] of extraByDirectory) {
    for (const conversation of extra) {
      if (!stateIds.has(conversation.conversationId)) add(conversation);
    }
  }

  for (const group of groups.values()) {
    group.total = Math.max(
      group.items.length,
      totalOverrides.get(group.directoryId) ??
        next.conversationTotals[group.directoryId] ??
        group.items.length,
    );
    group.items.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }
  return Array.from(groups.values());
};

const threadsSignature = (
  next: SnowRemoteState,
  groups: ThreadGroup[],
): string =>
  [
    // 分钟级时间桶：让相对时间标签自然刷新，同时避免每轮重建。
    String(Math.floor(Date.now() / 60000)),
    next.activeConversationId ?? "",
    loadingDirectory ?? "",
    groups
      .map((group) =>
        [
          group.directoryId,
          group.name,
          String(group.total),
          group.items
            .map((conversation) =>
              [
                conversation.conversationId,
                conversation.updatedAt,
                conversation.status,
                conversation.title,
                conversation.summary,
                conversation.lastMessagePreview,
              ].join("\u0003"),
            )
            .join("\u0001"),
        ].join("\u0002"),
      )
      .join("\u0004"),
  ].join("\u0005");

const groupHtml = (
  group: ThreadGroup,
  activeConversationId: string | null,
): string => {
  const items = group.items
    .map((conversation) => {
      const active = conversation.conversationId === activeConversationId;
      return `<button class="thread-item${active ? " active" : ""}" data-conversation="${escapeHtml(conversation.conversationId)}" data-directory="${escapeHtml(conversation.directoryId)}"><span class="thread-item-title">${escapeHtml(conversation.summary || conversation.title || t("remote.threads.untitled"))}</span><span class="thread-item-preview">${escapeHtml(conversation.lastMessagePreview || t("remote.threads.noPreview"))}</span><span class="thread-item-time">${escapeHtml(relativeTime(conversation.updatedAt))}</span></button>`;
    })
    .join("");

  let footer = "";
  if (group.items.length < group.total) {
    const loading = loadingDirectory === group.directoryId;
    const label = loading
      ? t("remote.threads.loading")
      : t("remote.threads.loadMore");
    const disabled = loadingDirectory !== null;
    footer = `<div class="thread-more"><button class="thread-more-button${loading ? " loading" : ""}" type="button" data-load-more="${escapeHtml(group.directoryId)}"${disabled ? " disabled" : ""}>${escapeHtml(label)}</button></div>`;
  }

  return `<section class="workspace-group"><div class="workspace-name">${escapeHtml(group.name)}</div>${items}${footer}</section>`;
};

/** 会话选择列表渲染（由 main.ts 每轮快照调用）。 */
export const renderThreads = (next: SnowRemoteState): void => {
  lastState = next;
  const groups = buildGroups(next);
  const key = threadsSignature(next, groups);
  if (key === renderedKey) return;
  renderedKey = key;

  const html = groups
    .map((group) => groupHtml(group, next.activeConversationId ?? null))
    .join("");
  $("threadList").innerHTML =
    html || `<div class="empty">${t("remote.threads.empty")}</div>`;
};

const loadMoreConversations = async (directoryId: string): Promise<void> => {
  if (loadingDirectory || !lastState) return;
  const group = buildGroups(lastState).find(
    (item) => item.directoryId === directoryId,
  );
  if (!group) return;

  loadingDirectory = directoryId;
  renderThreads(lastState);
  try {
    const page = await fetchMoreConversations(
      directoryId,
      group.items.length,
      THREADS_PAGE_SIZE,
    );
    const known = new Set([
      ...lastState.conversations.map(
        (conversation) => conversation.conversationId,
      ),
      ...(extraByDirectory.get(directoryId) ?? []).map(
        (conversation) => conversation.conversationId,
      ),
    ]);
    const extra = extraByDirectory.get(directoryId) ?? [];
    for (const conversation of page.items) {
      if (known.has(conversation.conversationId)) continue;
      known.add(conversation.conversationId);
      extra.push(conversation);
    }
    extraByDirectory.set(directoryId, extra);
    totalOverrides.set(directoryId, page.total);
  } catch (error) {
    showNotice(
      (error as Error).message || t("remote.threads.loadMoreFailed"),
      true,
    );
  } finally {
    loadingDirectory = null;
    if (lastState) renderThreads(lastState);
  }
};

/** 新建会话：创建 → 失效消息区缓存 → 提示 → 刷新快照（顶栏按钮与动作面板共用）。 */
export const createNewChat = async (ctx: AppContext): Promise<void> => {
  await startNewChat();
  ctx.invalidateTimeline();
  showNotice(t("remote.notice.newChatCreated"));
  await ctx.refresh(false);
};

const openThreadSheet = (): void => {
  rememberOverlayTrigger();
  hideOverlays();
  beginOverlay();
  $("scrim").classList.add("open");
  $("threadSheet").classList.add("open");
};

export const initThreads = (ctx: AppContext): void => {
  $("historyButton").onclick = openThreadSheet;
  $("closeSheet").onclick = () => {
    closeOverlays(false);
  };
  $("scrim").onclick = () => {
    closeOverlays(false);
  };
  $("threadList").onclick = async (event) => {
    const target = event.target as HTMLElement;
    const loadMoreButton = target.closest<HTMLElement>("[data-load-more]");
    if (loadMoreButton) {
      const directoryId = loadMoreButton.dataset.loadMore ?? "";
      if (directoryId) await loadMoreConversations(directoryId);
      return;
    }
    const button = target.closest<HTMLElement>(".thread-item");
    if (!button) return;
    closeOverlays(false);
    showNotice(t("remote.notice.switchingConversation"));
    try {
      await selectConversation(
        button.dataset.conversation ?? "",
        button.dataset.directory ?? "",
      );
      ctx.invalidateTimeline();
      await ctx.refresh(false);
      showNotice(t("remote.notice.conversationSelected"));
    } catch (error) {
      showNotice((error as Error).message, true);
    }
  };
};
