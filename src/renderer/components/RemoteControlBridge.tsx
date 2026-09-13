import { useEffect, useRef } from "react";
import type {
  ChatConversationRecord,
  TokenUsage,
  WorkspaceDirectoryRecord,
} from "../../preload";
import type { MainContentView } from "./mainContent/types";
import { useChatConversationContext } from "./mainContent/chatMessages";
import { parseTodoResult } from "./mainContent/chatMessages/hooks/useTodoPanel";
import { buildConversationMessages } from "./mainContent/chatMessages/utils/conversationHelpers";
import type {
  ChatConversationMessage,
  ToolCallInfo,
} from "./mainContent/chatMessages/utils/conversationTypes";
import {
  readLiveRemoteControlChatInput,
  readRemoteControlChatInput,
  type SnowRemoteChatInputPublication,
} from "./mainContent/chatInput/remoteControlChatInputRegistry";
import { redactSensitiveToolText } from "./remoteControlRedaction";
import { parseContentSegments } from "./mainContent/chatInput/fileTagUtils";
import type {
  SnowRemoteChatInputState,
  SnowRemoteContentBlock,
  SnowRemoteControlApi,
  SnowRemoteChange,
  SnowRemoteMessage,
  SnowRemoteState,
  SnowRemoteTodoItem,
  SnowRemoteTodoStatus,
  SnowRemoteToolCall,
  SnowRemoteTokenUsage,
} from "../types/remoteControl";

type RemoteControlBridgeProps = {
  activeDirectory: WorkspaceDirectoryRecord | null;
  onActiveDirectoryChange: (directory: WorkspaceDirectoryRecord | null) => void;
  onSelectMainView: (view: MainContentView) => void;
};

const MAX_MESSAGES = 50;
/** 会话选择器的分页步长（首屏每工作区一页，「加载更多」按同一页长追加）。 */
const REMOTE_CONVERSATION_PAGE_SIZE = 30;
const MAX_MESSAGE_LENGTH = 40_000;
const MAX_TOOL_ARGUMENT_LENGTH = 2_000;
const MAX_TOOL_RESULT_LENGTH = 12_000;
const MAX_TOOL_STREAM_LENGTH = 8_000;
const MAX_SEND_LENGTH = 8_000;
const MAX_COMMANDS = 40;
const MAX_THINKING_OPTIONS = 20;
const MAX_THINKING_LENGTH = 100;
const MAX_IDENTIFIER_LENGTH = 200;
/** 会话待办：单次下发的最大条目数与单条内容长度上限。 */
const MAX_TODOS = 200;
const MAX_TODO_CONTENT_LENGTH = 500;
/**
 * 待办快照缓存时长。/api/state 由手机端高频轮询，而待办需要调用
 * MCP 工具读取（一次 IPC + SQLite 查询）：命中缓存时直接复用，
 * 变更（mutateTodos）与切换会话时立即失效。
 */
const TODO_CACHE_TTL_MS = 3_000;

