import { Anthropic, DeepSeek, Gemini, Google, OpenAI } from "@lobehub/icons";

type RequestMethodIconProps = {
  method: string;
  size?: number;
};

export function RequestMethodIcon({
  method,
  size = 15,
}: RequestMethodIconProps): React.JSX.Element | null {
  switch (method) {
    case "chat":
      return <DeepSeek.Color size={size} />;
    case "responses":
      return <OpenAI size={size} />;
    case "anthropic":
      return <Anthropic size={size} />;
    case "gemini":
      return <Gemini.Color size={size} />;
    case "interactions":
      return <Google.Color size={size} />;
    default:
      return null;
  }
}
