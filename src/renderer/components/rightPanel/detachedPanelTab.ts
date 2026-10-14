import type { DetachedPanelTabPayload } from "../../../shared/detachedPanel";
import type { BrowserTabData, RightPanelTab, TerminalTabData } from "./types";
import { executeTerminalMcpCommand } from "./terminal/terminalMcpController";
import { getBrowserAgentAccess } from "./browser/browserAgentAccess";

/**
 * 独立面板窗口的 tab 快照：RightPanel 与独立窗口入口共用。
 * tab.data 必须可 JSON 序列化（经主进程暂存与 IPC 传递）。
 */

/** 主进程下发的 tab 快照还原为面板 tab（type 与 data 由发起方保证同构）。 */
export const toRightPanelTab = (
  payload: DetachedPanelTabPayload,
): RightPanelTab => ({
  id: payload.id,
  type: payload.type as RightPanelTab["type"],
  title: payload.title,
  data: payload.data as RightPanelTab["data"],
});

/** 读取终端屏幕 + 回滚缓冲的纯文本（终端未就绪时返回空串）。 */
const readTerminalSnapshot = async (tabId: string): Promise<string> => {
  try {
    const result = JSON.parse(
      await executeTerminalMcpCommand("read", JSON.stringify({ tabId })),
    ) as { text?: unknown };
    return typeof result.text === "string" ? result.text : "";
  } catch {
    return "";
  }
};

/**
 * 构建 tab 的迁移快照。终端额外携带 PTY id（接管已有会话）与屏幕快照，
 * 使迁移后仍保留运行中的进程与输出历史。
 */
export const toDetachedTabPayload = async (
  tab: RightPanelTab,
  ptyId: string | undefined,
): Promise<DetachedPanelTabPayload> => {
  if (tab.type === "browser") {
    // Agent 授权的运行时状态存于渲染进程注册表，迁移时以当前值为准。
    const browserData = tab.data as BrowserTabData | undefined;
    const data: BrowserTabData | undefined = browserData
      ? {
          ...browserData,
          agentAccess: getBrowserAgentAccess(tab.id) ?? browserData.agentAccess,
        }
      : undefined;
    return { id: tab.id, type: tab.type, title: tab.title, data };
  }
  if (tab.type !== "terminal") {
    return { id: tab.id, type: tab.type, title: tab.title, data: tab.data };
  }
  const terminalData = tab.data as TerminalTabData | undefined;
  const data: TerminalTabData = {
    ...(terminalData ?? { cwd: "" }),
    ptyId,
    snapshot: await readTerminalSnapshot(tab.id),
  };
  return { id: tab.id, type: tab.type, title: tab.title, data };
};
