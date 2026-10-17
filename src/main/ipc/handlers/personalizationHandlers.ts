import { ipcMain } from "electron";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  parseRoleSettings,
  writeRoleSettings,
} from "../../../shared/roleSettings";

const GLOBAL_ROLE_DIR = join(homedir(), ".snow");
const GLOBAL_ROLE_FILE = join(GLOBAL_ROLE_DIR, "ROLE.md");
const GLOBAL_SETTINGS_FILE = join(GLOBAL_ROLE_DIR, "settings.json");

/** 读取全局 settings.json 文本；文件不存在时返回空字符串。 */
const readGlobalSettings = async (): Promise<string> => {
  try {
    return await fs.readFile(GLOBAL_SETTINGS_FILE, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
};

/**
 * 个性化/规则设置：全局 ROLE.md 与其「覆盖内置提示词」开关的读写。
 *
 * 与 native 端 `~/.snow/ROLE.md`、`~/.snow/settings.json` 的解析约定保持一致（见
 * native/src/prompt/common.rs），保证在设置页保存的全局规则
 * 会被系统提示词构建管线直接读取生效。
 */
export const registerPersonalizationHandlers = (): void => {
  ipcMain.handle("personalization:get-global-role", async () => {
    let content = "";
    try {
      content = await fs.readFile(GLOBAL_ROLE_FILE, "utf8");
    } catch {
      // File does not exist yet — return an empty draft.
    }
    let overrideBuiltinPrompt = false;
    try {
      overrideBuiltinPrompt = parseRoleSettings(
        await readGlobalSettings(),
      ).overrideBuiltinPrompt;
    } catch {
      // Unreadable settings keep the default (no override).
    }
    return { filePath: GLOBAL_ROLE_FILE, content, overrideBuiltinPrompt };
  });

  ipcMain.handle(
    "personalization:save-global-role",
    async (_event, content: unknown, overrideBuiltinPrompt: unknown) => {
      if (typeof content !== "string") {
        throw new Error("Role content must be a string");
      }
      if (
        overrideBuiltinPrompt !== undefined &&
        typeof overrideBuiltinPrompt !== "boolean"
      ) {
        throw new Error("overrideBuiltinPrompt must be a boolean");
      }

      await fs.mkdir(GLOBAL_ROLE_DIR, { recursive: true });
      await fs.writeFile(GLOBAL_ROLE_FILE, content, "utf8");
      if (typeof overrideBuiltinPrompt === "boolean") {
        const nextSettings = writeRoleSettings(await readGlobalSettings(), {
          overrideBuiltinPrompt,
        });
        await fs.writeFile(GLOBAL_SETTINGS_FILE, nextSettings, "utf8");
      }
    },
  );
};
