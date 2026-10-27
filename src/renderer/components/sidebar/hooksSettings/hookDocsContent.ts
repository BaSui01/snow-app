/**
 * Multi-language documentation content for each hook type.
 *
 * Each hook type has a `title`, `description`, `contextFields`, `exitCodes`,
 * and `examples` entry. The content is rendered by the HooksDocsContent component.
 */

import type { Locale } from "../../../i18n/locales";

export type HookDocContextField = {
  name: string;
  description: string;
};

export type HookDocExitCode = {
  code: string;
  meaning: string;
};

export type HookDocExample = {
  title: string;
  /** "command" or "context" — matches the action type in the rule editor */
  actionType: string;
  /** For "command" examples: the shell command. For "context" examples: the content text. */
  body: string;
  /** Optional matcher string (for tool hooks) */
  matcher?: string;
  explanation: string;
};

export type HookDocContent = {
  title: string;
  description: string;
  contextFields: HookDocContextField[];
  exitCodes: HookDocExitCode[];
  examples: HookDocExample[];
};

export type HookDecisionConfirmationDoc = {
  title: string;
  description: string;
  body: string;
  explanation: string;
};

// ---------------------------------------------------------------------------
// English
// ---------------------------------------------------------------------------

const enDecisionConfirmationDoc: HookDecisionConfirmationDoc = {
  title: "Exit 1 decision confirmation",
  description:
    "All command actions use the same decision JSON convention. Exit 1 with plain-text stdout remains a soft warning; exit 1 with valid JSON containing decision.message triggers the decision UI.",
  body: '# Output decision JSON (on exit 1, decision.message in stdout triggers the decision UI)\necho \'{"decision":{"message":"Continue with this operation?"}}\'\nexit 1',
  explanation:
    "The command's stdout must contain only valid JSON in this format. decision.message is shown to the user for approval or rejection before the current flow continues.",
};

