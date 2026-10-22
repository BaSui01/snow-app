// 队友来信的投递前缀（模型可见），格式需与历史消息保持兼容。
const TEAMMATE_PREFIX_RE = /^\[来自子代理 (.+?) \(([^()\s]+)\)\]\n/;

export const formatTeammateMessage = (
  agentName: string,
  conversationId: string,
  message: string,
): string => `[来自子代理 ${agentName} (${conversationId})]\n${message}`;

export type ParsedTeammateMessage = {
  agentName: string;
  conversationId: string;
  body: string;
};

export const parseTeammateMessage = (
  content: string,
): ParsedTeammateMessage | null => {
  const match = TEAMMATE_PREFIX_RE.exec(content);
  if (!match) return null;
  return {
    agentName: match[1],
    conversationId: match[2],
    body: content.slice(match[0].length),
  };
};
