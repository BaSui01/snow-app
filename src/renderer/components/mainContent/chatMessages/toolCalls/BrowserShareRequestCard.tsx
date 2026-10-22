import { Bot, Check, CircleX, Globe, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../../../i18n";
import {
  listPendingBrowserAgentShareRequests,
  resolveBrowserAgentShareRequest,
  subscribeBrowserAgentAccess,
  type BrowserAgentShareRequest,
} from "../../../rightPanel/browser/browserAgentAccess";
import { BrowserToolCall } from "./BrowserToolCall";
import { ToolNameBadge } from "./shared/ToolNameBadge";
import type { ToolCallInfo } from "../utils/conversationTypes";
import "./BrowserShareRequestCard.css";

type BrowserShareRequestCardProps = {
  toolCall: ToolCallInfo;
};

/** 读取调用参数里的 instanceId（缺省 / "current" 表示当前聚焦的标签页）。 */
const parseInstanceIdArg = (argumentsJson: string): string => {
  try {
    const parsed = JSON.parse(argumentsJson) as { instanceId?: unknown };
    return typeof parsed.instanceId === "string"
      ? parsed.instanceId.trim()
      : "";
  } catch {
    return "";
  }
};

/**
 * 共享申请卡片：browser-request_share 等待用户授权期间，在消息流内直接给出
 * 允许 / 拒绝入口（浏览器面板不再另设横幅，避免用户错过申请）。
 *
 * 申请与工具调用的绑定：参数显式指定 instanceId 时按实例精确匹配；参数缺省
 * 时 bridge 会落到当前聚焦实例，且同一时刻最多只会有一个缺省参数的挂起申请，
 * 故退化为「唯一的挂起申请」。匹配不到（申请已结算 / 已超时 / 已在别处授权）
 * 时交回常规浏览器卡片渲染结果，交互逻辑只有一份。
 */
export const BrowserShareRequestCard = ({
  toolCall,
}: BrowserShareRequestCardProps): React.JSX.Element => {
  const { t } = useI18n();
  const [pendingRequests, setPendingRequests] = useState<
    BrowserAgentShareRequest[]
  >(() => listPendingBrowserAgentShareRequests());

  useEffect(() => {
    const sync = (): void => {
      setPendingRequests(listPendingBrowserAgentShareRequests());
    };
    sync();
    return subscribeBrowserAgentAccess(sync);
  }, []);

  const request = useMemo<BrowserAgentShareRequest | null>(() => {
    if (pendingRequests.length === 0) {
      return null;
    }
    const requested = parseInstanceIdArg(toolCall.arguments);
    if (requested && requested.toLowerCase() !== "current") {
      return (
        pendingRequests.find((item) => item.instanceId === requested) ?? null
      );
    }
    return pendingRequests.length === 1 ? pendingRequests[0] : null;
  }, [pendingRequests, toolCall.arguments]);

  const decide = useCallback(
    (granted: boolean): void => {
      if (request) {
        resolveBrowserAgentShareRequest(request.instanceId, granted);
      }
    },
    [request],
  );

  if (!request) {
    return <BrowserToolCall toolCall={toolCall} />;
  }

  return (
    <div className="tool-call-item tool-call-browser-share-request">
      <div className="tool-call-header">
        <ToolNameBadge
          name={t("toolNames.browser-request_share", {
            defaultValue: "Request tab share",
          })}
          category="web"
        />
        <Loader2
          className="tool-call-icon-spinning"
          size={14}
          aria-hidden="true"
        />
        <span className="tool-call-name">
          {t("browser.agentShareRequest", {
            defaultValue: "The agent is asking to share this tab",
          })}
        </span>
        <span
          className="tool-call-status tool-call-status-running"
          role="status"
          aria-live="polite"
        >
          {t("toolCall.browser.running.request_share", {
            defaultValue: "Requesting tab share...",
          })}
        </span>
      </div>

      <div className="tool-call-body tool-call-browser-share-request-body">
        <div className="tool-call-browser-share-request-heading">
          <Bot size={18} aria-hidden="true" />
          <div>
            <strong>
              {t("browser.agentShareRequest", {
                defaultValue: "The agent is asking to share this tab",
              })}
            </strong>
            <p>
              {t("browser.agentShareRequestDesc", {
                defaultValue:
                  "Allowing lets the agent read and operate this tab (including your signed-in session); denying returns an unauthorized result for this call.",
              })}
            </p>
          </div>
        </div>

        <div
          className="tool-call-browser-share-request-host"
          title={request.url || request.instanceId}
        >
          <Globe size={12} aria-hidden="true" />
          <span>{request.url || request.instanceId}</span>
        </div>

        <div className="tool-call-browser-share-request-footer">
          <span>
            {t("toolCall.browser.running.request_share", {
              defaultValue: "Requesting tab share...",
            })}
          </span>
          <div className="tool-call-browser-share-request-actions">
            <button
              type="button"
              className="tool-call-browser-share-request-deny"
              onClick={() => decide(false)}
            >
              <CircleX size={14} aria-hidden="true" />
              <span>
                {t("browser.agentShareDeny", { defaultValue: "Deny" })}
              </span>
            </button>
            <button
              type="button"
              className="tool-call-browser-share-request-approve"
              onClick={() => decide(true)}
            >
              <Check size={14} aria-hidden="true" />
              <span>
                {t("browser.agentShareApprove", { defaultValue: "Allow" })}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

BrowserShareRequestCard.displayName = "BrowserShareRequestCard";
