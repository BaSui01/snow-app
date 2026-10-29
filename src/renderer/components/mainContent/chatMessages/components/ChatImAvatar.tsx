import { memo, useState } from "react";
import { Bot, UserRound } from "lucide-react";
import { useDefaultPetAvatar } from "../../../pet/petAvatar";
import { themeBgUrl } from "../../../../utils/themeBgUrl";

type ChatImAvatarProps = {
  role: "user" | "assistant";
  /** 自定义头像路径，空串表示默认头像 */
  path: string;
  className?: string;
};

/** IM 风格头像：自定义图片 > 默认（AI 为内置宠物头部，用户为 lucide 图标）。 */
export const ChatImAvatar = memo(
  ({ role, path, className }: ChatImAvatarProps): React.JSX.Element => {
    const [failedPath, setFailedPath] = useState("");
    // 加载失败的路径回退默认头像；换新路径会自动重试
    const useCustom = Boolean(path) && failedPath !== path;
    const petAvatar = useDefaultPetAvatar(role === "assistant" && !useCustom);

    const rootClass = `chat-im-avatar is-${role}${className ? ` ${className}` : ""}`;

    if (useCustom) {
      return (
        <span className={rootClass}>
          <img
            src={themeBgUrl(path)}
            alt=""
            draggable={false}
            onError={() => setFailedPath(path)}
          />
        </span>
      );
    }
    if (role === "assistant" && petAvatar) {
      return (
        <span className={`${rootClass} is-pet`}>
          <img src={petAvatar} alt="" draggable={false} />
        </span>
      );
    }
    return (
      <span className={`${rootClass} is-icon`}>
        {role === "assistant" ? (
          <Bot size={18} strokeWidth={1.8} />
        ) : (
          <UserRound size={18} strokeWidth={1.8} />
        )}
      </span>
    );
  },
);

ChatImAvatar.displayName = "ChatImAvatar";
