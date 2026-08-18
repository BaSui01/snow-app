/**
 * 会话拖拽契约（侧边栏会话项 → 聊天输入框）。
 *
 * 拖入输入框的历史会话以 conversation chip（见 fileTagUtils 的
 * ConversationTag）形式留在消息内容中：发送时随用户消息进入请求，
 * 由 Rust 后端 parse_chat_message_content 展开为渲染后的上下文块。
 *
 * 纯渲染进程内存状态，不经过主进程 IPC。
 */

/** 会话拖拽 payload 的 MIME 类型（HTML5 DataTransfer 自定义类型）。 */
export const CONVERSATION_DRAG_MIME = "application/x-snow-conversation";

export type ConversationDragPayload = {
  /** 被拖拽会话 A 的 conversationId */
  conversationId: string;
  /** 被拖拽会话 A 所属工作区目录（用于同项目校验） */
  directoryId: string;
  /** 被拖拽会话 A 的显示名（用于拖影） */
  title: string;
  /** 被拖拽会话 A 的 emoji（用于拖影） */
  emoji?: string;
};

let activeConversationDragPayload: ConversationDragPayload | null = null;

const parseConversationDragPayload = (
  raw: string
): ConversationDragPayload | null => {
  try {
    const parsed = JSON.parse(raw) as Partial<ConversationDragPayload>;
    if (
      typeof parsed.conversationId === "string" &&
      parsed.conversationId.trim() &&
      typeof parsed.directoryId === "string"
    ) {
      return {
        conversationId: parsed.conversationId,
        directoryId: parsed.directoryId,
        title: typeof parsed.title === "string" ? parsed.title : "",
        emoji: typeof parsed.emoji === "string" ? parsed.emoji : "",
      };
    }
    return null;
  } catch {
    return null;
  }
};

/** 开始应用内会话拖拽，并缓存 payload 供 dragover 阶段校验。 */
export const beginConversationDrag = (
  dataTransfer: DataTransfer,
  payload: ConversationDragPayload
): void => {
  activeConversationDragPayload = payload;
  dataTransfer.setData(CONVERSATION_DRAG_MIME, JSON.stringify(payload));
  dataTransfer.effectAllowed = "copyMove";
};

/** 结束应用内会话拖拽，避免下一次拖拽误用旧 payload。 */
export const endConversationDrag = (): void => {
  activeConversationDragPayload = null;
};

/**
 * 读取拖拽 payload；非法返回 null。
 *
 * Chromium 在 dragover 阶段会将 DataTransfer 置于保护模式：types 仍可见，
 * 但 getData() 返回空字符串。此时回退到 dragstart 缓存的应用内 payload，
 * 否则输入框无法完成前置校验、preventDefault()，浏览器也不会派发 drop。
 */
export const readConversationDragPayload = (
  dataTransfer: DataTransfer
): ConversationDragPayload | null => {
  const raw = dataTransfer.getData(CONVERSATION_DRAG_MIME);
  if (raw) {
    return parseConversationDragPayload(raw);
  }
  return dataTransfer.types.includes(CONVERSATION_DRAG_MIME)
    ? activeConversationDragPayload
    : null;
};
