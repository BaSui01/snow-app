import {
  Anthropic,
  Antigravity,
  Codex,
  Grok,
  Kimi,
  OpenAI,
} from "@lobehub/icons";
import { KeyRound } from "lucide-react";

type OAuthProviderIconProps = {
  providerId: string;
  /** 插件提供的图标（data URL），优先于内置映射。 */
  iconUrl?: string;
  size?: number;
};

export function OAuthProviderIcon({
  providerId,
  iconUrl,
  size = 22,
}: OAuthProviderIconProps): React.JSX.Element {
  if (iconUrl) {
    return (
      <img
        src={iconUrl}
        width={size}
        height={size}
        alt=""
        draggable={false}
        style={{ objectFit: "contain" }}
      />
    );
  }
  switch (providerId) {
    case "chatgpt":
      return <OpenAI size={size} />;
    case "codex":
      return <Codex.Color size={size} />;
    case "anthropic":
    case "claude":
      return <Anthropic size={size} />;
    case "antigravity":
      return <Antigravity.Color size={size} />;
    case "kimi":
    case "moonshot":
      return <Kimi.Color size={size} />;
    case "xai":
    case "grok":
      return <Grok size={size} />;
    default:
      return <KeyRound size={size} strokeWidth={1.8} />;
  }
}
