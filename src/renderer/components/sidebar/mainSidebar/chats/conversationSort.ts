import type { ChatConversationRecord } from "../../../../../preload";
import { parseDbTimestamp } from "../chatTimeGroup";

/**
 * 排序会话列表：运行中或需关注的会话永远置顶，其余按 updatedAt 倒序。
 *
 * 运行中或需关注的会话（runningConversationIds）内部按 updatedAt 倒序，
 * 其他会话也按 updatedAt 倒序，两组拼接后返回。
 *
 * 必须基于时间戳比较，不能直接用字符串 localeCompare：
 * 占位符会话的 updatedAt 是 ISO UTC 格式（带 T 与 Z），
 * 而数据库返回的是 SQLite 本地时间格式（空格分隔、无时区），
 * 两种格式的字典序与真实时间顺序不一致，会导致新会话排到旧会话下方。
 *
 * runningConversationIds 仅在流式或待处理交互的生命周期边界变化，
 * 不会随每个流式 token 更新，因此不会导致流式过程中频繁重排序。
 */
export const sortConversationsByUpdatedAt = (
  items: ChatConversationRecord[],
  runningConversationIds?: Set<string>,
): ChatConversationRecord[] => {
  if (!runningConversationIds || runningConversationIds.size === 0) {
    return [...items].sort(
      (a, b) =>
        parseDbTimestamp(b.updatedAt).getTime() -
          parseDbTimestamp(a.updatedAt).getTime() ||
        b.conversationId.localeCompare(a.conversationId),
    );
  }

  const running: ChatConversationRecord[] = [];
  const rest: ChatConversationRecord[] = [];
  for (const item of items) {
    if (runningConversationIds.has(item.conversationId)) {
      running.push(item);
    } else {
      rest.push(item);
    }
  }

  const compareByTime = (
    a: ChatConversationRecord,
    b: ChatConversationRecord,
  ): number =>
    parseDbTimestamp(b.updatedAt).getTime() -
      parseDbTimestamp(a.updatedAt).getTime() ||
    b.conversationId.localeCompare(a.conversationId);

  running.sort(compareByTime);
  rest.sort(compareByTime);

  return [...running, ...rest];
};
