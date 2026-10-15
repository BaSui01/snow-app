import { app, safeStorage } from "electron";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_FRP_SERVER_PORT,
  DEFAULT_REMOTE_PORT,
  DEFAULT_SSH2_TUNNEL_PORT,
  normalizeRemoteTunnelConfig,
  parseStoredRemoteTunnelConfig,
  type RemoteTunnelConfigInput,
  type RemoteTunnelConfigView,
  type StoredRemoteTunnelConfig,
} from "./remoteTunnelSchema";

const MAGIC = Buffer.from("SNOWTUNNEL1", "utf8");
let writeQueue: Promise<void> = Promise.resolve();

const configDir = (): string => join(app.getPath("userData"), "remote-control");
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

/** 读取并校验加密配置：version 1 旧配置会自动迁移为 v2 的 FRP 传输。 */
export const loadStoredRemoteTunnelConfig =
  (): StoredRemoteTunnelConfig | null => {
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
      parsed = JSON.parse(
        safeStorage.decryptString(data.subarray(MAGIC.length)),
      );
    } catch {
      throw new Error("公网远控配置无法解密或格式无效");
    }
    try {
      return parseStoredRemoteTunnelConfig(parsed);
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : "公网远控配置格式无效",
      );
    }
  };

/** 状态视图：只暴露凭据是否存在，不包含 token / CA / 私钥正文。 */
export const toRemoteTunnelConfigView = (
  value: StoredRemoteTunnelConfig | null,
): RemoteTunnelConfigView => ({
  configured: Boolean(value),
  enabled: value?.enabled ?? false,
  autoConnect: value?.autoConnect ?? false,
  activeTransport: value?.activeTransport ?? "frp",
  publicOrigin: value?.publicOrigin ?? "",
  secureStorageAvailable: safeStorage.isEncryptionAvailable(),
  frp: {
    configured: Boolean(value?.frp),
    serverAddr: value?.frp?.serverAddr ?? "",
    serverPort: value?.frp?.serverPort ?? DEFAULT_FRP_SERVER_PORT,
    remotePort: value?.frp?.remotePort ?? DEFAULT_REMOTE_PORT,
    tlsServerName: value?.frp?.tlsServerName ?? "",
    hasToken: Boolean(value?.frp?.token),
    hasCaCertificate: Boolean(value?.frp?.caCertificate),
  },
  ssh2: {
    configured: Boolean(value?.ssh2),
    serverAddr: value?.ssh2?.serverAddr ?? "",
    serverPort: value?.ssh2?.serverPort ?? DEFAULT_SSH2_TUNNEL_PORT,
    username: value?.ssh2?.username ?? "",
    remotePort: value?.ssh2?.remotePort ?? DEFAULT_REMOTE_PORT,
    hostKeyType: value?.ssh2?.hostKeyType ?? "",
    hostKeyPublicKey: value?.ssh2?.hostKeyPublicKey ?? "",
    hostKeyFingerprint: value?.ssh2?.hostKeyFingerprint ?? "",
    hasPrivateKey: Boolean(value?.ssh2?.privateKey),
    needsAuthorization: Boolean(value?.ssh2) && !value?.ssh2?.privateKey,
  },
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

/** 移除本机加密配置：删除后需重新部署或导入配置包才能再次连接公网。 */
export const deleteStoredRemoteTunnelConfig = (): void => {
  const path = configPath();
  rmSync(path, { force: true });
  rmSync(`${path}.tmp`, { force: true });
};
