import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";

import { useI18n } from "../../i18n";
import { useChatConversationContext } from "../mainContent/chatMessages";
import { isPendingSessionKey } from "../mainContent/chatMessages/utils/conversationTypes";
import type { ConversationTabData, RightPanelTab } from "./types";
import { useDetachedWindowShortcuts } from "./useDetachedWindowShortcuts";

/** 会话列表变化通知主窗口的合并窗口（毫秒）。 */
const LIST_NOTIFY_DEBOUNCE_MS = 300;

/** 已绑定会话的 tab id（按会话稳定，便于查找）。 */
const conversationTabId = (conversationId: string): string =>
  `conversation:${conversationId}`;

/** 会话 tab 绑定的会话 id；新会话草稿 tab（尚未发送）为 null。 */
export const getTabConversationId = (tab: RightPanelTab): string | null => {
  if (tab.type !== "conversation") {
    return null;
  }
  const conversationId =
    (tab.data as ConversationTabData | undefined)?.conversationId ?? "";
  return conversationId ? conversationId : null;
};

type DetachedConversationSyncProps = {
  tabs: RightPanelTab[];
  setTabs: Dispatch<SetStateAction<RightPanelTab[]>>;
  activeTabId: string;
  setActiveTabId: Dispatch<SetStateAction<string>>;
  /** 面板「+」菜单「新建会话」的入口：新增一个新会话草稿 tab 并激活。 */
  createTabRef: { current: (() => void) | null };
};

/**
 * 独立面板窗口：会话 tab 与会话运行时的同步（不渲染任何内容）。
 * - 活动会话 tab 切换 -> 选中对应会话；新会话草稿 tab -> 进入新会话；
 * - 活动会话变化（会话卡片、主窗口激活请求等）且没有对应 tab -> 新增并激活；
 * - 新会话草稿首次发送后，tab 改绑为该真实会话；
 * - 子代理 / Workflow 节点会话随所属会话展开为 tab；
 * - 把归属会话 id（tab 中的会话与运行中的会话）上报主进程，供主窗口拦截点击。
 */
