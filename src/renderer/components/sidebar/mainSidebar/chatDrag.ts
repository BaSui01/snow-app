/**
 * 会话拖拽（置顶区 ↔ 普通列表）的 dataTransfer 协议。
 * 使用自定义 MIME 类型，避免与文本/文件拖拽相互干扰。
 */
export const CHAT_DRAG_MIME = "application/x-snow-chat-conversation";

/** 拖拽负载：会话 ID 与其拖出时的状态，drop 时据此判断是否需要变更 */
export type ChatDragPayload = {
  conversationId: string;
  status: string;
};

/** 写入拖拽数据（dragstart 时调用） */
export function setChatDragData(
  event: React.DragEvent,
  payload: ChatDragPayload
): void {
  event.dataTransfer.setData(CHAT_DRAG_MIME, JSON.stringify(payload));
  event.dataTransfer.effectAllowed = "move";
}

/** 判断本次拖拽是否为会话拖拽（dragover 时检查 types） */
export function isChatDrag(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes(CHAT_DRAG_MIME);
}

/** 读取拖拽负载（drop 时调用）；非会话拖拽返回 null */
export function readChatDragData(
  event: React.DragEvent
): ChatDragPayload | null {
  const raw = event.dataTransfer.getData(CHAT_DRAG_MIME);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as ChatDragPayload;
  } catch {
    return null;
  }
}
