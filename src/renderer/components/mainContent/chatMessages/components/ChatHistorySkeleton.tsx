import { memo } from "react";

/**
 * 历史消息加载骨架屏。
 *
 * 两个使用方共用同一份结构与节奏，避免各自维护一套会走样的占位视觉：
 *  - ChatContent 的首屏历史分页加载（.chat-area 内联）；
 *  - UserMessageRail 的用户消息定位遮罩（目标还在未加载分页里时，
 *    翻页期间盖在滚动容器位置上）。
 * 宽度依赖 .chat-area 的 --chat-content-max 梯度：使用方需保证该变量可解析
 * （遮罩以 .user-message-locate-overlay 与 .chat-area 共用变量声明）。
 */
export const ChatHistorySkeleton = memo(
  (): React.JSX.Element => (
    <div className="chat-initial-history-skeleton" aria-hidden="true">
      {Array.from({ length: 3 }, (_, index) => (
        <div
          className={`chat-message-skeleton ${
            index === 1 ? "is-user" : "is-assistant"
          }`}
          key={index}
        >
          <div className="chat-message-skeleton-line is-primary" />
          <div className="chat-message-skeleton-line is-secondary" />
          {index === 0 ? (
            <div className="chat-message-skeleton-line is-tertiary" />
          ) : null}
        </div>
      ))}
    </div>
  ),
);

ChatHistorySkeleton.displayName = "ChatHistorySkeleton";
