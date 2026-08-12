import { ShieldCheck } from "lucide-react";
import type { ChatCommand } from "./types";

export const createPermissionsCommand = (
  onOpenPanel: () => void,
  description: string,
  disabled: boolean
): ChatCommand => ({
  id: "permissions",
  label: "permissions",
  description,
  icon: ShieldCheck,
  disabled,
  execute: onOpenPanel,
});
