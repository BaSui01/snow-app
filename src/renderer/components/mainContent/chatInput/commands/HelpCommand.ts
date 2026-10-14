import { CircleHelp } from "lucide-react";
import { encodeCommandTag } from "../fileTagUtils";
import type { ChatCommand } from "./types";

type HelpCommandOptions = {
  description: string;
  generalPrompt: string;
  questionTemplate: string;
  onUsed: () => void;
  precheck: () => Promise<boolean>;
};

/** 内置 /help：以 chip 插入「问 Snow 怎么用」的提示词，由用户补充后发送。 */
export const createHelpCommand = ({
  description,
  generalPrompt,
  questionTemplate,
  onUsed,
  precheck,
}: HelpCommandOptions): ChatCommand => ({
  id: "help",
  label: "help",
  description,
  icon: CircleHelp,
  buildInputContent: (args?: string) => {
    onUsed();
    const question = args?.trim();
    const prompt = question
      ? questionTemplate.replace("{{request}}", () => question)
      : generalPrompt;
    return encodeCommandTag({
      name: "help",
      prompt,
      charCount: prompt.length,
    });
  },
  precheck,
  // 选中时由 buildInputContent 插入 chip，无需直接执行。
  execute: () => undefined,
});
