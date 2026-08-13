import type { ToolCallInfo } from "../utils/conversationTypes";
import type { HookExecutionRecord } from "../utils/conversationTypes";
import { SubAgentToolCall } from "./SubAgentToolCall";

type SubAgentContinueToolCallProps = {
  toolCall: ToolCallInfo;
  /** Hook execution records bound to this tool call (matched by
   *  toolCallInteractionId). Forwarded to the shared SubAgentToolCall card. */
  hookExecutions?: HookExecutionRecord[];
};

/** sub-agents-continue 专用渲染：继续一个已结束/运行中的子代理。
 *  重新激活与新激活没有本质区别——都是收集子代理的运行结果，因此直接
 *  复用 SubAgentToolCall 的完整展示（活动列表、进度、摘要、跳转），
 *  仅切换为 continue 模式（按目标 conversationId 匹配事件、展示消息
 *  内容与排队结果）。 */
export const SubAgentContinueToolCall = ({
  toolCall,
  hookExecutions,
}: SubAgentContinueToolCallProps): React.JSX.Element => (
  <SubAgentToolCall toolCall={toolCall} hookExecutions={hookExecutions} mode="continue" />
);
