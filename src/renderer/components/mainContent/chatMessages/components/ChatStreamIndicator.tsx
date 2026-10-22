import { Loader2 } from "lucide-react";
import { memo } from "react";
import { useI18n } from "../../../../i18n";
import { StreamCursor } from "./StreamCursor";

type ChatStreamIndicatorProps = {
  /** 会话级 run 是否进行中：整轮（含工具执行）期间指示槽保持展开。 */
  active: boolean;
  /** 正在停止：槽内改为「停止中」提示。 */
  isAborting: boolean;
  /** 最后一条回复正在重试：重试提示卡已在消息内承载，槽内留空。 */
  isRetrying: boolean;
};

/**
 * 会话级流式指示槽：固定在消息区末尾、平滑增长视口之外。
 *
 * 旧实现把指示器挂在每条 assistant 消息内部：一轮响应结束转入工具执行时
 * 指示器随消息定稿消失，下一轮新消息挂载时又重新出现，高度一减一增，
 * 视口随之跳动。现在整轮 run 只有这一个常驻槽位，高度恒定；内容区的
 * 一切增长都发生在它上方的平滑视口内，槽位自身永远钉在可视底部不动。
 * run 开始 / 结束时槽位以高度过渡展开 / 收起，同样不产生跳变。
 */
export const ChatStreamIndicator = memo(
  ({
    active,
    isAborting,
    isRetrying,
  }: ChatStreamIndicatorProps): React.JSX.Element => {
    const { t } = useI18n();
    return (
      <div
        className={`chat-stream-indicator${active ? " is-active" : ""}`}
        aria-hidden={!active}
      >
        <div className="chat-stream-indicator-inner">
          <div className="chat-stream-indicator-slot">
            {!active ? null : isAborting ? (
              <span className="stream-stopping">
                <Loader2 size={12} className="spin" />
                <span>
                  {t("chat.stopping", { defaultValue: "Stopping..." })}
                </span>
              </span>
            ) : isRetrying ? null : (
              <StreamCursor />
            )}
          </div>
        </div>
      </div>
    );
  },
);

ChatStreamIndicator.displayName = "ChatStreamIndicator";
