import type {
  SnowRemoteControlApi,
  SnowRemoteModeId,
  SnowRemoteState,
  SnowRemoteTodoStatus,
} from "../renderer/types/remoteControl";
import { t } from "./i18n";

/**
 * 远控 HTTP 接口封装。
 *
 * 请求/响应形状与桌面 Renderer 的 SnowRemoteControlApi 桥一致
 * （主进程只是转发并校验），因此面板类返回值直接从桥的类型推导，避免重复定义。
 */
type SkillsResponse = Awaited<ReturnType<SnowRemoteControlApi["getSkills"]>>;
type McpResponse = Awaited<ReturnType<SnowRemoteControlApi["getMcpServers"]>>;
type ChangesResponse = Awaited<ReturnType<SnowRemoteControlApi["getChanges"]>>;
type PermissionsSummary = Awaited<
  ReturnType<SnowRemoteControlApi["getPermissions"]>
>;
type RoleSummary = Awaited<ReturnType<SnowRemoteControlApi["getRole"]>>;
type SensitiveCommandsSummary = Awaited<
  ReturnType<SnowRemoteControlApi["getSensitiveCommands"]>
>;
type CodebaseSummary = Awaited<ReturnType<SnowRemoteControlApi["getCodebase"]>>;
type ReviewSummary = Awaited<ReturnType<SnowRemoteControlApi["getReview"]>>;
type OlderMessagesResponse = Awaited<
  ReturnType<SnowRemoteControlApi["getMessages"]>
>;
type ConversationsPageResponse = Awaited<
  ReturnType<SnowRemoteControlApi["getConversations"]>
>;

export class RemoteHttpError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RemoteHttpError";
    this.status = status;
  }
}

export const isUnauthorizedError = (error: unknown): boolean =>
  error instanceof RemoteHttpError && error.status === 401;

type RequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit | null;
};

/** 统一请求：12 秒超时 + JSON 解析，非 2xx 抛出携带状态码的错误。 */
const request = async <T>(
  path: string,
  options?: RequestOptions,
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(path, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      ...options,
    });
    const body = (await response
      .json()
      .catch(() => ({ error: t("remote.error.badResponse") }))) as {
      error?: string;
    };
    if (!response.ok) {
      throw new RemoteHttpError(
        body.error || `HTTP ${response.status}`,
        response.status,
      );
    }
    return body as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(t("remote.error.timeout"));
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

export const fetchState = (): Promise<SnowRemoteState> => request("/api/state");

/** 向前分页加载更早的聊天记录（beforeMessageId 为空串时取最新一页）。 */
export const fetchOlderMessages = (
  conversationId: string,
  beforeMessageId: string,
  limit: number,
): Promise<OlderMessagesResponse> =>
  request(
    `/api/messages?conversationId=${encodeURIComponent(conversationId)}&beforeMessageId=${encodeURIComponent(beforeMessageId)}&limit=${limit}`,
  );

/** 分页加载某个工作区的会话列表（offset 为已加载的条目数）。 */
export const fetchMoreConversations = (
  directoryId: string,
  offset: number,
  limit: number,
): Promise<ConversationsPageResponse> =>
  request(
    `/api/conversations?directoryId=${encodeURIComponent(directoryId)}&offset=${offset}&limit=${limit}`,
  );
export const fetchSkills = (): Promise<SkillsResponse> =>
  request("/api/skills");

export const setSkillEnabled = (
  skillId: string,
  enabled: boolean,
  directoryId: string | null,
): Promise<{ ok: true }> =>
  request("/api/skills", {
    method: "POST",
    body: JSON.stringify({ skillId, enabled, directoryId }),
  });

export const fetchMcpServers = (): Promise<McpResponse> => request("/api/mcp");

export const setMcpEnabled = (
  target: "server" | "tool",
  id: string,
  enabled: boolean,
  directoryId: string,
): Promise<{ ok: true }> =>
  request("/api/mcp", {
    method: "POST",
    body: JSON.stringify({ target, id, enabled, directoryId }),
  });

export const fetchChanges = (
  conversationId: string,
): Promise<ChangesResponse> =>
  request(`/api/changes?conversationId=${encodeURIComponent(conversationId)}`);

export const fetchPermissions = (): Promise<PermissionsSummary> =>
  request("/api/permissions");

export const fetchRole = (): Promise<RoleSummary> => request("/api/role");

export const fetchSensitiveCommands = (): Promise<SensitiveCommandsSummary> =>
  request("/api/sensitive-commands");

export const fetchCodebase = (): Promise<CodebaseSummary> =>
  request("/api/codebase");

export const fetchReview = (): Promise<ReviewSummary> => request("/api/review");

export const sendMessage = (
  text: string,
  attachmentIds: string[],
  requestId: string,
): Promise<{ ok: true }> =>
  request("/api/send", {
    method: "POST",
    body: JSON.stringify({ text, attachmentIds, requestId }),
  });

