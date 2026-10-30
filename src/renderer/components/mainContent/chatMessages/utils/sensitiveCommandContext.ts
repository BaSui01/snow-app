import { MAX_SENSITIVE_COMMAND_CONTEXT_MESSAGES } from "../../../../constants/sensitiveCommandAssist";
import type {
  ChatConversationMessage,
  ToolCallInfo,
} from "./conversationTypes";

/** 单条消息正文、工具参数摘要、工具输出摘要的字符上限。 */
const MAX_TEXT_CHARS = 2000;
const MAX_ARGUMENT_CHARS = 600;
const MAX_OUTPUT_CHARS = 1200;
/** 单条助手消息最多带的工具调用数（保留最近的）。 */
const MAX_TOOL_CALLS_PER_MESSAGE = 8;

const INLINE_IMAGE_TAG_RE = /@@image:[^@]*@@/g;
const DATA_URL_RE = /data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g;

type ContextToolCall = {
  callId: string;
  name: string;
  arguments: string;
  output?: string;
};

type ContextMessage = {
  role: "user" | "assistant";
  text: string;
  toolCalls?: ContextToolCall[];
};

const clip = (value: string, max: number): string => {
  const cleaned = value
    .replace(INLINE_IMAGE_TAG_RE, "[image]")
    .replace(DATA_URL_RE, "[binary data]")
    .trim();
  return cleaned.length > max
    ? `${cleaned.slice(0, max)}...[truncated]`
    : cleaned;
};

const isSameToolCall = (a: ToolCallInfo, b: ToolCallInfo): boolean =>
  a.interactionId === b.interactionId ||
  (Boolean(a.callId) && a.callId === b.callId);

/**
 * 构建敏感命令判定用的会话片段（JSON 数组字符串）：最近若干条用户 / 助手消息，
 * 助手消息带已结束的工具调用（名称 + 参数摘要 + 输出摘要）。待判定的调用本身
 * 不进片段（它就是 state 里的命令）。工具输出由 Rust 侧再走隐私过滤。
 */
export const buildSensitiveCommandContext = (
  messages: ChatConversationMessage[],
  pendingToolCall: ToolCallInfo,
): string => {
  const items: ContextMessage[] = [];
  const usedCallIds = new Set<string>();

  for (const message of messages) {
    // 压缩摘要与 tool 角色消息跳过：后者的结果已在助手消息的 toolCalls 里。
    if (message.isContextCompaction) {
      continue;
    }

    if (message.role === "user") {
      const text = clip(message.content ?? "", MAX_TEXT_CHARS);
      if (text) {
        items.push({ role: "user", text });
      }
      continue;
    }

    if (message.role !== "assistant") {
      continue;
    }

    const toolCalls = (message.toolCalls ?? [])
      .filter(
        (call) =>
          !isSameToolCall(call, pendingToolCall) &&
          (call.status === "completed" || call.status === "error"),
      )
      .slice(-MAX_TOOL_CALLS_PER_MESSAGE)
      .map((call, index): ContextToolCall => {
        let callId = (call.callId || call.interactionId || "").trim();
        if (!callId || usedCallIds.has(callId)) {
          callId = `${message.id}-${index}`;
        }
        usedCallIds.add(callId);
        return {
          callId,
          name: call.name,
          arguments: clip(call.arguments ?? "", MAX_ARGUMENT_CHARS),
          ...(typeof call.result === "string"
            ? { output: clip(call.result, MAX_OUTPUT_CHARS) }
            : {}),
        };
      });
    const text = clip(message.content ?? "", MAX_TEXT_CHARS);
    if (!text && toolCalls.length === 0) {
      continue;
    }
    items.push({
      role: "assistant",
      text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    });
  }

  // 按可配置上限构建，实际条数由 Rust 按设置裁剪（渲染层无需读取设置）。
  return JSON.stringify(items.slice(-MAX_SENSITIVE_COMMAND_CONTEXT_MESSAGES));
};
