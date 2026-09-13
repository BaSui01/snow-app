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
import {
  normalizeRemoteTunnelConfig,
  type RemoteTunnelConfigInput,
  type RemoteTunnelConfigView,
  type StoredRemoteTunnelConfig,
} from "./remoteTunnelSchema";

const MAGIC = Buffer.from("SNOWTUNNEL1", "utf8");
let writeQueue: Promise<void> = Promise.resolve();

const configDir = (): string =>
  join(app.getPath("userData"), "remote-control");
const configPath = (): string => join(configDir(), "tunnel-config.bin");

const restrictPermissions = (path: string): void => {
  try {
    chmodSync(path, 0o600);
  } catch {
    // safeStorage still protects the content on platforms without POSIX modes.
  }
};

export const isRemoteTunnelSecureStorageAvailable = (): boolean =>
  safeStorage.isEncryptionAvailable();

export const loadStoredRemoteTunnelConfig = (): StoredRemoteTunnelConfig | null => {
  const path = configPath();
  if (!existsSync(path)) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("系统安全存储不可用，无法解密公网远控配置");
  }
  const data = readFileSync(path);
  if (!data.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("公网远控配置文件已损坏");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(safeStorage.decryptString(data.subarray(MAGIC.length)));
  } catch {
    throw new Error("公网远控配置无法解密或格式无效");
  }
  const value = parsed as StoredRemoteTunnelConfig;
  if (!value || value.version !== 1) {
    throw new Error("公网远控配置版本不受支持");
  }
  return normalizeRemoteTunnelConfig(
    {
      ...value,
      token: value.token,
      caCertificate: value.caCertificate,
    },
    null,
  );
};

export const toRemoteTunnelConfigView = (
  value: StoredRemoteTunnelConfig | null,
): RemoteTunnelConfigView => ({
  configured: Boolean(value),
  enabled: value?.enabled ?? false,
  autoConnect: value?.autoConnect ?? false,
  serverAddr: value?.serverAddr ?? "",
  serverPort: value?.serverPort ?? 7000,
  publicOrigin: value?.publicOrigin ?? "",
  tlsServerName: value?.tlsServerName ?? "",
  hasToken: Boolean(value?.token),
  hasCaCertificate: Boolean(value?.caCertificate),
  secureStorageAvailable: safeStorage.isEncryptionAvailable(),
});

export const saveRemoteTunnelConfig = async (
  input: RemoteTunnelConfigInput,
): Promise<StoredRemoteTunnelConfig> => {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("系统安全存储不可用，拒绝明文保存公网远控凭据");
  }
  const operation = writeQueue.then(async () => {
    const previous = loadStoredRemoteTunnelConfig();
    const normalized = normalizeRemoteTunnelConfig(input, previous);
    const encrypted = safeStorage.encryptString(JSON.stringify(normalized));
    const dir = configDir();
    const path = configPath();
    const temp = `${path}.tmp`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(temp, Buffer.concat([MAGIC, encrypted]), { mode: 0o600 });
    restrictPermissions(temp);
    renameSync(temp, path);
    restrictPermissions(path);
    return normalized;
  });
  writeQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
};
