/**
 * SSH 文件传输的本地偏好存储（仅保存最近一次下载目录）。
 * 读取失败一律回退为 null；写入失败静默忽略，不影响传输本身。
 */
import { app } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type SshTransferPrefs = {
  lastDownloadDir?: string;
};

const prefsFilePath = (): string =>
  join(app.getPath("userData"), "ssh-transfer-prefs.json");

const readPrefs = (): SshTransferPrefs => {
  try {
    const raw = readFileSync(prefsFilePath(), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    const input = parsed as Record<string, unknown>;
    const prefs: SshTransferPrefs = {};
    if (typeof input.lastDownloadDir === "string" && input.lastDownloadDir) {
      prefs.lastDownloadDir = input.lastDownloadDir;
    }
    return prefs;
  } catch {
    return {};
  }
};

/** 最近一次成功使用的下载目录；未设置或已失效时返回 null。 */
export const getLastDownloadDir = (): string | null => {
  const { lastDownloadDir } = readPrefs();
  return lastDownloadDir ?? null;
};

export const setLastDownloadDir = (dir: string): void => {
  try {
    writeFileSync(prefsFilePath(), JSON.stringify({ lastDownloadDir: dir }));
  } catch {
    // 偏好写入失败不影响传输结果。
  }
};