export const DetachedConversationSync = ({
  tabs,
  setTabs,
  activeTabId,
  setActiveTabId,
  createTabRef,
}: DetachedConversationSyncProps): null => {
  const { t } = useI18n();
  const {
    activeConversationId,
    handleSelectConversation,
    handleNewChat,
    releaseConversationSessions,
    streamingConversationIds,
    attentionRequiredConversationIds,
    conversationListVersion,
    conversationTreeVersion,
    upsertedConversation,
    rollbackNewChatState,
  } = useChatConversationContext();
  useDetachedWindowShortcuts(createTabRef);

  const untitledTitle = t("sidebar.untitledChat", { defaultValue: "Untitled" });
  const newChatTitle = t("sidebar.newChat", { defaultValue: "New Chat" });

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const activeConversationIdRef = useRef(activeConversationId);
  activeConversationIdRef.current = activeConversationId;
  const handleSelectRef = useRef(handleSelectConversation);
  handleSelectRef.current = handleSelectConversation;
  const handleNewChatRef = useRef(handleNewChat);
  handleNewChatRef.current = handleNewChat;
  const releaseRef = useRef(releaseConversationSessions);
  releaseRef.current = releaseConversationSessions;

  // 当前绑定运行时新会话草稿的 tab：首次发送后草稿迁移为真实会话，tab 改绑该会话。
  const boundNewChatTabIdRef = useRef<string | null>(null);
  const newChatSeqRef = useRef(0);
  // 已展开过子树的父会话；树版本变化（子代理 / Workflow 节点变化）后清空重新展开。
  const expandedParentIdsRef = useRef<Set<string>>(new Set());
  const treeVersionRef = useRef(conversationTreeVersion);
  // 用户关闭的会话 tab：子树展开不再自动打开它们。
  const dismissedIdsRef = useRef<Set<string>>(new Set());
  // 已从 tab 移除、待释放缓存的会话（仍在运行或为活动会话时延后释放）。
  const pendingReleaseRef = useRef<Set<string>>(new Set());
  const prevConversationIdsRef = useRef<Set<string>>(new Set());

  const resolveTitle = async (conversationId: string): Promise<string> => {
    const record = await window.snow
      .getChatConversation(conversationId)
      .catch(() => null);
    return record
      ? record.summary || record.title || untitledTitle
      : untitledTitle;
  };

  const openConversationTab = async (
    conversationId: string,
    activate: boolean,
  ): Promise<void> => {
    const title = await resolveTitle(conversationId);
    const id = conversationTabId(conversationId);
    setTabs((prev) =>
      prev.some((tab) => getTabConversationId(tab) === conversationId)
        ? prev
        : [
            ...prev,
            { id, type: "conversation", title, data: { conversationId } },
          ],
    );
    if (activate) {
      setActiveTabId(id);
    }
  };
  const openConversationTabRef = useRef(openConversationTab);
  openConversationTabRef.current = openConversationTab;

  createTabRef.current = (): void => {
    newChatSeqRef.current += 1;
    const id = `conversation:new:${newChatSeqRef.current}`;
    setTabs((prev) => [
      ...prev,
      {
        id,
        type: "conversation",
        title: newChatTitle,
        data: { conversationId: "" },
      },
    ]);
    setActiveTabId(id);
  };

  // 运行时活动会话变化 -> tab：草稿迁移为真实会话时改绑当前草稿 tab；
  // 否则已有对应 tab 则激活，没有则新增并激活（如会话卡片打开的子代理）。
  useEffect(() => {
    if (!activeConversationId || isPendingSessionKey(activeConversationId)) {
      return;
    }
    const conversationId = activeConversationId;
    dismissedIdsRef.current.delete(conversationId);
    const boundId = boundNewChatTabIdRef.current;
    if (
      boundId !== null &&
      boundId === activeTabIdRef.current &&
      !tabsRef.current.some(
        (tab) => getTabConversationId(tab) === conversationId,
      )
    ) {
      boundNewChatTabIdRef.current = null;
      // tab id 保持不变，聊天视图不会因此重建。
      setTabs((prev) =>
        prev.map((tab) =>
          tab.id === boundId ? { ...tab, data: { conversationId } } : tab,
        ),
      );
      void resolveTitle(conversationId).then((title) => {
        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === boundId && getTabConversationId(tab) === conversationId
              ? { ...tab, title }
              : tab,
          ),
        );
      });
      return;
    }
    const existing = tabsRef.current.find(
      (tab) => getTabConversationId(tab) === conversationId,
    );
    if (existing) {
      if (activeTabIdRef.current !== existing.id) {
        setActiveTabId(existing.id);
      }
      return;
    }
    void openConversationTab(conversationId, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId]);

  // 活动 tab -> 运行时：选中会话 tab 的会话；激活新会话草稿 tab 时进入新会话。
  useEffect(() => {
    const tab = tabsRef.current.find((item) => item.id === activeTabId);
    if (!tab || tab.type !== "conversation") {
      return;
    }
    const conversationId = getTabConversationId(tab);
    if (conversationId) {
      if (activeConversationIdRef.current !== conversationId) {
        void handleSelectRef.current(conversationId);
      }
      return;
    }
    boundNewChatTabIdRef.current = tab.id;
    const current = activeConversationIdRef.current;
    if (!current || !isPendingSessionKey(current)) {
      handleNewChatRef.current();
    }
  }, [activeTabId]);

  // 回滚到首条用户消息会删除整个会话，并把运行时切回新会话视图：此时把承载
  // 该会话的 tab 就地改写为新会话草稿 tab（tab id 不变，聊天视图不重建），
  // 并登记绑定关系，使其首次发送后改绑到新生成的会话。rollbackNewChatState
  // 只在「首条消息回滚且目标为活动会话」时被置为非空。
  useEffect(() => {
    if (!rollbackNewChatState || activeConversationId !== undefined) {
      return;
    }
    const tabId = activeTabIdRef.current;
    const tab = tabsRef.current.find((item) => item.id === tabId);
    if (!tab || tab.type !== "conversation" || !getTabConversationId(tab)) {
      return;
    }
    boundNewChatTabIdRef.current = tabId;
    setTabs((prev) =>
      prev.map((item) =>
        item.id === tabId
          ? { ...item, title: newChatTitle, data: { conversationId: "" } }
          : item,
      ),
    );
  }, [rollbackNewChatState, activeConversationId, newChatTitle, setTabs]);

  const conversationTabIds = tabs
    .map(getTabConversationId)
    .filter((id): id is string => id !== null);
  const conversationTabKey = conversationTabIds.join("|");

  // 子代理 / Workflow 节点会话展开为 tab（每个父会话只展开一次，树版本变化后重新展开）。
  useEffect(() => {
    if (treeVersionRef.current !== conversationTreeVersion) {
      treeVersionRef.current = conversationTreeVersion;
      expandedParentIdsRef.current.clear();
    }
    const parentIds = conversationTabIds.filter(
      (id) => !expandedParentIdsRef.current.has(id),
    );
    if (parentIds.length === 0) {
      return;
    }
    for (const id of parentIds) {
      expandedParentIdsRef.current.add(id);
    }
    void Promise.all([
      window.snow.listSubAgentConversationsByParents(parentIds),
      window.snow.listWorkflowNodeSessionsByParents(parentIds),
    ])
      .then(([subAgentMap, workflowNodeMap]) => {
        const children = [
          ...Object.values(subAgentMap),
          ...Object.values(workflowNodeMap),
        ]
          .flat()
          .filter(
            (child) => !dismissedIdsRef.current.has(child.conversationId),
          );
        if (children.length === 0) {
          return;
        }
        setTabs((prev) => {
          const known = new Set(prev.map(getTabConversationId));
          const added: RightPanelTab[] = children
            .filter((child) => !known.has(child.conversationId))
            .map((child) => ({
              id: conversationTabId(child.conversationId),
              type: "conversation",
              title: child.summary || child.title || untitledTitle,
              data: { conversationId: child.conversationId },
            }));
          return added.length > 0 ? [...prev, ...added] : prev;
        });
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationTabKey, conversationTreeVersion]);

  // tab 移除记录：用户关闭的会话不再被子树展开自动打开；关闭的草稿 tab 解除绑定。
  useEffect(() => {
    const current = new Set(conversationTabIds);
    for (const id of prevConversationIdsRef.current) {
      if (!current.has(id)) {
        dismissedIdsRef.current.add(id);
        pendingReleaseRef.current.add(id);
      }
    }
    for (const id of current) {
      dismissedIdsRef.current.delete(id);
    }
    prevConversationIdsRef.current = current;
    const boundId = boundNewChatTabIdRef.current;
    if (boundId !== null && !tabs.some((tab) => tab.id === boundId)) {
      boundNewChatTabIdRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationTabKey, tabs]);

  // 归属上报：tab 中的会话与运行中的会话。失去归属的会话释放缓存，
  // 活动或仍在运行的会话延后到不再需要时释放。
  const runningConversationIds = [
    ...streamingConversationIds,
    ...attentionRequiredConversationIds,
  ].filter((id) => !isPendingSessionKey(id));
  const ownedKey = [
    ...new Set([...conversationTabIds, ...runningConversationIds]),
  ]
    .sort()
    .join("|");

  useEffect(() => {
    const ownedIds = ownedKey ? ownedKey.split("|") : [];
    void window.snow
      .reportDetachedConversations(ownedIds)
      .catch(() => undefined);
    const owned = new Set(ownedIds);
    const releasable = [...pendingReleaseRef.current].filter(
      (id) => !owned.has(id) && id !== activeConversationIdRef.current,
    );
    if (releasable.length > 0) {
      for (const id of releasable) {
        pendingReleaseRef.current.delete(id);
      }
      releaseRef.current(releasable);
    }
  }, [ownedKey, activeConversationId]);

  // 主窗口点击已归属会话：激活对应 tab（子代理等尚未展开的会话则新增 tab）。
  useEffect(
    () =>
      window.snow.onDetachedConversationActivate((conversationId) => {
        dismissedIdsRef.current.delete(conversationId);
        const existing = tabsRef.current.find(
          (tab) => getTabConversationId(tab) === conversationId,
        );
        if (existing) {
          setActiveTabId(existing.id);
          return;
        }
        void openConversationTabRef.current(conversationId, true);
      }),
    [setActiveTabId],
  );

  // 会话摘要生成后（写入 upsertedConversation）：刷新对应会话 tab 的标题。
  useEffect(() => {
    if (!upsertedConversation) {
      return;
    }
    const { conversationId, summary, title } = upsertedConversation.record;
    const nextTitle = summary || title;
    if (!nextTitle) {
      return;
    }
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((tab) => {
        if (
          getTabConversationId(tab) !== conversationId ||
          tab.title === nextTitle
        ) {
          return tab;
        }
        changed = true;
        return { ...tab, title: nextTitle };
      });
      return changed ? next : prev;
    });
  }, [upsertedConversation, setTabs]);

  // 会话列表 / 树形数据变化 -> 主窗口：主窗口侧边栏靠自身的增量同步，看不到本窗口的写入，
  // 因此本窗口变化后通知主进程，由主窗口重新拉取。连续变化合并为一次通知。
  const listSignalRef = useRef({
    list: conversationListVersion,
    tree: conversationTreeVersion,
    upserted: upsertedConversation,
  });
  useEffect(() => {
    const previous = listSignalRef.current;
    if (
      previous.list === conversationListVersion &&
      previous.tree === conversationTreeVersion &&
      previous.upserted === upsertedConversation
    ) {
      return;
    }
    listSignalRef.current = {
      list: conversationListVersion,
      tree: conversationTreeVersion,
      upserted: upsertedConversation,
    };
    const timer = window.setTimeout(() => {
      void window.snow
        .notifyDetachedConversationListChanged()
        .catch(() => undefined);
    }, LIST_NOTIFY_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [conversationListVersion, conversationTreeVersion, upsertedConversation]);

  return null;
};
