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
  size?: number;
};

export function OAuthProviderIcon({
  providerId,
  size = 22,
}: OAuthProviderIconProps): React.JSX.Element {
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
