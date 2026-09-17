import { Brain } from "lucide-react";
import type { ChatCommand } from "./types";

export const createMemoryCommand = (
  onOpenPanel: () => void,
  description: string,
  disabled: boolean
): ChatCommand => ({
  id: "memory",
  label: "memory",
  description,
  icon: Brain,
  disabled,
  execute: onOpenPanel,
});