const truncateTo = (
  value: string | undefined,
  maxLength: number,
): string | undefined => {
  if (value === undefined || value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}\n…（手机端已截断）`;
};

// Tool payload sanitization stays in a dependency-free module so its security
// contract can be exercised without mounting the React bridge.
const safeToolText = (
  value: string | undefined,
  maxLength: number,
): string | undefined => redactSensitiveToolText(truncateTo(value, maxLength));

const truncate = (value: string | undefined): string | undefined =>
  truncateTo(value, MAX_MESSAGE_LENGTH);

/**
 * 桌面当前生效的主题色：--accent-color 经浏览器原生 var() 解析后的计算值，
 * 规范化为 #rrggbb 供手机端复用。probe 元素的 color 由浏览器解析，
 * 无需自己递归展开 CSS 变量；解析失败（如非常规色彩空间）返回空串，
 * 手机端保持自身默认强调色。
 */
const resolveThemeAccentColor = (): string => {
  try {
    const probe = document.createElement("div");
    probe.style.color = "var(--accent-color)";
    probe.style.display = "none";
    document.body.appendChild(probe);
    const computed = window.getComputedStyle(probe).color;
    probe.remove();
    const match = /^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(computed);
    if (!match) return "";
    return (
      "#" +
      [match[1], match[2], match[3]]
        .map((channel) => Number(channel).toString(16).padStart(2, "0"))
        .join("")
    );
  } catch {
    return "";
  }
};

const toRemoteContentBlocks = (
  messageId: string,
  content: string,
): SnowRemoteContentBlock[] => {
  let imageIndex = 0;
  return parseContentSegments(content).flatMap(
    (segment): SnowRemoteContentBlock[] => {
      if (segment.type === "text") {
        const text = truncate(segment.content) ?? "";
        return text.trim() ? [{ type: "text", text }] : [];
      }
      if (segment.type === "image") {
        // 无消息 id（待发送消息等尚未落库的内容）时没有取图端点：
        // source 置空，移动端按附件 chip 降级展示。
        const source = messageId
          ? `/api/message-images/${encodeURIComponent(messageId)}/${imageIndex}`
          : "";
        imageIndex += 1;
        return [{ type: "image", name: segment.tag.name, source }];
      }
      if (segment.type === "file") {
        return [
          {
            type: "file",
            name: segment.tag.name,
            isDirectory: segment.tag.isDirectory,
          },
        ];
      }
      const label =
        segment.type === "commit"
          ? segment.tag.shortHash || "Commit"
          : segment.type === "change"
            ? segment.tag.path.split(/[\\/]/).pop() || "代码改动"
            : segment.type === "text-snippet"
              ? segment.tag.summary || "文本片段"
              : segment.type === "review"
                ? segment.tag.summary || "代码审查"
                : segment.type === "element"
                  ? segment.tag.label || segment.tag.tag || "网页元素"
                  : segment.type === "web"
                    ? segment.tag.title || segment.tag.url || "网页"
                    : segment.type === "conversation"
                      ? segment.tag.title || "会话"
                      : segment.type === "quote"
                        ? segment.tag.summary || "引用"
                        : segment.tag.name || "Skill";
      const detail =
        segment.type === "text-snippet" || segment.type === "quote"
          ? `${segment.tag.charCount} 个字符`
          : segment.type === "web"
            ? segment.tag.url
            : segment.type === "skill"
              ? segment.tag.description
              : undefined;
      return [
        {
          type: "reference",
          kind: segment.type,
          label: truncateTo(label, 240) ?? "附件",
          detail: truncateTo(detail, 500),
        },
      ];
    },
  );
};

const toRemotePreview = (content: string | undefined): string => {
  if (!content) return "";
  // Conversation titles/previews may be truncated by persistence in the
  // middle of an attachment tag. A truncated tag cannot be parsed normally,
  // so remove these two sensitive formats before the shared parser runs.
  const safeContent = content
    .replace(/@@(image|file|dir):[\s\S]*?(?:@@|$)/g, (_match, kind: string) =>
      kind === "image" ? "[图片]" : kind === "dir" ? "[文件夹]" : "[文件]",
    )
    .replace(/data:image\/[^\s]*/gi, "[图片]");
  const preview = parseContentSegments(safeContent)
    .map((segment) => {
      if (segment.type === "text") return segment.content;
      if (segment.type === "image") return `[图片 ${segment.tag.name}]`;
      if (segment.type === "file") {
        return `[${segment.tag.isDirectory ? "文件夹" : "文件"} ${segment.tag.name}]`;
      }
      if (segment.type === "commit") return `[Commit ${segment.tag.shortHash}]`;
      if (segment.type === "change") {
        return `[代码改动 ${segment.tag.path.split(/[\\/]/).pop() || ""}]`;
      }
      if (segment.type === "skill") return `[Skill ${segment.tag.name}]`;
      if (segment.type === "conversation") return `[会话 ${segment.tag.title}]`;
      if (segment.type === "web") return `[网页 ${segment.tag.title || ""}]`;
      if (segment.type === "element") return `[网页元素 ${segment.tag.label}]`;
      if (segment.type === "review") return `[代码审查 ${segment.tag.summary}]`;
      if (segment.type === "quote") return `[引用 ${segment.tag.summary}]`;
      return `[文本片段 ${segment.tag.summary}]`;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return truncateTo(preview, 500) ?? "";
};

const toRemoteToolCall = (toolCall: ToolCallInfo): SnowRemoteToolCall => ({
  name: toolCall.name,
  interactionId: toolCall.interactionId,
  authorizationId: toolCall.authorizationId,
  status: toolCall.status,
  arguments: safeToolText(toolCall.arguments, MAX_TOOL_ARGUMENT_LENGTH),
  result: safeToolText(toolCall.result, MAX_TOOL_RESULT_LENGTH),
  streamingStdout: safeToolText(
    toolCall.streamingStdout,
    MAX_TOOL_STREAM_LENGTH,
  ),
  streamingStderr: safeToolText(
    toolCall.streamingStderr,
    MAX_TOOL_STREAM_LENGTH,
  ),
  userQuestion: toolCall.userQuestion
    ? {
        questionId: toolCall.userQuestion.questionId,
        question: truncateTo(toolCall.userQuestion.question, 2_000) ?? "",
        options: toolCall.userQuestion.options
          .slice(0, 20)
          .map((option) => truncateTo(option, 500) ?? ""),
        status: toolCall.userQuestion.status,
        selectedOptions: toolCall.userQuestion.selectedOptions.slice(0, 20),
        customAnswers: toolCall.userQuestion.customAnswers.slice(0, 20),
      }
    : undefined,
});

const toRemoteMessage = (
  message: ChatConversationMessage,
): SnowRemoteMessage => ({
  id: message.id,
  role: message.role,
  content:
    message.role === "user"
      ? (truncate(
          parseContentSegments(message.content)
            .filter((segment) => segment.type === "text")
            .map((segment) => segment.content)
            .join("")
            .trim(),
        ) ?? "")
      : (truncate(message.content) ?? ""),
  contentBlocks:
    message.role === "user"
      ? toRemoteContentBlocks(message.id, message.content)
      : undefined,
  thinking: truncate(message.thinking),
  model: truncateTo(message.model, 120),
  isThinkingActive: message.isThinkingActive,
  thinkingDurationMs: message.thinkingDurationMs,
  toolCalls: message.toolCalls?.map(toRemoteToolCall),
  timestamp: message.timestamp,
  status: message.status,
});

// 会话列表条目 → 远程 DTO：preview 先剥离附件标记再截断（见 toRemotePreview）。
const toRemoteConversation = (
  item: ChatConversationRecord,
  workspaceName: string,
): SnowRemoteState["conversations"][number] => ({
  conversationId: item.conversationId,
  title: toRemotePreview(item.title),
  summary: toRemotePreview(item.summary),
  lastMessagePreview: toRemotePreview(item.lastMessagePreview),
  status: item.status,
  directoryId: item.directoryId,
  workspaceName,
  updatedAt: item.updatedAt,
});

// 真实 Token Usage 直传（来源：会话 session，由 Main/Rust 归一化）。
// Renderer 不重新计算任何 Token 算法，只做非负整数防御性清洗。
const toRemoteTokenUsage = (
  tokenUsage: TokenUsage | null | undefined,
): SnowRemoteTokenUsage | null => {
  if (!tokenUsage) {
    return null;
  }
  const safeCount = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : 0;
  return {
    inputTokens: safeCount(tokenUsage.inputTokens),
    outputTokens: safeCount(tokenUsage.outputTokens),
    cacheCreationInputTokens: safeCount(tokenUsage.cacheCreationInputTokens),
    cacheReadInputTokens: safeCount(tokenUsage.cacheReadInputTokens),
  };
};

const normalizeRemoteIdentifier = (value: string): string =>
  typeof value === "string" ? value.trim() : "";

/**
 * 待发送队列操作失败时的现场摘要（诊断：请求 key / 当前视图 key / 存活队列 /
 * 迁移映射 / 队列索引 / 显示镜像长度）。随错误信息返回给移动端，便于定位
 * “队列定位失败”的真实原因。
 */
const pendingOperationFailureDetail = (
  conversation: ReturnType<typeof useChatConversationContext>,
  expectedQueueKey: string | null,
  index: number,
): string => {
  const queueKeys = Array.from(conversation.pendingQueueRef.current.keys());
  const migrationMapping = Array.from(
    conversation.pendingToRealConversationIdRef.current.entries(),
  ).map(([from, to]) => `${from}->${to}`);
  return (
    `（key=${expectedQueueKey ?? "null"}；视图=${conversation.activeSessionKeyRef.current ?? "null"}；` +
    `队列=[${queueKeys.join(", ")}]；迁移=[${migrationMapping.join(", ")}]；` +
    `idx=${index}；镜像=${conversation.pendingMessages.length}）`
  );
};

export const RemoteControlBridge = ({
  activeDirectory,
  onActiveDirectoryChange,
  onSelectMainView,
}: RemoteControlBridgeProps): null => {
  const conversation = useChatConversationContext();
  const stateRef = useRef({
    activeDirectory,
    onActiveDirectoryChange,
    onSelectMainView,
    conversation,
  });

  stateRef.current = {
    activeDirectory,
    onActiveDirectoryChange,
    onSelectMainView,
    conversation,
  };

  // 远控 Phase A：读取输入区快照并做会话绑定二次校验。
  // 快照绑定会话与活动会话不一致（切换瞬间的陈旧快照）时视为不可用。
  const matchChatInputConversation = (
    publication: SnowRemoteChatInputPublication,
  ): SnowRemoteChatInputPublication | null => {
    const activeConversationId =
      stateRef.current.conversation.activeConversationId ?? null;
    return (publication.conversationId ?? null) === activeConversationId
      ? publication
      : null;
  };

  /** 实时快照：变更与指令执行要求输入区挂载中（真实 setter 链仍存活）。 */
  const resolveChatInput = (): SnowRemoteChatInputPublication | null => {
    const publication = readLiveRemoteControlChatInput();
    return publication ? matchChatInputConversation(publication) : null;
  };

  /**
   * 展示快照：输入区卸载（桌面停留在设置页等）时回退到最后一次快照，
   * 手机端仍能显示当前模型 / Profile / 思考强度，而不是退化成「未选择」。
   */
  const resolveChatInputForDisplay =
    (): SnowRemoteChatInputPublication | null => {
      const publication = readRemoteControlChatInput();
      return publication ? matchChatInputConversation(publication) : null;
    };

  // 需要“真实 setter 链”的远程变更（模型/Profile/思考强度/Fast Mode）：
  // 桌面端在流式期间禁用模型菜单、子代理会话的输入配置由子代理配置决定，
  // 远程操作同样拒绝，避免绕过桌面行为约束。
  const requireChatInputForMutation = (): SnowRemoteChatInputPublication => {
    const publication = resolveChatInput();
    if (!publication) {
      const current = stateRef.current.conversation;
      const activeId = current.activeConversationId;
      // 子代理 / 工作流节点会话：输入配置由父会话或节点配置决定；会话结束
      // 后输入区还会被结束提示条替换（live 快照随之消失）。这类会话远程
      // 不能修改，给出准确原因，避免与“桌面不在对话页”混淆。
      const record = current.upsertedConversation?.record ?? null;
      const isChildSession =
        Boolean(activeId && current.subAgentSessionEvents[activeId]) ||
        Boolean(
          activeId &&
          record &&
          record.conversationId === activeId &&
          (record.conversationType === "sub_agent" ||
            record.conversationType === "workflow_node"),
        );
      if (isChildSession) {
        throw new Error(
          "电脑端当前是子代理/工作流会话，输入配置不可远程修改（请切换到普通对话）",
        );
      }
      // 展示快照存在而实时快照缺失：输入区已卸载（桌面停留在设置页等
      // 非对话视图），setter 链随组件销毁，给出明确指引而不是笼统的“未就绪”。
      throw new Error(
        resolveChatInputForDisplay()
          ? "电脑端当前暂不支持修改（请在电脑端打开一个普通对话）"
          : "电脑端尚未就绪，请确认电脑端已打开对话",
      );
    }
    if (stateRef.current.conversation.isStreaming) {
      throw new Error("请先停止当前运行");
    }
    if (publication.isSubAgentConversation) {
      throw new Error("子代理会话的输入配置由子代理配置决定，无法远程修改");
    }
    return publication;
  };

  // 输入区快照 → 安全 DTO：只含展示层数据，字符串一律限长。
  const toRemoteChatInput = (
    publication: SnowRemoteChatInputPublication,
  ): SnowRemoteChatInputState => ({
    conversationId: publication.conversationId,
    isSubAgentConversation: publication.isSubAgentConversation,
    isLoadingApiConfig: publication.isLoadingApiConfig,
    selectedModel:
      truncateTo(publication.selectedModel, MAX_IDENTIFIER_LENGTH) ?? "",
    displayModel:
      truncateTo(publication.displayModel, MAX_IDENTIFIER_LENGTH) ?? "",
    modelIds: publication.modelIds
      .slice(0, 500)
      .map((modelId) => truncateTo(modelId, MAX_IDENTIFIER_LENGTH) ?? "")
      .filter(Boolean),
    selectedApiProfile:
      truncateTo(publication.selectedApiProfile, MAX_IDENTIFIER_LENGTH) ?? "",
    apiProfileNames: publication.apiProfileNames
      .slice(0, 100)
      .map((name) => truncateTo(name, MAX_IDENTIFIER_LENGTH) ?? "")
      .filter(Boolean),
    requestMethod: publication.requestMethod,
    effectiveThinkingValue:
      truncateTo(publication.effectiveThinkingValue, MAX_THINKING_LENGTH) ?? "",
    thinkingOptions: publication.thinkingOptions
      .slice(0, MAX_THINKING_OPTIONS)
      .map((option) => ({
        value: truncateTo(option.value, MAX_THINKING_LENGTH) ?? "",
        label: truncateTo(option.label, MAX_THINKING_LENGTH) ?? "",
      })),
    responsesFastModeEnabled: publication.responsesFastModeEnabled,
    maxContextTokens:
      typeof publication.maxContextTokens === "number" &&
      Number.isFinite(publication.maxContextTokens) &&
      publication.maxContextTokens > 0
        ? Math.floor(publication.maxContextTokens)
        : null,
    tokenUsage: toRemoteTokenUsage(stateRef.current.conversation.tokenUsage),
    commands: publication.commands.slice(0, MAX_COMMANDS).map((command) => ({
      id: command.id,
      label: truncateTo(command.label, 200) ?? "",
      description: truncateTo(command.description, 500) ?? "",
      disabled: Boolean(command.disabled),
    })),
  });

  const conversationCacheRef = useRef<{
    expiresAt: number;
    conversations: SnowRemoteState["conversations"];
    totals: SnowRemoteState["conversationTotals"];
  }>({
    expiresAt: 0,
    conversations: [],
    totals: {},
  });

  const todosCacheRef = useRef<{
    conversationId: string;
    expiresAt: number;
    items: SnowRemoteTodoItem[];
  } | null>(null);

  /**
   * 会话待办快照：命中缓存（见 TODO_CACHE_TTL_MS）时直接复用，否则按会话
   * 调用真实 todo-todo-manage 工具读取——与桌面顶部待办面板同一数据源，
   * 因此手机端看到的完成度与桌面完全一致。会话隔离：读取按会话 ID 进行，
   * 无活动会话或读取失败时返回 null（移动端隐藏待办入口）。
   */
  const resolveTodos = async (
    conversationId: string | null,
  ): Promise<SnowRemoteTodoItem[] | null> => {
    if (!conversationId) {
      todosCacheRef.current = null;
      return null;
    }
    const cached = todosCacheRef.current;
    if (
      cached &&
      cached.conversationId === conversationId &&
      cached.expiresAt > Date.now()
    ) {
      return cached.items;
    }

    try {
      const result = await window.snow.callMcpTool(
        "todo-todo-manage",
        JSON.stringify({ action: "get" }),
        stateRef.current.activeDirectory?.directoryId,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        conversationId,
      );
      const items = (parseTodoResult(result)?.todos ?? [])
        .slice(0, MAX_TODOS)
        .map((todo) => ({
          id: todo.id,
          content: truncateTo(todo.content, MAX_TODO_CONTENT_LENGTH) ?? "",
          status: todo.status,
        }));
      todosCacheRef.current = {
        conversationId,
        expiresAt: Date.now() + TODO_CACHE_TTL_MS,
        items,
      };
      return items;
    } catch {
      // 读取失败（工具暂不可用等）：本轮不下发待办，也不缓存，
      // 由下一次轮询重试；把失败当成空列表会让手机端误以为列表被清空。
      return null;
    }
  };

  useEffect(() => {
    const api: SnowRemoteControlApi = {
      getMessageImage: async (messageId, imageIndex) => {
        if (!messageId || !Number.isInteger(imageIndex) || imageIndex < 0) {
          throw new Error("图片标识无效");
        }
        const message = stateRef.current.conversation.messages.find(
          (item) => item.id === messageId && item.role === "user",
        );
        if (!message) throw new Error("图片不可用");
        const image = parseContentSegments(message.content).filter(
          (segment) => segment.type === "image",
        )[imageIndex];
        if (!image || image.type !== "image") throw new Error("图片不可用");
        const match = image.tag.dataUrl.match(
          /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/,
        );
        if (!match) throw new Error("图片格式不受支持");
        return { mimeType: match[1], base64: match[2] };
      },
      getSkills: async () => {
        const directoryId =
          stateRef.current.activeDirectory?.directoryId ?? null;
        const skills = await window.snow.listAvailableSkills(
          directoryId ?? undefined,
        );
        if (
          (stateRef.current.activeDirectory?.directoryId ?? null) !==
          directoryId
        ) {
          throw new Error("项目已切换，请重新打开 Skills");
        }
        return {
          directoryId,
          skills: skills
            .slice(0, 500)
            .map((skill) => ({
              id: truncateTo(skill.id, MAX_IDENTIFIER_LENGTH) ?? "",
              name: truncateTo(skill.name, 240) ?? "",
              description: truncateTo(skill.description, 1_000) ?? "",
              location: skill.location,
              source: skill.source,
              allowedTools: (skill.allowedTools ?? [])
                .slice(0, 50)
                .map((tool) => truncateTo(tool, MAX_IDENTIFIER_LENGTH) ?? "")
                .filter(Boolean),
              enabled: Boolean(skill.enabled),
            }))
            .filter((skill) => skill.id),
        };
      },
      setSkillEnabled: async (skillId, enabled, expectedDirectoryId) => {
        const directoryId =
          stateRef.current.activeDirectory?.directoryId ?? null;
        if (directoryId !== expectedDirectoryId) {
          throw new Error("项目已切换，请重新打开 Skills");
        }
        const normalizedId = normalizeRemoteIdentifier(skillId);
        const skills = await window.snow.listAvailableSkills(
          directoryId ?? undefined,
        );
        if (
          (stateRef.current.activeDirectory?.directoryId ?? null) !==
          directoryId
        ) {
          throw new Error("项目已切换，请重试");
        }
        const skill = skills.find((item) => item.id === normalizedId);
        if (!skill) throw new Error("Skill 不存在或已不可用");
        await window.snow.setSkillEnabled(
          skill.location === "project" ? (directoryId ?? undefined) : undefined,
          skill.id,
          enabled,
        );
        return { ok: true };
      },
      getMcpServers: async () => {
        const directoryId = stateRef.current.activeDirectory?.directoryId;
        if (!directoryId) throw new Error("请先选择项目");
        const servers = await window.snow.listMcpProjectServers(directoryId);
        if (stateRef.current.activeDirectory?.directoryId !== directoryId) {
          throw new Error("项目已切换，请重新打开 MCP");
        }
        return {
          directoryId,
          servers: servers
            .slice(0, 100)
            .map((server) => ({
              id: truncateTo(server.id, MAX_IDENTIFIER_LENGTH) ?? "",
              name: truncateTo(server.name, 240) ?? "",
              source: server.source,
              globalEnabled: Boolean(server.globalEnabled),
              enabled: Boolean(server.enabled),
              available: !server.error,
              tools: server.tools
                .slice(0, 500)
                .map((tool) => ({
                  name: truncateTo(tool.name, MAX_IDENTIFIER_LENGTH) ?? "",
                  description: truncateTo(tool.description, 500) ?? "",
                  enabled: Boolean(tool.enabled),
                }))
                .filter((tool) => tool.name),
            }))
            .filter((server) => server.id),
        };
      },
      setMcpEnabled: async (target, id, enabled, expectedDirectoryId) => {
        const directoryId = stateRef.current.activeDirectory?.directoryId;
        if (!directoryId || directoryId !== expectedDirectoryId) {
          throw new Error("项目已切换，请重新打开 MCP");
        }
        const servers = await window.snow.listMcpProjectServers(directoryId);
        if (stateRef.current.activeDirectory?.directoryId !== directoryId) {
          throw new Error("项目已切换，请重试");
        }
        if (target === "server") {
          const server = servers.find((item) => item.id === id);
          if (!server || !server.globalEnabled)
            throw new Error("MCP 服务不可修改");
          await window.snow.setMcpProjectServerEnabled(
            directoryId,
            server.id,
            enabled,
          );
          if (
            enabled &&
            [
              "builtin:browser",
              "builtin:app-control",
              "builtin:terminal",
            ].includes(server.id)
          ) {
            window.dispatchEvent(new CustomEvent("lite-mode:changed"));
          }
        } else {
          const server = servers.find(
            (item) =>
              item.enabled &&
              item.globalEnabled &&
              item.tools.some((tool) => tool.name === id),
          );
          if (!server) throw new Error("MCP 工具不可修改");
          await window.snow.setMcpProjectToolEnabled(directoryId, id, enabled);
        }
        return { ok: true };
      },
      getChanges: async (expectedConversationId = null) => {
        const current = stateRef.current;
        const conversationId =
          current.conversation.activeConversationId ?? null;
        if (
          expectedConversationId !== null &&
          expectedConversationId !== conversationId
        ) {
          throw new Error("会话已切换，请重新打开变更");
        }
        if (!conversationId) return { conversationId: null, changes: [] };
        const records =
          current.conversation.fileChangeStats[conversationId] ?? [];
        const changes: SnowRemoteChange[] = records
          .slice()
          .sort((left, right) => right.timestamp - left.timestamp)
          .slice(0, 200)
          .map((record) => {
            const normalized = record.filePath.replaceAll("\\\\", "/");
            const relative = normalized.replace(/^([A-Za-z]:)?\/+/, "");
            const path =
              relative.split("/").filter(Boolean).slice(-4).join("/") ||
              "未命名文件";
            return {
              path: truncateTo(path, 240) ?? "未命名文件",
              kind: record.kind,
              agent: record.agent,
              timestamp: record.timestamp,
            };
          });
        if (
          stateRef.current.conversation.activeConversationId !== conversationId
        ) {
          throw new Error("会话已切换，请重新打开变更");
        }
        return { conversationId, changes };
      },
      /**
       * 会话待办变更：复用桌面真实 todo-todo-manage 工具（add / update /
       * delete），会话 ID 由桥注入，移动端无法跨会话读写。变更后立即失效
       * 快照缓存，调用方随后刷新 /api/state 即可拿到最新列表。
       * 与桌面顶部待办面板一致：会话运行中待办由 AI 管理，不接受手动变更。
       */
      mutateTodos: async (
        action: "add" | "update" | "delete",
        payload:
          | { content?: string; todoId?: string; status?: SnowRemoteTodoStatus }
          | undefined,
      ): Promise<{ ok: true }> => {
        const current = stateRef.current.conversation;
        const conversationId = current.activeConversationId ?? null;
        if (!conversationId) {
          throw new Error("当前没有进行中的会话，暂时无法管理待办");
        }
        if (current.isStreaming) {
          throw new Error("会话运行中，待办由 AI 管理，请稍后再试");
        }

        const args: Record<string, string> = {};
        if (action === "add") {
          const content =
            typeof payload?.content === "string" ? payload.content.trim() : "";
          if (!content) throw new Error("待办内容不能为空");
          if (content.length > MAX_TODO_CONTENT_LENGTH) {
            throw new Error(
              `待办内容不能超过 ${MAX_TODO_CONTENT_LENGTH} 个字符`,
            );
          }
          args.action = "add";
          args.content = content;
        } else if (action === "update" || action === "delete") {
          const todoId = normalizeRemoteIdentifier(payload?.todoId ?? "");
          if (!todoId) throw new Error("待办条目不存在或已过期");
          args.action = action;
          args.todoId = todoId;
          if (action === "update") {
            const status = payload?.status;
            if (
              status !== "pending" &&
              status !== "inProgress" &&
              status !== "completed"
            ) {
              throw new Error("待办状态无效");
            }
            args.status = status;
          }
        } else {
          throw new Error("不支持的待办操作");
        }

        await window.snow.callMcpTool(
          "todo-todo-manage",
          JSON.stringify(args),
          stateRef.current.activeDirectory?.directoryId,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          conversationId,
        );
        todosCacheRef.current = null;
        return { ok: true };
      },
      getPermissions: async () => {
        const directoryId =
          stateRef.current.activeDirectory?.directoryId ?? null;
        const [project, global, readonly] = await Promise.all([
          directoryId
            ? window.snow.listToolApprovalProjectApprovedTools(directoryId)
            : Promise.resolve([] as string[]),
          window.snow.getAlwaysApprovedTools().catch(() => [] as string[]),
          window.snow.listReadonlyTools().catch(() => [] as string[]),
        ]);
        if (
          (stateRef.current.activeDirectory?.directoryId ?? null) !==
          directoryId
        )
          throw new Error("项目已切换，请重新打开权限");
        const sanitize = (items: string[]) =>
          Array.from(new Set(items))
            .slice(0, 500)
            .map((item) => truncateTo(item, MAX_IDENTIFIER_LENGTH) ?? "")
            .filter(Boolean);
        return {
          directoryId,
          projectApprovedTools: sanitize(project),
          globalApprovedTools: sanitize(global),
          readonlyToolCount: Math.min(1000, readonly.length),
          yolo: Boolean(stateRef.current.conversation.yoloMode),
        };
      },
      getRole: async () => {
        const directoryId =
          stateRef.current.activeDirectory?.directoryId ?? null;
        const workspace = directoryId
          ? (await window.snow.listWorkspaceDirectories()).find(
              (item) => item.directoryId === directoryId,
            )
          : null;
        if (!workspace) {
          const global = await window.snow
            .getGlobalRole()
            .catch(() => ({ content: "" }));
          const content =
            typeof global.content === "string" ? global.content : "";
          return {
            directoryId,
            source: content ? ("global" as const) : ("none" as const),
            exists: Boolean(content),
            characterCount: content.length,
            preview: truncateTo(content, 1200) ?? "",
            editable: false,
            reason: "请先在桌面选择项目以查看项目角色",
          };
        }
        if (workspace.path.startsWith("ssh://"))
          return {
            directoryId,
            source: "ssh" as const,
            exists: false,
            characterCount: 0,
            preview: "",
            editable: false,
            reason:
              "SSH 项目的 ROLE.md 需要桌面凭据与工作区会话，手机仅显示状态",
          };
        const filePath = workspace.path + "/ROLE.md";
        let content = "";
        try {
          const result = await window.snow.readFileContent(filePath);
          if (!result.isBinary) content = result.content;
        } catch {
          content = "";
        }
        if (
          (stateRef.current.activeDirectory?.directoryId ?? null) !==
          directoryId
        )
          throw new Error("项目已切换，请重新打开角色");
        return {
          directoryId,
          source: content ? ("project" as const) : ("none" as const),
          exists: Boolean(content),
          characterCount: content.length,
          preview: truncateTo(content, 1200) ?? "",
          editable: false,
          reason: content
            ? "手机仅提供只读摘要，编辑请在桌面完成"
            : "当前项目未找到 ROLE.md",
        };
      },
      getSensitiveCommands: async () => {
        const directoryId =
          stateRef.current.activeDirectory?.directoryId ?? null;
        const [global, project] = await Promise.all([
          window.snow.listSensitiveCommandConfigs().catch(() => []),
          directoryId
            ? window.snow
                .listProjectSensitiveCommandConfigs(directoryId)
                .catch(() => [])
            : Promise.resolve([]),
        ]);
        if (
          (stateRef.current.activeDirectory?.directoryId ?? null) !==
          directoryId
        )
          throw new Error("项目已切换，请重新打开敏感指令");
        const normalize = (items: Array<any>, scope: "global" | "project") =>
          items
            .slice(0, 300)
            .map((item) => ({
              commandId:
                truncateTo(
                  typeof item.commandId === "string" ? item.commandId : "",
                  MAX_IDENTIFIER_LENGTH,
                ) ?? "",
              pattern:
                truncateTo(
                  typeof item.pattern === "string" ? item.pattern : "",
                  240,
                ) ?? "",
              description:
                truncateTo(
                  typeof item.description === "string" ? item.description : "",
                  500,
                ) ?? "",
              enabled: Boolean(item.enabled),
              scope,
              inherited: Boolean(item.inherited),
              isPreset: Boolean(item.isPreset),
            }))
            .filter((item) => item.commandId && item.pattern);
        return {
          directoryId,
          commands: [
            ...normalize(global, "global"),
            ...normalize(project, "project"),
          ].slice(0, 500),
        };
      },
      getCodebase: async () => {
        const directoryId =
          stateRef.current.activeDirectory?.directoryId ?? null;
        if (!directoryId)
          return {
            directoryId,
            enabled: false,
            agentReview: false,
            reranking: false,
            indexed: false,
            totalFiles: 0,
            totalChunks: 0,
            totalSizeBytes: 0,
            remote: false,
            reason: "请先选择项目",
          };
        const [scope, stats, remote] = await Promise.all([
          window.snow
            .getCodebaseProjectScopeSettings(directoryId)
            .catch(() => ({
              projectId: directoryId,
              enabled: false,
              enableAgentReview: false,
              enableReranking: false,
            })),
          window.snow.getCodebaseIndexStats(directoryId).catch(() => ({
            totalFiles: 0,
            totalChunks: 0,
            totalSizeBytes: 0,
            isIndexed: false,
          })),
          window.snow.checkProjectIsRemote(directoryId).catch(() => false),
        ]);
        if (
          (stateRef.current.activeDirectory?.directoryId ?? null) !==
          directoryId
        )
          throw new Error("项目已切换，请重新打开代码库");
        return {
          directoryId,
          enabled: Boolean(scope.enabled),
          agentReview: Boolean(scope.enableAgentReview),
          reranking: Boolean(scope.enableReranking),
          indexed: Boolean(stats.isIndexed),
          totalFiles: Math.min(1000000, Math.max(0, stats.totalFiles || 0)),
          totalChunks: Math.min(5000000, Math.max(0, stats.totalChunks || 0)),
          totalSizeBytes: Math.min(
            1e15,
            Math.max(0, stats.totalSizeBytes || 0),
          ),
          remote: Boolean(remote),
          reason: remote ? "远程项目的扫描与路径操作请在桌面完成" : undefined,
        };
      },
      getReview: async () => {
        const directoryId =
          stateRef.current.activeDirectory?.directoryId ?? null;
        if (!directoryId)
          return {
            directoryId,
            available: false,
            currentBranch: "",
            stagedCount: 0,
            unstagedCount: 0,
            untrackedCount: 0,
            statusLimitHit: false,
            remote: false,
            reason: "请先选择项目",
          };
        const workspace = (await window.snow.listWorkspaceDirectories()).find(
          (item) => item.directoryId === directoryId,
        );
        if (!workspace)
          return {
            directoryId,
            available: false,
            currentBranch: "",
            stagedCount: 0,
            unstagedCount: 0,
            untrackedCount: 0,
            statusLimitHit: false,
            remote: false,
            reason: "项目工作区不可用",
          };
        if (workspace.path.startsWith("ssh://"))
          return {
            directoryId,
            available: false,
            currentBranch: "",
            stagedCount: 0,
            unstagedCount: 0,
            untrackedCount: 0,
            statusLimitHit: false,
            remote: true,
            reason: "SSH 项目审查需要桌面 Git 会话",
          };
        try {
          const status = await window.snow.gitStatus(workspace.path);
          if (
            (stateRef.current.activeDirectory?.directoryId ?? null) !==
            directoryId
          )
            throw new Error("项目已切换，请重新打开审查");
          return {
            directoryId,
            available: Boolean(status.isRepo),
            currentBranch: truncateTo(status.currentBranch, 240) ?? "",
            stagedCount: Math.min(100000, status.stagedCount || 0),
            unstagedCount: Math.min(100000, status.unstagedCount || 0),
            untrackedCount: Math.min(100000, status.untrackedCount || 0),
            statusLimitHit: Boolean(status.statusLimitHit),
            remote: false,
            reason: status.isRepo
              ? "手机仅显示审查状态，启动审查请在桌面确认"
              : "当前项目不是 Git 仓库",
          };
        } catch {
          return {
            directoryId,
            available: false,
            currentBranch: "",
            stagedCount: 0,
            unstagedCount: 0,
            untrackedCount: 0,
            statusLimitHit: false,
            remote: false,
            reason: "Git 状态暂时不可用，请在桌面重试",
          };
        }
      },
      getState: async (): Promise<SnowRemoteState> => {
        const current = stateRef.current;
        const directory = current.activeDirectory;
        const activeConversationId =
          current.conversation.activeConversationId ?? null;
        const now = Date.now();
        let conversations = conversationCacheRef.current.conversations;
        if (conversationCacheRef.current.expiresAt <= now) {
          // The current conversation must reach the phone immediately. A slow
          // workspace/database listing is secondary data for the thread picker
          // and must never block the first /api/state response.
          conversationCacheRef.current.expiresAt = now + 5_000;
          void (async () => {
            const directories = await window.snow.listWorkspaceDirectories();
            const pages = await Promise.all(
              directories.map(async (workspace) => {
                const page = await window.snow.listChatConversationsPaginated(
                  workspace.directoryId,
                  REMOTE_CONVERSATION_PAGE_SIZE,
                  0,
                );
                return { workspace, page };
              }),
            );
            conversationCacheRef.current = {
              expiresAt: Date.now() + 5_000,
              conversations: pages
                .flatMap(({ workspace, page }) =>
                  page.items.map((item) =>
                    toRemoteConversation(item, workspace.name),
                  ),
                )
                .sort((left, right) =>
                  right.updatedAt.localeCompare(left.updatedAt),
                ),
              totals: Object.fromEntries(
                pages.map(({ workspace, page }) => [
                  workspace.directoryId,
                  page.total,
                ]),
              ),
            };
          })().catch(() => {
            conversationCacheRef.current.expiresAt = Date.now() + 1_000;
          });
        }

        const remoteMessages = current.conversation.messages
          .slice(-MAX_MESSAGES)
          .map(toRemoteMessage);
        const pendingAuthorizations =
          current.conversation.pendingToolAuthorizations
            .filter(
              (toolCall) =>
                Boolean(toolCall.authorizationId) &&
                toolCall.authorizationConversationId === activeConversationId,
            )
            .map(toRemoteToolCall);
        const pendingQuestions = remoteMessages.flatMap((message) =>
          (message.toolCalls ?? []).flatMap((toolCall) => {
            const question = toolCall.userQuestion;
            if (!question || question.status !== "waiting") {
              return [];
            }
            return [
              {
                questionId: question.questionId,
                question: question.question,
                options: question.options,
              },
            ];
          }),
        );

        // 展示用快照：桌面停留在设置页（输入区已卸载）时仍提供模型 /
        // Profile / 思考强度，手机端不因桌面视图切换而退化显示。
        const chatInputPublication = resolveChatInputForDisplay();

        return {
          workspace: directory
            ? {
                directoryId: directory.directoryId,
                name: directory.name,
                path: directory.path,
              }
            : null,
          activeConversationId,
          isStreaming: current.conversation.isStreaming,
          isAborting: current.conversation.isAborting,
          isCompacting: Boolean(current.conversation.isCompacting),
          compactionError: current.conversation.compactionError ?? null,
          attentionRequired:
            activeConversationId !== null &&
            current.conversation.attentionRequiredConversationIds.has(
              activeConversationId,
            ),
          messages: remoteMessages,
          // 待发送队列（会话隔离）：只输出当前激活会话的排队消息，且只含
          // 展示用分段；撤回原文由 withdrawPending 按需返回。
          pendingMessages: current.conversation.pendingMessages.map((text) => ({
            blocks: toRemoteContentBlocks("", text),
          })),
          // 上述队列的定位键（不透明标记）：移动端操作时原样回传，桌面端
          // 按“直接命中 → 槽位迁移映射”解析队列真实位置（新会话迁移到
          // 真实 id 后同样可定位），操作不因会话切换/迁移而失效。
          pendingQueueKey:
            current.conversation.activeSessionKeyRef.current ?? null,
          pendingAuthorizations,
          pendingQuestions,
          conversations,
          conversationTotals: conversationCacheRef.current.totals,
          // 无活动会话（如 /clear 后的新建会话视图）没有更早记录；
          // 会话状态尚未建立（undefined）时不下结论，移动端默认隐藏入口、
          // 待状态就绪后跟随更新。
          hasOlderMessages: activeConversationId
            ? current.conversation.sessions[activeConversationId]
                ?.hasMoreMessages
            : false,
          // 会话待办（会话隔离）：按激活会话读取，切换会话后随快照一起切换。
          todos: await resolveTodos(activeConversationId),
          modes: {
            plan: current.conversation.planMode,
            goal: current.conversation.goalMode,
            worktree: current.conversation.worktreeMode,
            workflow: current.conversation.workflowMode,
            yolo: current.conversation.yoloMode,
            lite: current.conversation.liteMode,
          },
          theme: { accentColor: resolveThemeAccentColor() },
          chatInput: chatInputPublication
            ? toRemoteChatInput(chatInputPublication)
            : null,
        };
      },

      getMessages: async (conversationId, beforeMessageId, limit) => {
        const current = stateRef.current;
        const activeConversationId =
          current.conversation.activeConversationId ?? null;
        if (!activeConversationId || conversationId !== activeConversationId) {
          throw new Error("会话已切换，请重新加载");
        }
        let anchor =
          typeof beforeMessageId === "string" ? beforeMessageId.trim() : "";
        // 锚点必须是数据库消息 id（snowflake 纯数字）。渲染进程的临时消息
        // id（`role-时间-随机串`，如 assistant/tool 消息）在数据库中没有
        // 对应行，直接传入会让 `id < ?` 的字符串比较命中最新的行而不是更早
        // 的行。此时退回到「已加载的数据库记录中最早的一条」，从它继续向前
        // 翻页；没有任何记录时用空锚取最新页，由移动端按 id 去重收敛。
        if (anchor && !/^\d+$/.test(anchor)) {
          const session = current.conversation.sessions[conversationId];
          const records = session?.messageRecords ?? [];
          if (!records.some((record) => record.id === anchor)) {
            anchor = records[0]?.id ?? "";
          }
        }
        const page = await window.snow.listChatMessagesPaginated(
          conversationId,
          anchor,
          limit,
        );
        if (
          (stateRef.current.conversation.activeConversationId ?? null) !==
          conversationId
        ) {
          throw new Error("会话已切换，请重新加载");
        }
        // 与桌面端历史回放共用同一转换：tool 结果按 name#callId 关联回
        // assistant 消息的 toolCalls；role=tool 的原始记录不再单独推送。
        return {
          conversationId,
          hasMore: page.hasMore,
          items: buildConversationMessages(page.items).map(toRemoteMessage),
        };
      },

      getConversations: async (directoryId, limit, offset) => {
        const directories = await window.snow.listWorkspaceDirectories();
        const workspace = directories.find(
          (item) => item.directoryId === directoryId,
        );
        if (!workspace) {
          throw new Error("目标工作区不可用");
        }
        const page = await window.snow.listChatConversationsPaginated(
          directoryId,
          limit,
          offset,
        );
        return {
          directoryId,
          total: page.total,
          items: page.items.map((item) =>
            toRemoteConversation(item, workspace.name),
          ),
        };
      },

      send: async (
        text,
        attachmentIds = [],
        _requestId,
        expectedContext,
        pairingGeneration,
      ): Promise<{ ok: true }> => {
        const normalized = text.trim();
        if (!normalized && attachmentIds.length === 0) {
          throw new Error("消息不能为空");
        }
        if (normalized.length > MAX_SEND_LENGTH) {
          throw new Error(`消息不能超过 ${MAX_SEND_LENGTH} 个字符`);
        }
        if (
          !expectedContext ||
          typeof pairingGeneration !== "number" ||
          attachmentIds.length > 4
        ) {
          throw new Error("附件上下文无效");
        }
        const currentContext = (): typeof expectedContext => ({
          directoryId: stateRef.current.activeDirectory?.directoryId ?? null,
          conversationId:
            stateRef.current.conversation.activeConversationId ?? null,
        });
        const contextMatches = (): boolean => {
          const current = currentContext();
          return (
            current.directoryId === expectedContext.directoryId &&
            current.conversationId === expectedContext.conversationId
          );
        };
        if (!contextMatches()) throw new Error("会话已切换，请重新发送");
        const attachments = await window.snow.resolveRemoteAttachments(
          attachmentIds,
          expectedContext,
          pairingGeneration,
        );
        if (!contextMatches()) throw new Error("会话已切换，请重新发送");
        const encodedAttachments = attachments.map((attachment) => {
          if (attachment.kind === "image" && attachment.dataUrl) {
            return `@@image:${attachment.dataUrl}@@`;
          }
          if (attachment.kind === "file" && attachment.path) {
            return `@@file:${attachment.path}@@`;
          }
          throw new Error("附件内容无效");
        });
        const message = [normalized, ...encodedAttachments]
          .filter(Boolean)
          .join("\n");
        stateRef.current.onSelectMainView("chat");
        stateRef.current.conversation.handleSendMessage(message, {});
        return { ok: true };
      },

      abort: async (): Promise<{ ok: true }> => {
        stateRef.current.conversation.handleAbort();
        return { ok: true };
      },

      // 待发送队列操作：移动端原样回传“所见队列”的定位键
      // （pendingQueueKey：不透明标记，新会话槽位 key 或真实会话 id）。
      // useConversationManagement 侧按“直接命中 → 槽位迁移映射”解析出
      // 队列的真实位置并从该队列执行（会话隔离）——无论桌面当前视图在
      // 哪个会话、新会话是否已迁移到真实 id，只要条目仍在队列中就能
      // 撤回/立即发送；条目已被回合边界自动消费时统一报“待发送消息不存在”。
      sendPendingNow: async (
        index,
        expectedQueueKey,
      ): Promise<{ ok: true }> => {
        const current = stateRef.current.conversation;
        if (!Number.isInteger(index) || index < 0) {
          throw new Error("待发送消息不存在");
        }
        const dispatched = current.sendPendingMessageNow(
          index,
          expectedQueueKey ?? undefined,
        );
        if (!dispatched) {
          throw new Error(
            `待发送消息不存在${pendingOperationFailureDetail(current, expectedQueueKey, index)}`,
          );
        }
        return { ok: true };
      },

      withdrawPending: async (
        index,
        expectedQueueKey,
      ): Promise<{ ok: true; text: string }> => {
        const current = stateRef.current.conversation;
        if (!Number.isInteger(index) || index < 0) {
          throw new Error("待发送消息不存在");
        }
        const text = current.withdrawPendingMessage(
          index,
          expectedQueueKey ?? undefined,
        );
        if (text === null) {
          throw new Error(
            `待发送消息不存在${pendingOperationFailureDetail(current, expectedQueueKey, index)}`,
          );
        }
        return { ok: true, text };
      },

      newChat: async (): Promise<{ ok: true }> => {
        const current = stateRef.current.conversation;
        if (current.isStreaming) {
          throw new Error("请先停止当前运行");
        }
        stateRef.current.onSelectMainView("chat");
        current.handleNewChat();
        return { ok: true };
      },

      // 真实模式 setter 链：toolAuthApi.setPlanMode / setGoalMode /
      // setWorktreeMode / setWorkflowMode / setYoloMode / setLiteMode。
      // 语义与桌面 PlusMenu 完全一致（布尔开关，可关闭）；
      // Plan/Goal/Worktree/Workflow 的互斥由这些 setter 自身保证。
      // 与桌面一致：没有活动会话（新会话视图）时切换同样合法——
      // 会话级模式写入 pending session、应用级设置直接落库，
      // 都随首次发送 / 立即生效，因此这里不要求 activeConversationId。
      // 安全边界：YOLO 只自动批准“普通 pending 工具授权”，
      // 敏感命令仍走桌面端独立确认，YOLO 不是远控鉴权手段。
      setMode: async (mode, enabled): Promise<{ ok: true }> => {
        const current = stateRef.current.conversation;
        // 二次校验：Main 层已做枚举+布尔校验，这里再独立校验一次。
        if (typeof enabled !== "boolean") {
          throw new Error("模式开关必须是布尔值");
        }
        // 与桌面 PlusMenu 的 modesLocked 一致：会话运行中（流式 / 正在停止 /
        // 正在压缩）不允许启停模式（YOLO 不受限）。手机端快照可能滞后，
        // 这里按实时状态兜底拒绝，错误消息由手机端直接展示。
        if (
          mode !== "yolo" &&
          (current.isStreaming ||
            current.isAborting ||
            Boolean(current.isCompacting))
        ) {
          throw new Error("会话进行中，暂不可切换模式");
        }
        switch (mode) {
          case "plan":
            await current.setPlanMode(enabled);
            break;
          case "goal":
            await current.setGoalMode(enabled);
            break;
          case "worktree":
            await current.setWorktreeMode(enabled);
            break;
          case "workflow":
            await current.setWorkflowMode(enabled);
            break;
          case "yolo":
            await current.setYoloMode(enabled);
            break;
          case "lite":
            await current.setLiteMode(enabled);
            break;
          default:
            throw new Error("不支持的模式");
        }
        return { ok: true };
      },

      // 复用真实 handleSelectModel setter 链（会话级模型选择）。
      setModel: async (modelId: string): Promise<{ ok: true }> => {
        const normalized = normalizeRemoteIdentifier(modelId);
        if (!normalized) {
          throw new Error("模型 ID 不能为空");
        }
        if (normalized.length > MAX_IDENTIFIER_LENGTH) {
          throw new Error("模型 ID 过长");
        }
        const publication = requireChatInputForMutation();
        if (!publication.modelIds.includes(normalized)) {
          throw new Error("模型不存在或尚未加载模型列表");
        }
        await publication.actions.handleSelectModel(normalized);
        return { ok: true };
      },

      // 复用真实 handleSelectApiProfile setter 链（会话级 Profile 绑定）。
      setApiProfile: async (profileName: string): Promise<{ ok: true }> => {
        const normalized = normalizeRemoteIdentifier(profileName);
        if (!normalized) {
          throw new Error("Profile 名称不能为空");
        }
        if (normalized.length > MAX_IDENTIFIER_LENGTH) {
          throw new Error("Profile 名称过长");
        }
        const publication = requireChatInputForMutation();
        if (!publication.apiProfileNames.includes(normalized)) {
          throw new Error("Profile 不存在或不可用");
        }
        await publication.actions.handleSelectApiProfile(normalized);
        return { ok: true };
      },

      // 复用真实 handleSelectThinking setter 链；"" = 继承 Profile 默认，
      // 非空为自定义强度（与桌面 ThinkingStrengthMenu 自定义输入一致）。
      setThinking: async (value: string): Promise<{ ok: true }> => {
        const publication = requireChatInputForMutation();
        const nextValue = typeof value === "string" ? value.trim() : "";
        if (nextValue.length > MAX_THINKING_LENGTH) {
          throw new Error(`思考强度值不能超过 ${MAX_THINKING_LENGTH} 个字符`);
        }
        await publication.actions.handleSelectThinking(nextValue);
        return { ok: true };
      },

      // 复用真实 handleToggleResponsesFastMode setter 链。
      // desired 为布尔时做幂等处理：与当前状态一致则直接返回，
      // 避免手机端与桌面端并发点击造成来回翻转。
      toggleResponsesFastMode: async (desired?): Promise<{ ok: true }> => {
        const publication = requireChatInputForMutation();
        if (publication.requestMethod !== "responses") {
          throw new Error("当前请求方式不支持 Responses Fast Mode");
        }
        if (
          typeof desired === "boolean" &&
          desired === publication.responsesFastModeEnabled
        ) {
          return { ok: true };
        }
        await publication.actions.handleToggleResponsesFastMode();
        return { ok: true };
      },

      // 按真实 createChatCommands 产物执行指令：找不到或不满足桌面禁用
      // 条件（isRunning 等）时拒绝。不阻塞流式：面板类指令在桌面同样可用，
      // 受限指令的禁用状态由命令注册表自己声明。
      runCommand: async (id: string): Promise<{ ok: true }> => {
        const commandId = normalizeRemoteIdentifier(id);
        if (!commandId) {
          throw new Error("指令 ID 不能为空");
        }
        if (commandId.length > MAX_IDENTIFIER_LENGTH) {
          throw new Error("指令 ID 过长");
        }
        const publication = resolveChatInput();
        if (!publication) {
          // 同 requireChatInputForMutation：桌面不在对话页时指令不可执行。
          throw new Error(
            resolveChatInputForDisplay()
              ? "电脑端不在对话页，暂时无法执行"
              : "聊天输入区未就绪或会话不匹配",
          );
        }
        const command = publication.commands.find(
          (item) => item.id === commandId,
        );
        if (!command) {
          throw new Error("指令不存在");
        }
        if (command.disabled) {
          throw new Error("指令当前不可用");
        }
        command.execute();
        return { ok: true };
      },

      approve: async (authorizationId: string): Promise<{ ok: true }> => {
        const current = stateRef.current.conversation;
        const toolCall = current.pendingToolAuthorizations.find(
          (item) =>
            item.authorizationId === authorizationId &&
            item.authorizationConversationId === current.activeConversationId,
        );
        if (!toolCall) throw new Error("授权请求不存在或已过期");
        current.approveToolAuthorization(toolCall);
        return { ok: true };
      },

      reject: async (
        authorizationId: string,
        reason?: string,
      ): Promise<{ ok: true }> => {
        const current = stateRef.current.conversation;
        const toolCall = current.pendingToolAuthorizations.find(
          (item) =>
            item.authorizationId === authorizationId &&
            item.authorizationConversationId === current.activeConversationId,
        );
        if (!toolCall) throw new Error("授权请求不存在或已过期");
        current.rejectToolAuthorization(
          toolCall,
          reason?.trim() || "User declined tool execution from Snow Remote",
        );
        return { ok: true };
      },

      answer: async (
        questionId: string,
        selectedOptions: string[],
        customAnswers: string[],
      ): Promise<{ ok: true }> => {
        const current = stateRef.current.conversation;
        const pending = current.messages.some((message) =>
          message.toolCalls?.some(
            (toolCall) =>
              toolCall.userQuestion?.questionId === questionId &&
              toolCall.userQuestion.status === "waiting",
          ),
        );
        if (!pending || !current.activeConversationId) {
          throw new Error("问题不存在、已过期或不属于当前会话");
        }
        if (
          ![...selectedOptions, ...customAnswers].some((value) => value.trim())
        ) {
          throw new Error("回答不能为空");
        }
        current.answerUserQuestion(questionId, selectedOptions, customAnswers);
        return { ok: true };
      },

      cancelQuestion: async (questionId: string): Promise<{ ok: true }> => {
        const current = stateRef.current.conversation;
        const pending = current.messages.some((message) =>
          message.toolCalls?.some(
            (toolCall) =>
              toolCall.userQuestion?.questionId === questionId &&
              toolCall.userQuestion.status === "waiting",
          ),
        );
        if (!pending || !current.activeConversationId) {
          throw new Error("问题不存在、已过期或不属于当前会话");
        }
        current.cancelUserQuestion(questionId);
        return { ok: true };
      },

      select: async (
        rawConversationId: string,
        requestedDirectoryId?: string,
      ): Promise<{ ok: true }> => {
        const conversationId = rawConversationId.trim();
        if (!conversationId) {
          throw new Error("会话 ID 不能为空");
        }

        const target: ChatConversationRecord | null =
          await window.snow.getChatConversation(conversationId);
        if (!target) {
          throw new Error("目标会话不存在");
        }

        const directoryId = target.directoryId.trim();
        if (
          requestedDirectoryId?.trim() &&
          requestedDirectoryId.trim() !== directoryId
        ) {
          throw new Error("会话与工作区不匹配");
        }

        if (
          stateRef.current.activeDirectory?.directoryId.trim() !== directoryId
        ) {
          const directories =
            await window.snow.activateWorkspaceDirectory(directoryId);
          const nextDirectory =
            directories.find(
              (directory) =>
                directory.directoryId.trim() === directoryId &&
                directory.isActive,
            ) ??
            directories.find(
              (directory) => directory.directoryId.trim() === directoryId,
            );
          if (!nextDirectory) {
            throw new Error("目标工作区不可用");
          }
          stateRef.current.activeDirectory = nextDirectory;
          stateRef.current.onActiveDirectoryChange(nextDirectory);
        }

        stateRef.current.onSelectMainView("chat");
        await stateRef.current.conversation.handleSelectConversation(
          conversationId,
          target.summary || target.title,
          {
            inputTokens: target.inputTokens,
            outputTokens: target.outputTokens,
            cacheCreationInputTokens: target.cacheCreationInputTokens,
            cacheReadInputTokens: target.cacheReadInputTokens,
          },
          directoryId,
        );
        return { ok: true };
      },
    };

    window.__snowRemoteControl = api;
    return () => {
      if (window.__snowRemoteControl === api) {
        delete window.__snowRemoteControl;
      }
    };
  }, []);

  return null;
};
