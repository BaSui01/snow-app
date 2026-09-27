export const MCP_SERVER_STATE_CHANGED_EVENT = "mcp-server-state:changed";

export const notifyMcpServerStateChanged = (): void => {
  window.dispatchEvent(new Event(MCP_SERVER_STATE_CHANGED_EVENT));
};
