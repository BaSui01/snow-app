import { Eraser } from "lucide-react";
import type { ChatCommand } from "./types";

export const createClearCommand = (
  onNewChat: () => void,
  description: string,
): ChatCommand => ({
  id: "clear",
  label: "clear",
  description,
  icon: Eraser,
  execute: () => onNewChat(),
});
