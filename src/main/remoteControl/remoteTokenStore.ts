import { app, safeStorage } from "electron";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * 固定令牌存储：局域网与公网令牌由用户在设置面板固定时加密落盘。
 *
 * 未固定时服务行为与旧实现一致（启动生成随机令牌 / 公网只用一次性配对码），
 * 这里只保存用户显式固定过的值；系统安全存储不可用时拒绝写入，避免明文留存。
 */
const MAGIC = Buffer.from("SNOWREMOTEKEY1", "utf8");

export type RemoteFixedTokens = {
  lan: string | null;
  wan: string | null;
};

const EMPTY: RemoteFixedTokens = { lan: null, wan: null };

const configDir = (): string => join(app.getPath("userData"), "remote-control");
const configPath = (): string => join(configDir(), "fixed-tokens.bin");

const restrictPermissions = (path: string): void => {
  try {
    chmodSync(path, 0o600);
  } catch {
    // safeStorage 仍在内容层面保护凭据，权限位只是额外加固。
  }
};

export const isRemoteFixedTokenStorageAvailable = (): boolean =>
  safeStorage.isEncryptionAvailable();

const normalize = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** 读取已固定的令牌；文件缺失、损坏或安全存储不可用时均视为未固定。 */
export const loadRemoteFixedTokens = (): RemoteFixedTokens => {
  const path = configPath();
  if (!existsSync(path) || !safeStorage.isEncryptionAvailable()) return EMPTY;
  try {
    const data = readFileSync(path);
    if (!data.subarray(0, MAGIC.length).equals(MAGIC)) return EMPTY;
    const parsed = JSON.parse(
      safeStorage.decryptString(data.subarray(MAGIC.length)),
    ) as Partial<RemoteFixedTokens>;
    return {
      lan: normalize(parsed?.lan),
      wan: normalize(parsed?.wan),
    };
  } catch {
    return EMPTY;
  }
};

/** 保存固定令牌（null 表示取消固定）。 */
export const saveRemoteFixedTokens = (next: RemoteFixedTokens): void => {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("系统安全存储不可用，无法固定令牌");
  }
  const payload = JSON.stringify({
    version: 1,
    lan: next.lan,
    wan: next.wan,
  });
  const bytes = Buffer.concat([MAGIC, safeStorage.encryptString(payload)]);
  const dir = configDir();
  const path = configPath();
  const temp = `${path}.tmp`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(temp, bytes, { mode: 0o600 });
  restrictPermissions(temp);
  renameSync(temp, path);
  restrictPermissions(path);
};