const enDocs: Record<string, HookDocContent> = {
  onUserMessage: {
    title: "onUserMessage",
    description:
      "Runs when the user sends a new message, before the message is forwarded to the AI. " +
      "The hook command receives the full context JSON via stdin. " +
      "On exit 0, stdout is injected as [Hook Context] into the message sent to the AI (invisible in the UI). " +
      "On exit 1, the warning text is injected as [Hook Warning]. " +
      "On exit 2+, the AI loop is aborted and the error is shown to the user.",
    contextFields: [
      { name: "message", description: "The user's message text." },
      {
        name: "cwd",
        description:
          "Current working directory. Also used as the command's working directory.",
      },
      {
        name: "sessionId",
        description:
          "Conversation session ID (omitted for the very first message before a conversation is created).",
      },
    ],
    exitCodes: [
      {
        code: "0",
        meaning:
          "Pass — stdout injected as [Hook Context] into the message sent to the AI.",
      },
      {
        code: "1",
        meaning:
          "Warn — warning text injected as [Hook Warning]. Message still sent to AI.",
      },
      {
        code: "2+",
        meaning: "Abort — AI loop interrupted, error shown to user.",
      },
    ],
    examples: [
      {
        title: "Inject project context",
        actionType: "command",
        body: "echo 'The project uses TypeScript with strict mode. All functions must have explicit return types.'",
        explanation:
          "Exit 0 with stdout text. The text is appended to the user's message as [Hook Context] — the AI sees it but the user does not.",
      },
      {
        title: "Warn about sensitive keywords",
        actionType: "command",
        body: "ctx=$(cat)\nmsg=$(echo \"$ctx\" | jq -r '.message')\nif echo \"$msg\" | grep -qi 'password\\|secret\\|api key'; then\n  echo 'Warning: your message may contain sensitive information'\n  exit 1\nfi",
        explanation:
          "Reads context from stdin, checks the message for sensitive keywords. Exit 1 injects the warning as [Hook Warning].",
      },
      {
        title: "Static context (no script)",
        actionType: "context",
        body: "Always respond in markdown. Use code blocks with language tags.",
        explanation:
          "Context-type action injects static text directly — no command execution. Useful for system-wide instructions.",
      },
    ],
  },
  beforeToolCall: {
    title: "beforeToolCall",
    description:
      "Runs before a tool is executed. The context includes the tool name and parsed arguments. " +
      "Supports tool matchers — only runs when the matcher matches the tool name. " +
      "On exit 0, stdout can auto-answer interactive tools (askUserQuestion). " +
      "On exit 2+, the AI loop is fully interrupted.",
    contextFields: [
      {
        name: "toolName",
        description:
          "Name of the tool about to be called (e.g. filesystem-read, bash-terminal-execute).",
      },
      {
        name: "args",
        description:
          'Parsed tool arguments as a JSON object (e.g. {"path": "/src/main.ts"}).',
      },
      {
        name: "cwd",
        description:
          "Current working directory. Also used as the command's working directory.",
      },
    ],
    exitCodes: [
      {
        code: "0",
        meaning:
          "Pass — stdout can auto-answer interactive tools (askUserQuestion). For normal tools, stdout is ignored.",
      },
      {
        code: "1",
        meaning:
          "Warn — warning collected and shown to user. Tool still executes.",
      },
      {
        code: "2+",
        meaning: "Abort — AI loop fully interrupted. Tool does not execute.",
      },
    ],
    examples: [
      {
        title: "Block writes to .env files",
        actionType: "command",
        matcher: "filesystem-create,filesystem-edit,filesystem-replaceedit",
        body: "ctx=$(cat)\npath=$(echo \"$ctx\" | jq -r '.args.path // empty')\nif echo \"$path\" | grep -qi '\\.env$'; then\n  echo 'Blocked: writing to .env files is not allowed'\n  exit 2\nfi",
        explanation:
          "Matcher limits this hook to filesystem write tools. Reads the file path from args, blocks writes to .env files with exit 2.",
      },
      {
        title: "Warn before terminal execute",
        actionType: "command",
        matcher: "bash-terminal-execute",
        body: 'ctx=$(cat)\ncmd=$(echo "$ctx" | jq -r \'.args.command // empty\')\necho "About to execute: $cmd"\nexit 1',
        explanation:
          "Matcher only triggers for bash-terminal-execute. Exit 1 warns the user with the command being executed. The tool still runs.",
      },
    ],
  },
  afterToolCall: {
    title: "afterToolCall",
    description:
      "Runs after a tool call completes. The context includes the tool name, arguments, and the parsed result. " +
      "Supports tool matchers. " +
      "On exit 0, stdout is appended as [Hook Context] to the tool result sent to the AI. " +
      "On exit 2+, the AI loop is fully interrupted.",
    contextFields: [
      { name: "toolName", description: "Name of the tool that was called." },
      { name: "args", description: "Parsed tool arguments as a JSON object." },
      {
        name: "result",
        description: "Parsed tool result as a JSON object (varies by tool).",
      },
      {
        name: "cwd",
        description:
          "Current working directory. Also used as the command's working directory.",
      },
    ],
    exitCodes: [
      {
        code: "0",
        meaning: "Pass — stdout appended as [Hook Context] to the tool result.",
      },
      {
        code: "1",
        meaning: "Warn — warning collected, tool result unchanged.",
      },
      { code: "2+", meaning: "Abort — AI loop fully interrupted." },
    ],
    examples: [
      {
        title: "Log all file reads",
        actionType: "command",
        matcher: "filesystem-read",
        body: 'ctx=$(cat)\npath=$(echo "$ctx" | jq -r \'.args.path // empty\')\necho "[$(date -Iseconds)] Read: $path" >> .snow/log/file-access.log',
        explanation:
          "Appends every file read to a log file. Exit 0 means the tool result is unaffected (stdout is empty, so no context is injected).",
      },
      {
        title: "Add lint reminder after file writes",
        actionType: "command",
        matcher: "filesystem-create,filesystem-edit",
        body: "echo 'Remember to run the linter after file changes.'",
        explanation:
          "After any file write tool, injects a reminder for the AI to run the linter. The AI sees this as [Hook Context] appended to the tool result.",
      },
    ],
  },
  toolConfirmation: {
    title: "toolConfirmation",
    description:
      "Runs before the tool authorization dialog is shown to the user. " +
      "Supports tool matchers. " +
      "On exit 2+, the tool is auto-rejected without showing the dialog. " +
      "This lets you enforce tool policies without user interaction.",
    contextFields: [
      {
        name: "toolName",
        description: "Name of the tool requesting authorization.",
      },
      { name: "args", description: "Parsed tool arguments as a JSON object." },
      {
        name: "cwd",
        description:
          "Current working directory. Also used as the command's working directory.",
      },
    ],
    exitCodes: [
      {
        code: "0",
        meaning:
          "Pass — tool proceeds through the normal authorization flow (YOLO auto-approve or dialog).",
      },
      {
        code: "1",
        meaning:
          "Warn — warning collected, normal authorization flow continues.",
      },
      {
        code: "2+",
        meaning:
          "Abort — tool auto-rejected with the hook's error message. No dialog shown.",
      },
    ],
    examples: [
      {
        title: "Auto-reject rm -rf",
        actionType: "command",
        matcher: "bash-terminal-execute",
        body: "ctx=$(cat)\ncmd=$(echo \"$ctx\" | jq -r '.args.command // empty')\nif echo \"$cmd\" | grep -qE 'rm\\s+-rf\\s+/'; then\n  echo 'Blocked: rm -rf on root directory is forbidden'\n  exit 2\nfi",
        explanation:
          "Checks terminal commands for dangerous rm -rf /. Exit 2 auto-rejects the tool without showing the authorization dialog.",
      },
    ],
  },
  onSubAgentComplete: {
    title: "onSubAgentComplete",
    description:
      "Runs after a sub-agent finishes its task. The context includes the sub-agent's prompt and output summary. " +
      "On exit 0, stdout is appended as [Hook Context] to the summary returned to the parent AI. " +
      "On exit 2+, the hook error message replaces the summary.",
    contextFields: [
      { name: "agentId", description: "The sub-agent's identifier." },
      { name: "agentName", description: "The sub-agent's display name." },
      {
        name: "prompt",
        description: "The prompt that was sent to the sub-agent.",
      },
      { name: "summary", description: "The sub-agent's output summary." },
      {
        name: "parentConversationId",
        description: "The parent conversation's session ID.",
      },
      {
        name: "cwd",
        description:
          "Current working directory. Also used as the command's working directory.",
      },
    ],
    exitCodes: [
      {
        code: "0",
        meaning: "Pass — context appended to summary as [Hook Context].",
      },
      {
        code: "1",
        meaning: "Warn — warning appended to summary as [Hook Warning].",
      },
      {
        code: "2+",
        meaning:
          "Abort — hook error message replaces the summary returned to the parent AI.",
      },
    ],
    examples: [
      {
        title: "Log sub-agent results",
        actionType: "command",
        body: 'ctx=$(cat)\nagent=$(echo "$ctx" | jq -r \'.agentName // empty\')\nsummary=$(echo "$ctx" | jq -r \'.summary // empty\')\necho "[$(date -Iseconds)] Agent: $agent" >> .snow/log/subagent.log\necho "$summary" >> .snow/log/subagent.log',
        explanation:
          "Logs every sub-agent completion to a file. Exit 0 with empty stdout means no context is injected.",
      },
    ],
  },
  beforeCompress: {
    title: "beforeCompress",
    description:
      "Runs before context compaction begins. " +
      "On exit 2+, compaction is aborted and the user sees the hook's error message. " +
      "Useful for preventing compaction in specific scenarios.",
    contextFields: [
      {
        name: "conversationId",
        description: "The conversation being compacted.",
      },
      {
        name: "isAuto",
        description:
          "Whether this was triggered automatically by token threshold (true) or manually by the user (false).",
      },
      {
        name: "cwd",
        description:
          "Current working directory. Also used as the command's working directory.",
      },
    ],
    exitCodes: [
      { code: "0", meaning: "Pass — compaction proceeds." },
      { code: "1", meaning: "Warn — warning collected, compaction proceeds." },
      {
        code: "2+",
        meaning: "Abort — compaction aborted with the hook's error message.",
      },
    ],
    examples: [
      {
        title: "Block auto-compaction",
        actionType: "command",
        body: 'ctx=$(cat)\nis_auto=$(echo "$ctx" | jq -r \'.isAuto // false\')\nif [ "$is_auto" = "true" ]; then\n  echo \'Auto-compaction blocked. Please compact manually.\'\n  exit 2\nfi',
        explanation:
          "Only allows manual compaction. Auto-compaction (triggered by token threshold) is blocked with exit 2.",
      },
    ],
  },
  onSessionStart: {
    title: "onSessionStart",
    description:
      "Runs when the user opens an existing conversation (after history is loaded). " +
      "Fire-and-forget — cannot block the session switch. " +
      "Supports context-type actions for injecting static information. " +
      "Hook output is recorded for audit but does not affect the conversation.",
    contextFields: [
      {
        name: "conversationId",
        description: "The conversation that was opened.",
      },
      {
        name: "cwd",
        description:
          "Current working directory. Also used as the command's working directory.",
      },
      { name: "directoryId", description: "The workspace directory ID." },
    ],
    exitCodes: [
      { code: "0", meaning: "Pass — hook output recorded for audit." },
      {
        code: "1",
        meaning: "Warn — warning recorded, session switch unaffected.",
      },
      {
        code: "2+",
        meaning:
          "Abort — error recorded, session switch still proceeds (fire-and-forget).",
      },
    ],
    examples: [
      {
        title: "Notify on session open",
        actionType: "command",
        body: 'echo "Session opened at $(date -Iseconds)" >> .snow/log/sessions.log',
        explanation:
          "Logs every time a conversation is opened. Exit 0 with empty stdout — no output injected.",
      },
    ],
  },
  onStop: {
    title: "onStop",
    description:
      "Runs when the AI loop stops — whether by natural completion, user abort, error, or being superseded by a newer run. " +
      "Fire-and-forget. " +
      "The context includes a 'reason' field indicating why the loop stopped. " +
      "Hook output is recorded for audit but does not affect cleanup.",
    contextFields: [
      {
        name: "conversationId",
        description:
          "The conversation that stopped (omitted for pending sessions that never persisted).",
      },
      {
        name: "cwd",
        description:
          "Current working directory. Also used as the command's working directory.",
      },
      {
        name: "reason",
        description:
          'Why the loop stopped: "completed" (natural end) or "aborted" (user cancelled or error).',
      },
    ],
    exitCodes: [
      { code: "0", meaning: "Pass — hook output recorded for audit." },
      { code: "1", meaning: "Warn — warning recorded, cleanup unaffected." },
      {
        code: "2+",
        meaning:
          "Abort — error recorded, cleanup still proceeds (fire-and-forget).",
      },
    ],
    examples: [
      {
        title: "Log stop events",
        actionType: "command",
        body: 'ctx=$(cat)\nreason=$(echo "$ctx" | jq -r \'.reason // empty\')\necho "[$(date -Iseconds)] AI loop stopped: $reason" >> .snow/log/ai-stops.log',
        explanation:
          "Logs every AI loop stop with the reason. Useful for tracking how often users cancel vs. let the AI finish.",
      },
      {
        title: "Run cleanup script on stop",
        actionType: "command",
        body: "if [ -f .snow/scripts/on-stop.sh ]; then\n  bash .snow/scripts/on-stop.sh\nfi",
        explanation:
          "Runs a project-specific cleanup script when the AI loop stops. You can use this to clean up temporary files, stop dev servers, etc.",
      },
    ],
  },
  beforeSubAgentStart: {
    title: "beforeSubAgentStart",
    description:
      "Runs before a sub-agent session is created. " +
      "On exit 2+, the sub-agent activation is aborted immediately. " +
      "Useful for enforcing policies on which sub-agents can be used.",
    contextFields: [
      { name: "agentId", description: "The sub-agent's identifier." },
      { name: "agentName", description: "The sub-agent's display name." },
      {
        name: "prompt",
        description: "The prompt to be sent to the sub-agent.",
      },
      {
        name: "parentConversationId",
        description: "The parent conversation's session ID.",
      },
      {
        name: "cwd",
        description:
          "Current working directory. Also used as the command's working directory.",
      },
    ],
    exitCodes: [
      { code: "0", meaning: "Pass — sub-agent activation proceeds." },
      { code: "1", meaning: "Warn — warning collected, activation proceeds." },
      {
        code: "2+",
        meaning:
          "Abort — sub-agent activation aborted with the hook's error message.",
      },
    ],
    examples: [
      {
        title: "Block specific sub-agent",
        actionType: "command",
        body: 'ctx=$(cat)\nagent_id=$(echo "$ctx" | jq -r \'.agentId // empty\')\nif [ "$agent_id" = "debug-agent" ]; then\n  echo \'The debug sub-agent is disabled in this project\'\n  exit 2\nfi',
        explanation:
          "Blocks a specific sub-agent by ID. Exit 2 aborts the sub-agent activation before it starts.",
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Simplified Chinese
// ---------------------------------------------------------------------------

const zhCNDecisionConfirmationDoc: HookDecisionConfirmationDoc = {
  title: "退出码 1 二次确认",
  description:
    "所有 command 动作统一使用此决策 JSON 约定。退出码 1 且 stdout 为普通文本时仍是软警告；退出码 1 且 stdout 为包含 decision.message 的有效 JSON 时会触发决策 UI。",
  body: '# 输出决策 JSON（exit 1 时，若 stdout 含 decision.message 则触发决策 UI）\necho \'{"decision":{"message":"是否继续执行当前操作？"}}\'\nexit 1',
  explanation:
    "命令的 stdout 必须只包含此格式的有效 JSON，不能混入其他非 JSON 文本。decision.message 会显示给用户，由用户批准或拒绝后再决定当前流程是否继续。",
};

const zhCNDocs: Record<string, HookDocContent> = {
  onUserMessage: {
    title: "onUserMessage",
    description:
      "用户发送新消息时触发，在消息转发给 AI 之前执行。" +
      "Hook 命令通过 stdin 接收完整的上下文 JSON。" +
      "退出码 0 时，stdout 作为 [Hook Context] 注入到发给 AI 的消息中（UI 不显示）。" +
      "退出码 1 时，警告文本作为 [Hook Warning] 注入。" +
      "退出码 2+ 时，AI 流程中断，向用户显示错误。",
    contextFields: [
      { name: "message", description: "用户输入的消息文本。" },
      { name: "cwd", description: "当前工作目录。同时作为命令的工作目录。" },
      { name: "sessionId", description: "会话 ID（首次消息创建会话前省略）。" },
    ],
    exitCodes: [
      {
        code: "0",
        meaning: "通过 — stdout 作为 [Hook Context] 注入到发给 AI 的消息中。",
      },
      {
        code: "1",
        meaning: "警告 — 警告文本作为 [Hook Warning] 注入，消息仍然发送。",
      },
      { code: "2+", meaning: "中止 — AI 流程中断，向用户显示错误。" },
    ],
    examples: [
      {
        title: "注入项目上下文",
        actionType: "command",
        body: "echo '本项目使用 TypeScript strict 模式，所有函数必须有显式返回类型。'",
        explanation:
          "退出码 0，stdout 文本作为 [Hook Context] 追加到用户消息中 — AI 能看到，但用户在 UI 上看不到。",
      },
      {
        title: "检测敏感关键词并警告",
        actionType: "command",
        body: "ctx=$(cat)\nmsg=$(echo \"$ctx\" | jq -r '.message')\nif echo \"$msg\" | grep -qi 'password\\|secret\\|api key'; then\n  echo '警告：你的消息可能包含敏感信息'\n  exit 1\nfi",
        explanation:
          "从 stdin 读取上下文，检查消息中是否包含敏感关键词。退出码 1 将警告作为 [Hook Warning] 注入。",
      },
      {
        title: "静态上下文（无需脚本）",
        actionType: "context",
        body: "始终使用 markdown 回复。代码块必须带语言标签。",
        explanation:
          "context 类型动作直接注入静态文本 — 不执行命令。适合全局系统指令。",
      },
    ],
  },
  beforeToolCall: {
    title: "beforeToolCall",
    description:
      "工具执行前触发。上下文包含工具名称和解析后的参数。" +
      "支持工具匹配器 — 仅在匹配器匹配工具名时运行。" +
      "退出码 0 时，stdout 可自动回答交互式工具（askUserQuestion）。" +
      "退出码 2+ 时，AI 流程完全中断。",
    contextFields: [
      {
        name: "toolName",
        description:
          "即将调用的工具名称（如 filesystem-read、bash-terminal-execute）。",
      },
      {
        name: "args",
        description:
          '解析后的工具参数（JSON 对象，如 {"path": "/src/main.ts"}）。',
      },
      { name: "cwd", description: "当前工作目录。同时作为命令的工作目录。" },
    ],
    exitCodes: [
      {
        code: "0",
        meaning:
          "通过 — stdout 可自动回答交互式工具。对普通工具 stdout 被忽略。",
      },
      { code: "1", meaning: "警告 — 收集警告并显示给用户，工具仍执行。" },
      { code: "2+", meaning: "中止 — AI 流程完全中断，工具不执行。" },
    ],
    examples: [
      {
        title: "阻止写入 .env 文件",
        actionType: "command",
        matcher: "filesystem-create,filesystem-edit,filesystem-replaceedit",
        body: "ctx=$(cat)\npath=$(echo \"$ctx\" | jq -r '.args.path // empty')\nif echo \"$path\" | grep -qi '\\.env$'; then\n  echo '已阻止：不允许写入 .env 文件'\n  exit 2\nfi",
        explanation:
          "匹配器限制此 hook 仅对文件系统写入工具生效。从 args 读取文件路径，用退出码 2 阻止写入 .env 文件。",
      },
      {
        title: "终端执行前警告",
        actionType: "command",
        matcher: "bash-terminal-execute",
        body: 'ctx=$(cat)\ncmd=$(echo "$ctx" | jq -r \'.args.command // empty\')\necho "即将执行: $cmd"\nexit 1',
        explanation:
          "匹配器仅对 bash-terminal-execute 触发。退出码 1 向用户警告即将执行的命令，工具仍会运行。",
      },
    ],
  },
  afterToolCall: {
    title: "afterToolCall",
    description:
      "工具调用完成后触发。上下文包含工具名称、参数和解析后的结果。" +
      "支持工具匹配器。" +
      "退出码 0 时，stdout 作为 [Hook Context] 追加到发给 AI 的工具结果中。" +
      "退出码 2+ 时，AI 流程完全中断。",
    contextFields: [
      { name: "toolName", description: "已调用的工具名称。" },
      { name: "args", description: "解析后的工具参数（JSON 对象）。" },
      {
        name: "result",
        description: "解析后的工具结果（JSON 对象，内容因工具而异）。",
      },
      { name: "cwd", description: "当前工作目录。同时作为命令的工作目录。" },
    ],
    exitCodes: [
      {
        code: "0",
        meaning: "通过 — stdout 作为 [Hook Context] 追加到工具结果。",
      },
      { code: "1", meaning: "警告 — 收集警告，工具结果不变。" },
      { code: "2+", meaning: "中止 — AI 流程完全中断。" },
    ],
    examples: [
      {
        title: "记录所有文件读取",
        actionType: "command",
        matcher: "filesystem-read",
        body: 'ctx=$(cat)\npath=$(echo "$ctx" | jq -r \'.args.path // empty\')\necho "[$(date -Iseconds)] 读取: $path" >> .snow/log/file-access.log',
        explanation:
          "将每次文件读取追加到日志文件。退出码 0 且 stdout 为空，因此工具结果不受影响。",
      },
      {
        title: "文件写入后提醒运行 linter",
        actionType: "command",
        matcher: "filesystem-create,filesystem-edit",
        body: "echo '文件已修改，请记得运行 linter 检查代码风格。'",
        explanation:
          "在任何文件写入工具之后，向 AI 注入提醒。AI 会将此视为追加到工具结果的 [Hook Context]。",
      },
    ],
  },
  toolConfirmation: {
    title: "toolConfirmation",
    description:
      "工具授权对话框显示给用户之前触发。" +
      "支持工具匹配器。" +
      "退出码 2+ 时，工具被自动拒绝，不显示对话框。" +
      "这让你可以在无需用户交互的情况下执行工具策略。",
    contextFields: [
      { name: "toolName", description: "请求授权的工具名称。" },
      { name: "args", description: "解析后的工具参数（JSON 对象）。" },
      { name: "cwd", description: "当前工作目录。同时作为命令的工作目录。" },
    ],
    exitCodes: [
      {
        code: "0",
        meaning: "通过 — 工具进入正常授权流程（YOLO 自动批准或对话框）。",
      },
      { code: "1", meaning: "警告 — 收集警告，正常授权流程继续。" },
      {
        code: "2+",
        meaning: "中止 — 工具被自动拒绝，返回 hook 错误消息。不显示对话框。",
      },
    ],
    examples: [
      {
        title: "自动拒绝 rm -rf /",
        actionType: "command",
        matcher: "bash-terminal-execute",
        body: "ctx=$(cat)\ncmd=$(echo \"$ctx\" | jq -r '.args.command // empty')\nif echo \"$cmd\" | grep -qE 'rm\\s+-rf\\s+/'; then\n  echo '已阻止：禁止对根目录执行 rm -rf'\n  exit 2\nfi",
        explanation:
          "检查终端命令中是否有危险的 rm -rf /。退出码 2 自动拒绝工具，不显示授权对话框。",
      },
    ],
  },
  onSubAgentComplete: {
    title: "onSubAgentComplete",
    description:
      "子代理完成任务后触发。上下文包含子代理的提示词和输出摘要。" +
      "退出码 0 时，stdout 作为 [Hook Context] 追加到返回给父 AI 的摘要中。" +
      "退出码 2+ 时，hook 错误消息替换摘要。",
    contextFields: [
      { name: "agentId", description: "子代理标识符。" },
      { name: "agentName", description: "子代理显示名称。" },
      { name: "prompt", description: "发送给子代理的提示词。" },
      { name: "summary", description: "子代理的输出摘要。" },
      { name: "parentConversationId", description: "父会话 ID。" },
      { name: "cwd", description: "当前工作目录。同时作为命令的工作目录。" },
    ],
    exitCodes: [
      { code: "0", meaning: "通过 — context 作为 [Hook Context] 追加到摘要。" },
      { code: "1", meaning: "警告 — 警告作为 [Hook Warning] 追加到摘要。" },
      { code: "2+", meaning: "中止 — hook 错误消息替换返回给父 AI 的摘要。" },
    ],
    examples: [
      {
        title: "记录子代理结果",
        actionType: "command",
        body: 'ctx=$(cat)\nagent=$(echo "$ctx" | jq -r \'.agentName // empty\')\nsummary=$(echo "$ctx" | jq -r \'.summary // empty\')\necho "[$(date -Iseconds)] 代理: $agent" >> .snow/log/subagent.log\necho "$summary" >> .snow/log/subagent.log',
        explanation:
          "将每次子代理完成记录到文件。退出码 0 且 stdout 为空，不注入额外 context。",
      },
    ],
  },
  beforeCompress: {
    title: "beforeCompress",
    description:
      "上下文压缩开始前触发。" +
      "退出码 2+ 时，压缩被中止，用户会看到 hook 的错误消息。" +
      "可用于在特定场景下阻止压缩。",
    contextFields: [
      { name: "conversationId", description: "正在压缩的会话 ID。" },
      {
        name: "isAuto",
        description:
          "是否由 token 阈值自动触发（true）或用户手动触发（false）。",
      },
      { name: "cwd", description: "当前工作目录。同时作为命令的工作目录。" },
    ],
    exitCodes: [
      { code: "0", meaning: "通过 — 压缩继续进行。" },
      { code: "1", meaning: "警告 — 收集警告，压缩继续。" },
      { code: "2+", meaning: "中止 — 压缩中止，返回 hook 错误消息。" },
    ],
    examples: [
      {
        title: "阻止自动压缩",
        actionType: "command",
        body: 'ctx=$(cat)\nis_auto=$(echo "$ctx" | jq -r \'.isAuto // false\')\nif [ "$is_auto" = "true" ]; then\n  echo \'已阻止自动压缩，请手动压缩。\'\n  exit 2\nfi',
        explanation:
          "仅允许手动压缩。自动压缩（由 token 阈值触发）被退出码 2 阻止。",
      },
    ],
  },
  onSessionStart: {
    title: "onSessionStart",
    description:
      "用户打开已有会话时触发（历史加载完成后）。" +
      "Fire-and-forget — 不会阻塞会话切换。" +
      "支持 context 类型动作注入静态信息。" +
      "Hook 输出记录用于审计，不影响会话。",
    contextFields: [
      { name: "conversationId", description: "打开的会话 ID。" },
      { name: "cwd", description: "当前工作目录。同时作为命令的工作目录。" },
      { name: "directoryId", description: "工作区目录 ID。" },
    ],
    exitCodes: [
      { code: "0", meaning: "通过 — hook 输出记录用于审计。" },
      { code: "1", meaning: "警告 — 警告已记录，会话切换不受影响。" },
      {
        code: "2+",
        meaning: "中止 — 错误已记录，会话切换仍继续（fire-and-forget）。",
      },
    ],
    examples: [
      {
        title: "记录会话打开事件",
        actionType: "command",
        body: 'echo "会话打开于 $(date -Iseconds)" >> .snow/log/sessions.log',
        explanation:
          "每次打开对话时记录日志。退出码 0 且 stdout 为空 — 不注入任何输出。",
      },
    ],
  },
  onStop: {
    title: "onStop",
    description:
      "AI 流程停止时触发 — 无论自然结束、用户中止、错误或被新消息替代。" +
      "Fire-and-forget。" +
      "上下文包含 'reason' 字段，指示停止原因。" +
      "Hook 输出记录用于审计，不影响清理流程。",
    contextFields: [
      {
        name: "conversationId",
        description: "停止的会话 ID（pending 会话未持久化时省略）。",
      },
      { name: "cwd", description: "当前工作目录。同时作为命令的工作目录。" },
      {
        name: "reason",
        description:
          '停止原因："completed"（自然结束）或 "aborted"（用户取消或错误）。',
      },
    ],
    exitCodes: [
      { code: "0", meaning: "通过 — hook 输出记录用于审计。" },
      { code: "1", meaning: "警告 — 警告已记录，清理不受影响。" },
      {
        code: "2+",
        meaning: "中止 — 错误已记录，清理仍继续（fire-and-forget）。",
      },
    ],
    examples: [
      {
        title: "记录停止事件",
        actionType: "command",
        body: 'ctx=$(cat)\nreason=$(echo "$ctx" | jq -r \'.reason // empty\')\necho "[$(date -Iseconds)] AI 流程停止: $reason" >> .snow/log/ai-stops.log',
        explanation:
          "记录每次 AI 流程停止及原因。可用于追踪用户取消频率与自然完成频率。",
      },
      {
        title: "停止时运行清理脚本",
        actionType: "command",
        body: "if [ -f .snow/scripts/on-stop.sh ]; then\n  bash .snow/scripts/on-stop.sh\nfi",
        explanation:
          "AI 流程停止时运行项目特定的清理脚本。可用于清理临时文件、停止开发服务器等。",
      },
    ],
  },
  beforeSubAgentStart: {
    title: "beforeSubAgentStart",
    description:
      "子代理会话创建前触发。" +
      "退出码 2+ 时，子代理激活立即中止。" +
      "可用于限制哪些子代理可以使用。",
    contextFields: [
      { name: "agentId", description: "子代理标识符。" },
      { name: "agentName", description: "子代理显示名称。" },
      { name: "prompt", description: "将发送给子代理的提示词。" },
      { name: "parentConversationId", description: "父会话 ID。" },
      { name: "cwd", description: "当前工作目录。同时作为命令的工作目录。" },
    ],
    exitCodes: [
      { code: "0", meaning: "通过 — 子代理激活继续。" },
      { code: "1", meaning: "警告 — 收集警告，激活继续。" },
      { code: "2+", meaning: "中止 — 子代理激活中止，返回 hook 错误消息。" },
    ],
    examples: [
      {
        title: "阻止特定子代理",
        actionType: "command",
        body: 'ctx=$(cat)\nagent_id=$(echo "$ctx" | jq -r \'.agentId // empty\')\nif [ "$agent_id" = "debug-agent" ]; then\n  echo \'debug 子代理在此项目中已禁用\'\n  exit 2\nfi',
        explanation: "按 ID 阻止特定子代理。退出码 2 在子代理启动前中止激活。",
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Traditional Chinese
// ---------------------------------------------------------------------------

const zhTWDecisionConfirmationDoc: HookDecisionConfirmationDoc = {
  title: "退出碼 1 二次確認",
  description:
    "所有 command 動作統一使用此決策 JSON 約定。退出碼 1 且 stdout 為一般文字時仍是軟警告；退出碼 1 且 stdout 為包含 decision.message 的有效 JSON 時會觸發決策 UI。",
  body: '# 輸出決策 JSON（exit 1 時，若 stdout 含 decision.message 則觸發決策 UI）\necho \'{"decision":{"message":"是否繼續執行目前操作？"}}\'\nexit 1',
  explanation:
    "命令的 stdout 必須只包含此格式的有效 JSON，不能混入其他非 JSON 文字。decision.message 會顯示給使用者，由使用者批准或拒絕後再決定目前流程是否繼續。",
};

const zhTWDocs: Record<string, HookDocContent> = {
  onUserMessage: {
    title: "onUserMessage",
    description:
      "使用者傳送新訊息時觸發，在訊息轉發給 AI 之前執行。" +
      "Hook 命令透過 stdin 接收完整的上下文 JSON。" +
      "退出碼 0 時，stdout 作為 [Hook Context] 注入到發給 AI 的訊息中（UI 不顯示）。" +
      "退出碼 1 時，警告文字作為 [Hook Warning] 注入。" +
      "退出碼 2+ 時，AI 流程中斷，向使用者顯示錯誤。",
    contextFields: [
      { name: "message", description: "使用者輸入的訊息文字。" },
      { name: "cwd", description: "目前工作目錄。同時作為命令的工作目錄。" },
      {
        name: "sessionId",
        description: "工作階段 ID（首次訊息建立工作階段前省略）。",
      },
    ],
    exitCodes: [
      {
        code: "0",
        meaning: "通過 — stdout 作為 [Hook Context] 注入到發給 AI 的訊息中。",
      },
      {
        code: "1",
        meaning: "警告 — 警告文字作為 [Hook Warning] 注入，訊息仍然傳送。",
      },
      { code: "2+", meaning: "中止 — AI 流程中斷，向使用者顯示錯誤。" },
    ],
    examples: [
      {
        title: "注入專案上下文",
        actionType: "command",
        body: "echo '本專案使用 TypeScript strict 模式，所有函式必須有顯式返回型別。'",
        explanation:
          "退出碼 0，stdout 文字作為 [Hook Context] 附加到使用者訊息中 — AI 看得到，但使用者在 UI 上看不到。",
      },
      {
        title: "偵測敏感關鍵字並警告",
        actionType: "command",
        body: "ctx=$(cat)\nmsg=$(echo \"$ctx\" | jq -r '.message')\nif echo \"$msg\" | grep -qi 'password\\|secret\\|api key'; then\n  echo '警告：你的訊息可能包含敏感資訊'\n  exit 1\nfi",
        explanation:
          "從 stdin 讀取上下文，檢查訊息中是否包含敏感關鍵字。退出碼 1 將警告作為 [Hook Warning] 注入。",
      },
      {
        title: "靜態上下文（無需腳本）",
        actionType: "context",
        body: "始終使用 markdown 回覆。程式碼區塊必須帶語言標籤。",
        explanation:
          "context 類型動作直接注入靜態文字 — 不執行命令。適合全域系統指令。",
      },
    ],
  },
  beforeToolCall: {
    title: "beforeToolCall",
    description:
      "工具執行前觸發。上下文包含工具名稱和解析後的參數。" +
      "支援工具匹配器 — 僅在匹配器匹配工具名時執行。" +
      "退出碼 0 時，stdout 可自動回答互動式工具（askUserQuestion）。" +
      "退出碼 2+ 時，AI 流程完全中斷。",
    contextFields: [
      {
        name: "toolName",
        description:
          "即將呼叫的工具名稱（如 filesystem-read、bash-terminal-execute）。",
      },
      {
        name: "args",
        description:
          '解析後的工具參數（JSON 物件，如 {"path": "/src/main.ts"}）。',
      },
      { name: "cwd", description: "目前工作目錄。同時作為命令的工作目錄。" },
    ],
    exitCodes: [
      {
        code: "0",
        meaning:
          "通過 — stdout 可自動回答互動式工具。對普通工具 stdout 被忽略。",
      },
      { code: "1", meaning: "警告 — 收集警告並顯示給使用者，工具仍執行。" },
      { code: "2+", meaning: "中止 — AI 流程完全中斷，工具不執行。" },
    ],
    examples: [
      {
        title: "阻止寫入 .env 檔案",
        actionType: "command",
        matcher: "filesystem-create,filesystem-edit,filesystem-replaceedit",
        body: "ctx=$(cat)\npath=$(echo \"$ctx\" | jq -r '.args.path // empty')\nif echo \"$path\" | grep -qi '\\.env$'; then\n  echo '已阻止：不允許寫入 .env 檔案'\n  exit 2\nfi",
        explanation:
          "匹配器限制此 hook 僅對檔案系統寫入工具生效。從 args 讀取檔案路徑，用退出碼 2 阻止寫入 .env 檔案。",
      },
      {
        title: "終端執行前警告",
        actionType: "command",
        matcher: "bash-terminal-execute",
        body: 'ctx=$(cat)\ncmd=$(echo "$ctx" | jq -r \'.args.command // empty\')\necho "即將執行: $cmd"\nexit 1',
        explanation:
          "匹配器僅對 bash-terminal-execute 觸發。退出碼 1 向使用者警告即將執行的命令，工具仍會執行。",
      },
    ],
  },
  afterToolCall: {
    title: "afterToolCall",
    description:
      "工具呼叫完成後觸發。上下文包含工具名稱、參數和解析後的結果。" +
      "支援工具匹配器。" +
      "退出碼 0 時，stdout 作為 [Hook Context] 附加到發給 AI 的工具結果中。" +
      "退出碼 2+ 時，AI 流程完全中斷。",
    contextFields: [
      { name: "toolName", description: "已呼叫的工具名稱。" },
      { name: "args", description: "解析後的工具參數（JSON 物件）。" },
      {
        name: "result",
        description: "解析後的工具結果（JSON 物件，內容因工具而異）。",
      },
      { name: "cwd", description: "目前工作目錄。同時作為命令的工作目錄。" },
    ],
    exitCodes: [
      {
        code: "0",
        meaning: "通過 — stdout 作為 [Hook Context] 附加到工具結果。",
      },
      { code: "1", meaning: "警告 — 收集警告，工具結果不變。" },
      { code: "2+", meaning: "中止 — AI 流程完全中斷。" },
    ],
    examples: [
      {
        title: "記錄所有檔案讀取",
        actionType: "command",
        matcher: "filesystem-read",
        body: 'ctx=$(cat)\npath=$(echo "$ctx" | jq -r \'.args.path // empty\')\necho "[$(date -Iseconds)] 讀取: $path" >> .snow/log/file-access.log',
        explanation:
          "將每次檔案讀取附加到日誌檔案。退出碼 0 且 stdout 為空，因此工具結果不受影響。",
      },
      {
        title: "檔案寫入後提醒執行 linter",
        actionType: "command",
        matcher: "filesystem-create,filesystem-edit",
        body: "echo '檔案已修改，請記得執行 linter 檢查程式碼風格。'",
        explanation:
          "在任何檔案寫入工具之後，向 AI 注入提醒。AI 會將此視為附加到工具結果的 [Hook Context]。",
      },
    ],
  },
  toolConfirmation: {
    title: "toolConfirmation",
    description:
      "工具授權對話框顯示給使用者之前觸發。" +
      "支援工具匹配器。" +
      "退出碼 2+ 時，工具被自動拒絕，不顯示對話框。" +
      "這讓你可以在無需使用者互動的情況下執行工具策略。",
    contextFields: [
      { name: "toolName", description: "請求授權的工具名稱。" },
      { name: "args", description: "解析後的工具參數（JSON 物件）。" },
      { name: "cwd", description: "目前工作目錄。同時作為命令的工作目錄。" },
    ],
    exitCodes: [
      {
        code: "0",
        meaning: "通過 — 工具進入正常授權流程（YOLO 自動批准或對話框）。",
      },
      { code: "1", meaning: "警告 — 收集警告，正常授權流程繼續。" },
      {
        code: "2+",
        meaning: "中止 — 工具被自動拒絕，返回 hook 錯誤訊息。不顯示對話框。",
      },
    ],
    examples: [
      {
        title: "自動拒絕 rm -rf /",
        actionType: "command",
        matcher: "bash-terminal-execute",
        body: "ctx=$(cat)\ncmd=$(echo \"$ctx\" | jq -r '.args.command // empty')\nif echo \"$cmd\" | grep -qE 'rm\\s+-rf\\s+/'; then\n  echo '已阻止：禁止對根目錄執行 rm -rf'\n  exit 2\nfi",
        explanation:
          "檢查終端命令中是否有危險的 rm -rf /。退出碼 2 自動拒絕工具，不顯示授權對話框。",
      },
    ],
  },
  onSubAgentComplete: {
    title: "onSubAgentComplete",
    description:
      "子代理完成任務後觸發。上下文包含子代理的提示詞和輸出摘要。" +
      "退出碼 0 時，stdout 作為 [Hook Context] 附加到返回給父 AI 的摘要中。" +
      "退出碼 2+ 時，hook 錯誤訊息替換摘要。",
    contextFields: [
      { name: "agentId", description: "子代理識別符。" },
      { name: "agentName", description: "子代理顯示名稱。" },
      { name: "prompt", description: "傳送給子代理的提示詞。" },
      { name: "summary", description: "子代理的輸出摘要。" },
      { name: "parentConversationId", description: "父工作階段 ID。" },
      { name: "cwd", description: "目前工作目錄。同時作為命令的工作目錄。" },
    ],
    exitCodes: [
      { code: "0", meaning: "通過 — context 作為 [Hook Context] 附加到摘要。" },
      { code: "1", meaning: "警告 — 警告作為 [Hook Warning] 附加到摘要。" },
      { code: "2+", meaning: "中止 — hook 錯誤訊息替換返回給父 AI 的摘要。" },
    ],
    examples: [
      {
        title: "記錄子代理結果",
        actionType: "command",
        body: 'ctx=$(cat)\nagent=$(echo "$ctx" | jq -r \'.agentName // empty\')\nsummary=$(echo "$ctx" | jq -r \'.summary // empty\')\necho "[$(date -Iseconds)] 代理: $agent" >> .snow/log/subagent.log\necho "$summary" >> .snow/log/subagent.log',
        explanation:
          "將每次子代理完成記錄到檔案。退出碼 0 且 stdout 為空，不注入額外 context。",
      },
    ],
  },
  beforeCompress: {
    title: "beforeCompress",
    description:
      "上下文壓縮開始前觸發。" +
      "退出碼 2+ 時，壓縮被中止，使用者會看到 hook 的錯誤訊息。" +
      "可用於在特定情境下阻止壓縮。",
    contextFields: [
      { name: "conversationId", description: "正在壓縮的工作階段 ID。" },
      {
        name: "isAuto",
        description:
          "是否由 token 閾值自動觸發（true）或使用者手動觸發（false）。",
      },
      { name: "cwd", description: "目前工作目錄。同時作為命令的工作目錄。" },
    ],
    exitCodes: [
      { code: "0", meaning: "通過 — 壓縮繼續進行。" },
      { code: "1", meaning: "警告 — 收集警告，壓縮繼續。" },
      { code: "2+", meaning: "中止 — 壓縮中止，返回 hook 錯誤訊息。" },
    ],
    examples: [
      {
        title: "阻止自動壓縮",
        actionType: "command",
        body: 'ctx=$(cat)\nis_auto=$(echo "$ctx" | jq -r \'.isAuto // false\')\nif [ "$is_auto" = "true" ]; then\n  echo \'已阻止自動壓縮，請手動壓縮。\'\n  exit 2\nfi',
        explanation:
          "僅允許手動壓縮。自動壓縮（由 token 閾值觸發）被退出碼 2 阻止。",
      },
    ],
  },
  onSessionStart: {
    title: "onSessionStart",
    description:
      "使用者開啟已有工作階段時觸發（歷史載入完成後）。" +
      "Fire-and-forget — 不會阻塞工作階段切換。" +
      "支援 context 類型動作注入靜態資訊。" +
      "Hook 輸出記錄用於稽核，不影響工作階段。",
    contextFields: [
      { name: "conversationId", description: "開啟的工作階段 ID。" },
      { name: "cwd", description: "目前工作目錄。同時作為命令的工作目錄。" },
      { name: "directoryId", description: "工作區目錄 ID。" },
    ],
    exitCodes: [
      { code: "0", meaning: "通過 — hook 輸出記錄用於稽核。" },
      { code: "1", meaning: "警告 — 警告已記錄，工作階段切換不受影響。" },
      {
        code: "2+",
        meaning: "中止 — 錯誤已記錄，工作階段切換仍繼續（fire-and-forget）。",
      },
    ],
    examples: [
      {
        title: "記錄工作階段開啟事件",
        actionType: "command",
        body: 'echo "工作階段開啟於 $(date -Iseconds)" >> .snow/log/sessions.log',
        explanation:
          "每次開啟對話時記錄日誌。退出碼 0 且 stdout 為空 — 不注入任何輸出。",
      },
    ],
  },
  onStop: {
    title: "onStop",
    description:
      "AI 流程停止時觸發 — 無論自然結束、使用者中止、錯誤或被新訊息替代。" +
      "Fire-and-forget。" +
      "上下文包含 'reason' 欄位，指示停止原因。" +
      "Hook 輸出記錄用於稽核，不影響清理流程。",
    contextFields: [
      {
        name: "conversationId",
        description: "停止的工作階段 ID（pending 工作階段未持久化時省略）。",
      },
      { name: "cwd", description: "目前工作目錄。同時作為命令的工作目錄。" },
      {
        name: "reason",
        description:
          '停止原因："completed"（自然結束）或 "aborted"（使用者取消或錯誤）。',
      },
    ],
    exitCodes: [
      { code: "0", meaning: "通過 — hook 輸出記錄用於稽核。" },
      { code: "1", meaning: "警告 — 警告已記錄，清理不受影響。" },
      {
        code: "2+",
        meaning: "中止 — 錯誤已記錄，清理仍繼續（fire-and-forget）。",
      },
    ],
    examples: [
      {
        title: "記錄停止事件",
        actionType: "command",
        body: 'ctx=$(cat)\nreason=$(echo "$ctx" | jq -r \'.reason // empty\')\necho "[$(date -Iseconds)] AI 流程停止: $reason" >> .snow/log/ai-stops.log',
        explanation:
          "記錄每次 AI 流程停止及原因。可用於追蹤使用者取消頻率與自然完成頻率。",
      },
      {
        title: "停止時執行清理腳本",
        actionType: "command",
        body: "if [ -f .snow/scripts/on-stop.sh ]; then\n  bash .snow/scripts/on-stop.sh\nfi",
        explanation:
          "AI 流程停止時執行專案特定的清理腳本。可用於清理暫存檔案、停止開發伺服器等。",
      },
    ],
  },
  beforeSubAgentStart: {
    title: "beforeSubAgentStart",
    description:
      "子代理工作階段建立前觸發。" +
      "退出碼 2+ 時，子代理啟用立即中止。" +
      "可用於限制哪些子代理可以使用。",
    contextFields: [
      { name: "agentId", description: "子代理識別符。" },
      { name: "agentName", description: "子代理顯示名稱。" },
      { name: "prompt", description: "將傳送給子代理的提示詞。" },
      { name: "parentConversationId", description: "父工作階段 ID。" },
      { name: "cwd", description: "目前工作目錄。同時作為命令的工作目錄。" },
    ],
    exitCodes: [
      { code: "0", meaning: "通過 — 子代理啟用繼續。" },
      { code: "1", meaning: "警告 — 收集警告，啟用繼續。" },
      { code: "2+", meaning: "中止 — 子代理啟用中止，返回 hook 錯誤訊息。" },
    ],
    examples: [
      {
        title: "阻止特定子代理",
        actionType: "command",
        body: 'ctx=$(cat)\nagent_id=$(echo "$ctx" | jq -r \'.agentId // empty\')\nif [ "$agent_id" = "debug-agent" ]; then\n  echo \'debug 子代理在此專案中已停用\'\n  exit 2\nfi',
        explanation: "按 ID 阻止特定子代理。退出碼 2 在子代理啟動前中止啟用。",
      },
    ],
  },
};

const localeMap: Record<Locale, Record<string, HookDocContent>> = {
  en: enDocs,
  "zh-CN": zhCNDocs,
  "zh-TW": zhTWDocs,
};

const decisionConfirmationLocaleMap: Record<
  Locale,
  HookDecisionConfirmationDoc
> = {
  en: enDecisionConfirmationDoc,
  "zh-CN": zhCNDecisionConfirmationDoc,
  "zh-TW": zhTWDecisionConfirmationDoc,
};

/** Get the unified exit-1 decision confirmation documentation. */
export const getHookDecisionConfirmationDoc = (
  locale: Locale,
): HookDecisionConfirmationDoc => {
  return decisionConfirmationLocaleMap[locale] ?? enDecisionConfirmationDoc;
};

export const getHookDocs = (
  locale: Locale,
  hookType: string,
): HookDocContent | null => {
  return localeMap[locale]?.[hookType] ?? enDocs[hookType] ?? null;
};

export const getAllHookDocs = (
  locale: Locale,
): Record<string, HookDocContent> => {
  return localeMap[locale] ?? enDocs;
};