export const abortRun = (): Promise<{ ok: true }> =>
  request("/api/abort", { method: "POST", body: "{}" });

/**
 * 立即发送某条待发送消息（中断其所属会话的运行并直接发出该条）。
 * queueKey 为移动端所见的队列定位键（SnowRemoteState.pendingQueueKey，
 * 不透明标记，原样回传），桌面端据此解析队列真实位置后执行（会话隔离）。
 */
export const sendPendingNow = (
  index: number,
  queueKey: string | null,
): Promise<{ ok: true }> =>
  request("/api/pending", {
    method: "POST",
    body: JSON.stringify({ action: "send-now", index, queueKey }),
  });

/** 撤回某条待发送消息（从队列移除）；返回原始文本供恢复到输入区。 */
export const withdrawPending = (
  index: number,
  queueKey: string | null,
): Promise<{ ok: true; text: string }> =>
  request("/api/pending", {
    method: "POST",
    body: JSON.stringify({ action: "withdraw", index, queueKey }),
  });

export const startNewChat = (): Promise<{ ok: true }> =>
  request("/api/new-chat", { method: "POST", body: "{}" });

export const setMode = (
  mode: SnowRemoteModeId,
  enabled: boolean,
): Promise<{ ok: true }> =>
  request("/api/mode", {
    method: "POST",
    body: JSON.stringify({ mode, enabled }),
  });

/**
 * 会话待办变更（add / update / delete）：复用桌面真实 todo-todo-manage 工具。
 * 变更后的最新列表随 /api/state 的 todos 字段回传，调用方刷新快照即可。
 */
export const mutateTodos = (
  action: "add" | "update" | "delete",
  payload: { content?: string; todoId?: string; status?: SnowRemoteTodoStatus },
): Promise<{ ok: true }> =>
  request("/api/todos", {
    method: "POST",
    body: JSON.stringify({ action, ...payload }),
  });

export const selectConversation = (
  conversationId: string,
  directoryId: string,
): Promise<{ ok: true }> =>
  request("/api/select", {
    method: "POST",
    body: JSON.stringify({ conversationId, directoryId }),
  });

export const approveAuthorization = (
  authorizationId: string,
): Promise<{ ok: true }> =>
  request("/api/authorization", {
    method: "POST",
    body: JSON.stringify({ authorizationId, decision: "approve" }),
  });

export const rejectAuthorization = (
  authorizationId: string,
  reason: string | undefined,
): Promise<{ ok: true }> =>
  request("/api/authorization", {
    method: "POST",
    body: JSON.stringify({
      authorizationId,
      decision: "reject",
      reason: reason || undefined,
    }),
  });

export const answerQuestion = (
  questionId: string,
  selectedOptions: string[],
  customAnswers: string[],
): Promise<{ ok: true }> =>
  request("/api/question", {
    method: "POST",
    body: JSON.stringify({
      questionId,
      action: "answer",
      selectedOptions,
      customAnswers,
    }),
  });

export const cancelQuestion = (questionId: string): Promise<{ ok: true }> =>
  request("/api/question", {
    method: "POST",
    body: JSON.stringify({
      questionId,
      action: "cancel",
      selectedOptions: [],
      customAnswers: [],
    }),
  });

export const setModel = (modelId: string): Promise<{ ok: true }> =>
  request("/api/model", {
    method: "POST",
    body: JSON.stringify({ model: modelId }),
  });

export const setApiProfile = (profile: string): Promise<{ ok: true }> =>
  request("/api/model", {
    method: "POST",
    body: JSON.stringify({ profile }),
  });

export const setThinking = (value: string): Promise<{ ok: true }> =>
  request("/api/model", {
    method: "POST",
    body: JSON.stringify({ thinkingStrength: value }),
  });

export const setResponsesFastMode = (enabled: boolean): Promise<{ ok: true }> =>
  request("/api/model", {
    method: "POST",
    body: JSON.stringify({ responsesFastMode: enabled }),
  });

export const runCommand = (commandId: string): Promise<{ ok: true }> =>
  request("/api/command", {
    method: "POST",
    body: JSON.stringify({ commandId }),
  });

export const pair = (code: string): Promise<{ ok: true }> =>
  request("/api/pair", { method: "POST", body: JSON.stringify({ code }) });

export const uploadAttachment = (
  file: File,
  kind: "image" | "file",
): Promise<{ id: string }> =>
  request("/api/attachments", {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "x-snow-attachment-kind": kind,
      "x-snow-file-name": encodeURIComponent(file.name),
    },
    body: file,
  });

/** 移除服务端附件；失败无需提示（附件只在本机内存与桌面侧登记）。 */
export const discardAttachment = (id: string): void => {
  void fetch(`/api/attachments/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "same-origin",
  }).catch(() => {});
};
