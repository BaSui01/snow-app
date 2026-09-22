import { SlashSquare } from "lucide-react";
import type { ChatCommand } from "./types";

export const createCustomCommandsCommand = (
  onOpenPanel: () => void,
  description: string,
): ChatCommand => ({
  id: "custom",
  label: "custom",
  description,
  icon: SlashSquare,
  group: "builtin",
  execute: onOpenPanel,
});
