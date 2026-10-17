import { ipcRenderer } from "electron";
import type { GlobalRoleFile } from "../types";

export const personalizationApi = {
  /** 读取全局规则文件（~/.snow/ROLE.md）。 */
  getGlobalRole: (): Promise<GlobalRoleFile> =>
    ipcRenderer.invoke("personalization:get-global-role"),
  /**
   * 保存全局规则文件（~/.snow/ROLE.md）；传入 overrideBuiltinPrompt 时同时写入
   * ~/.snow/settings.json 的「覆盖内置提示词」开关。
   */
  saveGlobalRole: (
    content: string,
    overrideBuiltinPrompt?: boolean,
  ): Promise<void> =>
    ipcRenderer.invoke(
      "personalization:save-global-role",
      content,
      overrideBuiltinPrompt,
    ),
};
