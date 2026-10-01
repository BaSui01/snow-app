import { memo } from "react";
import type { ToolCallInfo } from "../utils/conversationTypes";
import type { HookExecutionRecord } from "../utils/conversationTypes";
import {
  AskUserQuestionToolCall,
  PlanModeApprovalToolCall,
  BashToolCall,
  FilesystemReadToolCall,
  FilesystemEditToolCall,
  FilesystemCreateToolCall,
  FilesystemCopyToolCall,
  TodoToolCall,
  GrepToolCall,
  SubAgentToolCall,
  SubAgentContinueToolCall,
  SubAgentListToolCall,
  CodebaseToolCall,
  CodeLensToolCall,
  LspToolCall,
  WebSearchToolCall,
  ImageGenToolCall,
  ImageDescribeToolCall,
  BrowserToolCall,
  TerminalToolCall,
  ComputerUseToolCall,
  SkillToolCall,
  ConfigToolCall,
  AppLogsToolCall,
  AppControlToolCall,
  DbxToolCall,
  MemoryToolCall,
  WorkflowToolCall,
  GenericToolCall,
} from "../toolCalls";

type ToolCallItemProps = {
  toolCall: ToolCallInfo;
  /** Conversation this tool call belongs to (used by workflow renderer). */
  conversationId?: string;
  /** Hook execution records bound to this tool call (matched by
   *  toolCallInteractionId).  Forwarded to the sub-agent card renderer;
   *  other tool renderers ignore it. */
  hookExecutions?: HookExecutionRecord[];
};

export const ToolCallItem = memo(
  ({
    toolCall,
    conversationId,
    hookExecutions,
  }: ToolCallItemProps): React.JSX.Element => {
    // Delegate to specialized renderers based on tool name
    if (toolCall.name === "user-interaction-askUserQuestion") {
      return <AskUserQuestionToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "app-control-requestApproval") {
      return <PlanModeApprovalToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "workflow-workflow-generate") {
      return (
        <WorkflowToolCall toolCall={toolCall} conversationId={conversationId} />
      );
    }

    // 失败节点续跑卡片：与 generate 卡片同一组件（复用画布渲染与事件
    // 订阅），mode=resume 下只读展示续跑节点状态；两卡片按事件来源做
    // 画布宿主切换（续跑进行中上方 generate 卡片画布收起）。
    if (toolCall.name === "workflow-workflow-resume") {
      return (
        <WorkflowToolCall
          toolCall={toolCall}
          conversationId={conversationId}
          mode="resume"
        />
      );
    }

    if (toolCall.name === "filesystem-read") {
      return <FilesystemReadToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "filesystem-replace_edit") {
      return <FilesystemEditToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "filesystem-create") {
      return <FilesystemCreateToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "filesystem-copy") {
      return <FilesystemCopyToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "bash-terminal-execute") {
      return <BashToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "todo-todo-manage") {
      return <TodoToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "grep-search") {
      return <GrepToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "sub-agents-activate") {
      return (
        <SubAgentToolCall toolCall={toolCall} hookExecutions={hookExecutions} />
      );
    }

    if (toolCall.name === "sub-agents-continue") {
      return (
        <SubAgentContinueToolCall
          toolCall={toolCall}
          hookExecutions={hookExecutions}
        />
      );
    }

    if (toolCall.name === "sub-agents-listSubAgents") {
      return <SubAgentListToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "codebase-search") {
      return <CodebaseToolCall toolCall={toolCall} />;
    }

    if (
      toolCall.name === "codelens-find_definition" ||
      toolCall.name === "codelens-find_references" ||
      toolCall.name === "codelens-file_outline"
    ) {
      return <CodeLensToolCall toolCall={toolCall} />;
    }

    if (toolCall.name.startsWith("lsp-")) {
      return <LspToolCall toolCall={toolCall} />;
    }

    if (
      toolCall.name === "websearch-websearch-search" ||
      toolCall.name === "websearch-websearch-fetch"
    ) {
      return <WebSearchToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "imagegen-generate") {
      return <ImageGenToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "imagegen-image-describe") {
      return <ImageDescribeToolCall toolCall={toolCall} />;
    }

    if (toolCall.name.startsWith("browser-")) {
      return <BrowserToolCall toolCall={toolCall} />;
    }

    if (toolCall.name.startsWith("terminal-")) {
      return <TerminalToolCall toolCall={toolCall} />;
    }

    if (toolCall.name.startsWith("computer-use-")) {
      return <ComputerUseToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "skills-skill-execute") {
      return <SkillToolCall toolCall={toolCall} />;
    }

    if (toolCall.name === "config-logs-read") {
      return <AppLogsToolCall toolCall={toolCall} />;
    }

    if (toolCall.name.startsWith("config-")) {
      return <ConfigToolCall toolCall={toolCall} />;
    }

    if (toolCall.name.startsWith("app-control-")) {
      return <AppControlToolCall toolCall={toolCall} />;
    }

    if (toolCall.name.startsWith("dbx-") || toolCall.name.startsWith("dbx_")) {
      // 外部 MCP（DBX 桌面数据库应用）统一渲染，见 DbxToolCall 头部注释。
      // 注意：外部 MCP 工具名可能被规范化为下划线风格（dbx_execute_query），
      // 因此同时兼容连字符与下划线两种前缀。
      return <DbxToolCall toolCall={toolCall} />;
    }

    if (toolCall.name.startsWith("memory-")) {
      return <MemoryToolCall toolCall={toolCall} />;
    }

    // 外部 MCP 工具与未被专用卡片捕获的工具，统一采用现代化增强型 GenericToolCall 渲染
    return <GenericToolCall toolCall={toolCall} />;
  },
);

ToolCallItem.displayName = "ToolCallItem";
