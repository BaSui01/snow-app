import type {
  McpServerConfigRecord,
  McpToolDefinition,
  ProjectMcpServerConfigRecord,
} from "../../../../preload";

export type McpServerConfig = McpServerConfigRecord;
export type ProjectMcpServerConfig = ProjectMcpServerConfigRecord;
export type McpServerConfigLike = Omit<McpServerConfig, "id">;
/**
 * `globalEnabled` 仅项目作用域的工具携带：为 false 表示已在全局禁用，
 * 项目层开关无法覆盖（全局作用域工具不含该字段）。
 */
export type McpServerTool = McpToolDefinition & {
  enabled: boolean;
  globalEnabled?: boolean;
};

export type McpKeyValuePair = {
  id: string;
  key: string;
  value: string;
};

export type McpStringItem = {
  id: string;
  value: string;
};

export type McpServerDraft = {
  serverId: string;
  name: string;
  transportType: string;
  url: string;
  command: string;
  args: McpStringItem[];
  env: McpKeyValuePair[];
  headers: McpKeyValuePair[];
  enabled: boolean;
  timeoutMs: string;
  sortOrder: number;
  source: string;
};
