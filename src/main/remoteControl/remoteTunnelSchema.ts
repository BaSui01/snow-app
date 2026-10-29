import { isIP } from "node:net";

/** 隧道远端回环端口默认值（SSH2 PermitListen / Caddy 反代目标）。 */
export const DEFAULT_REMOTE_PORT = 18080;

/** SSH2 隧道服务端口默认值（专用 snow-tunnel-sshd 实例）。 */
export const DEFAULT_SSH2_TUNNEL_PORT = 7001;

/** SSH2 传输配置输入；privateKey 缺省时沿用已存值（导入包不携带私钥）。 */
export type Ssh2TransportConfigInput = {
  serverAddr: string;
  serverPort: number;
  username: string;
  remotePort?: number;
  hostKeyType: string;
  hostKeyPublicKey: string;
  hostKeyFingerprint: string;
  privateKey?: string;
};

export type Ssh2TransportConfig = {
  serverAddr: string;
  serverPort: number;
  username: string;
  remotePort: number;
  hostKeyType: string;
  hostKeyPublicKey: string;
  hostKeyFingerprint: string;
  privateKey: string;
};

/** 保存 / 连接输入。 */
export type RemoteTunnelConfigInput = {
  enabled: boolean;
  autoConnect: boolean;
  publicOrigin: string;
  ssh2?: Ssh2TransportConfigInput;
};

/** v3 存储结构：只保留 SSH2 隧道配置；私钥仅经系统安全存储加密落盘。 */
export type StoredRemoteTunnelConfig = {
  version: 3;
  enabled: boolean;
  autoConnect: boolean;
  publicOrigin: string;
  ssh2: Ssh2TransportConfig | null;
};

export type RemoteTunnelSsh2View = {
  configured: boolean;
  serverAddr: string;
  serverPort: number;
  username: string;
  remotePort: number;
  hostKeyType: string;
  hostKeyPublicKey: string;
  hostKeyFingerprint: string;
  hasPrivateKey: boolean;
  /** 缺少本机私钥（如导入的配置包）：需要重新部署授权后才能连接。 */
  needsAuthorization: boolean;
};

/** 状态视图：只暴露凭据是否存在，不包含私钥正文。 */
export type RemoteTunnelConfigView = {
  configured: boolean;
  enabled: boolean;
  autoConnect: boolean;
  publicOrigin: string;
  secureStorageAvailable: boolean;
  ssh2: RemoteTunnelSsh2View;
};

/** v3 配置包：只含 SSH2 非敏感元数据，私钥永不导出。 */
export type RemoteTunnelImportBundle = {
  schemaVersion: 3;
  kind: "snow-remote-client-config";
  generatedAt?: string;
  config: {
    enabled: boolean;
    autoConnect: boolean;
    publicOrigin: string;
    ssh2?: Omit<Ssh2TransportConfigInput, "privateKey">;
  };
};

const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeHost = (value: string, field: string): string => {
  const host = value.trim().toLowerCase();
  if (
    !host ||
    host.includes("://") ||
    host.includes("/") ||
    host.includes("@")
  ) {
    throw new Error(`${field} 必须是纯主机名或 IP 地址`);
  }
  if (!isIP(host) && !HOSTNAME_PATTERN.test(host)) {
    throw new Error(`${field} 格式无效`);
  }
  return host;
};

const normalizePublicOrigin = (value: string): string => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("公网访问地址必须是无凭据的 HTTPS 地址");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("公网访问地址不能包含路径、查询或 fragment");
  }
  return url.origin;
};

const normalizePort = (value: number, message: string): number => {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(message);
  }
  return value;
};

const normalizeUsername = (value: string): string => {
  const username = value.trim();
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(username)) {
    throw new Error("SSH2 隧道用户名格式无效");
  }
  return username;
};

const normalizeHostKeyType = (value: string): string => {
  const keyType = value.trim();
  if (!/^[A-Za-z0-9@._+-]{1,64}$/.test(keyType)) {
    throw new Error("SSH2 主机密钥类型无效");
  }
  return keyType;
};

const normalizeHostKeyPublicKey = (value: string): string => {
  const publicKey = value.trim();
  if (
    !publicKey ||
    publicKey.length > 8 * 1024 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(publicKey)
  ) {
    throw new Error("SSH2 主机公钥格式无效");
  }
  return publicKey;
};

const normalizeHostKeyFingerprint = (value: string): string => {
  const fingerprint = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
    throw new Error("SSH2 主机密钥指纹必须是 SHA-256 十六进制字符串");
  }
  return fingerprint;
};

const normalizePrivateKey = (
  value: string | undefined,
  previous: string | null,
): string => {
  if (value === undefined) {
    return previous ?? "";
  }
  const pem = value.trim();
  if (!pem) {
    return previous ?? "";
  }
  if (pem.length > 16 * 1024) {
    throw new Error("SSH2 隧道私钥长度异常");
  }
  if (
    !/^-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]+-----END OPENSSH PRIVATE KEY-----$/.test(
      pem,
    )
  ) {
    throw new Error("SSH2 隧道私钥必须是 OpenSSH 格式的私钥");
  }
  return `${pem}\n`;
};

const buildSsh2Config = (
  input: Ssh2TransportConfigInput | undefined,
  previous: Ssh2TransportConfig | null,
): Ssh2TransportConfig => {
  if (!input) {
    if (previous) return previous;
    throw new Error("缺少 SSH2 隧道配置");
  }
  let hostKeyType = previous?.hostKeyType ?? "";
  if (input.hostKeyType !== undefined) {
    if (typeof input.hostKeyType !== "string") {
      throw new Error("SSH2 隧道配置字段类型无效");
    }
    hostKeyType = normalizeHostKeyType(input.hostKeyType);
  }
  let hostKeyPublicKey = previous?.hostKeyPublicKey ?? "";
  if (input.hostKeyPublicKey !== undefined) {
    if (typeof input.hostKeyPublicKey !== "string") {
      throw new Error("SSH2 隧道配置字段类型无效");
    }
    hostKeyPublicKey = normalizeHostKeyPublicKey(input.hostKeyPublicKey);
  }
  let hostKeyFingerprint = previous?.hostKeyFingerprint ?? "";
  if (input.hostKeyFingerprint !== undefined) {
    if (typeof input.hostKeyFingerprint !== "string") {
      throw new Error("SSH2 隧道配置字段类型无效");
    }
    hostKeyFingerprint = normalizeHostKeyFingerprint(input.hostKeyFingerprint);
  }
  if (!hostKeyType || !hostKeyPublicKey || !hostKeyFingerprint) {
    throw new Error("缺少 SSH2 主机密钥信息，请通过“自动部署并连接”获取");
  }
  if (
    typeof input.serverAddr !== "string" ||
    typeof input.serverPort !== "number" ||
    typeof input.username !== "string"
  ) {
    throw new Error("SSH2 隧道配置字段类型无效");
  }
  const remotePort =
    input.remotePort === undefined
      ? (previous?.remotePort ?? DEFAULT_REMOTE_PORT)
      : normalizePort(
          input.remotePort,
          "SSH2 隧道回环端口必须是 1 到 65535 的整数",
        );
  return {
    serverAddr: normalizeHost(input.serverAddr, "SSH2 隧道服务器地址"),
    serverPort: normalizePort(
      input.serverPort,
      "SSH2 隧道端口必须是 1 到 65535 的整数",
    ),
    username: normalizeUsername(input.username),
    remotePort,
    hostKeyType,
    hostKeyPublicKey,
    hostKeyFingerprint,
    privateKey: normalizePrivateKey(
      input.privateKey,
      previous?.privateKey ?? null,
    ),
  };
};

/** 归一化保存 / 连接输入；启用时要求本机私钥完整。 */
export const normalizeRemoteTunnelConfig = (
  input: RemoteTunnelConfigInput,
  previous?: StoredRemoteTunnelConfig | null,
): StoredRemoteTunnelConfig => {
  if (!input || typeof input !== "object") {
    throw new Error("公网远控配置无效");
  }
  if (
    typeof input.enabled !== "boolean" ||
    typeof input.autoConnect !== "boolean" ||
    typeof input.publicOrigin !== "string"
  ) {
    throw new Error("公网远控配置字段类型无效");
  }
  const enabled = Boolean(input.enabled);
  const ssh2 =
    input.ssh2 !== undefined || previous?.ssh2
      ? buildSsh2Config(input.ssh2, previous?.ssh2 ?? null)
      : null;
  if (enabled && (!ssh2 || !ssh2.privateKey)) {
    throw new Error(
      "启用 SSH2 隧道前必须在本机生成专用密钥；请使用“自动部署并连接”完成授权",
    );
  }
  return {
    version: 3,
    enabled,
    autoConnect: Boolean(input.autoConnect),
    publicOrigin: normalizePublicOrigin(input.publicOrigin),
    ssh2,
  };
};

/**
 * 解析落盘结构：version 1/2 是带 FRP 的旧格式，其中没有 SSH2 配置时返回 null
 * （视为未配置）；含 SSH2 配置的 v2 自动迁移为 v3。
 */
export const parseStoredRemoteTunnelConfig = (
  value: unknown,
): StoredRemoteTunnelConfig | null => {
  if (!isRecord(value)) {
    throw new Error("公网远控配置无效");
  }
  if (value.version === 1) {
    return null;
  }
  if (value.version === 2) {
    if (!isRecord(value.ssh2)) return null;
    const ssh2 = value.ssh2 as Ssh2TransportConfigInput;
    const authorized =
      typeof ssh2.privateKey === "string" && ssh2.privateKey !== "";
    return normalizeRemoteTunnelConfig(
      {
        enabled: Boolean(value.enabled) && authorized,
        autoConnect: Boolean(value.autoConnect) && authorized,
        publicOrigin:
          typeof value.publicOrigin === "string" ? value.publicOrigin : "",
        ssh2,
      },
      null,
    );
  }
  if (value.version === 3) {
    return normalizeRemoteTunnelConfig(
      {
        enabled: Boolean(value.enabled),
        autoConnect: Boolean(value.autoConnect),
        publicOrigin:
          typeof value.publicOrigin === "string" ? value.publicOrigin : "",
        ...(isRecord(value.ssh2)
          ? { ssh2: value.ssh2 as Ssh2TransportConfigInput }
          : {}),
      },
      null,
    );
  }
  throw new Error("公网远控配置版本不受支持");
};

/** 把已存配置还原为保存输入（用于部署失败后恢复原有隧道）。 */
export const toRemoteTunnelConfigInput = (
  config: StoredRemoteTunnelConfig,
): RemoteTunnelConfigInput => ({
  enabled: config.enabled,
  autoConnect: config.autoConnect,
  publicOrigin: config.publicOrigin,
  ...(config.ssh2 ? { ssh2: { ...config.ssh2 } } : {}),
});

/** 导出可分享配置包：只含 SSH2 非敏感元数据，私钥绝不进入配置包。 */
export const createRemoteTunnelBundle = (
  config: StoredRemoteTunnelConfig,
): RemoteTunnelImportBundle => ({
  schemaVersion: 3,
  kind: "snow-remote-client-config",
  generatedAt: new Date().toISOString(),
  config: {
    enabled: config.enabled,
    autoConnect: config.autoConnect,
    publicOrigin: config.publicOrigin,
    ...(config.ssh2
      ? {
          ssh2: {
            serverAddr: config.ssh2.serverAddr,
            serverPort: config.ssh2.serverPort,
            username: config.ssh2.username,
            remotePort: config.ssh2.remotePort,
            hostKeyType: config.ssh2.hostKeyType,
            hostKeyPublicKey: config.ssh2.hostKeyPublicKey,
            hostKeyFingerprint: config.ssh2.hostKeyFingerprint,
          },
        }
      : {}),
  },
});

/**
 * 解析配置包：兼容 v2/v3，但两者都必须包含 SSH2 配置。
 * 旧版 FRP 配置包不再支持；SSH2 配置包不含私钥，导入后需要重新部署授权才能连接。
 */
export const parseRemoteTunnelImportBundle = (
  value: unknown,
): RemoteTunnelConfigInput => {
  if (!isRecord(value)) {
    throw new Error("Snow 公网远控配置包不是有效的 JSON 对象");
  }
  const bundle = value as {
    schemaVersion?: unknown;
    kind?: unknown;
    config?: unknown;
  };
  if (bundle.kind !== "snow-remote-client-config" || !isRecord(bundle.config)) {
    throw new Error("Snow 公网远控配置包类型或版本不受支持");
  }
  const config = bundle.config;
  if (bundle.schemaVersion !== 2 && bundle.schemaVersion !== 3) {
    throw new Error("Snow 公网远控配置包类型或版本不受支持");
  }
  if (typeof config.publicOrigin !== "string") {
    throw new Error("Snow 公网远控配置包字段类型无效");
  }
  const ssh2Raw = isRecord(config.ssh2) ? config.ssh2 : null;
  if (!ssh2Raw) {
    throw new Error(
      "该配置包是旧版 FRP 格式，已不再支持；请使用 SSH2 重新部署或导出新的配置包",
    );
  }
  const ssh2HasKey =
    typeof ssh2Raw.privateKey === "string" && ssh2Raw.privateKey.trim() !== "";
  const enabled = Boolean(config.enabled) && ssh2HasKey;
  return {
    enabled,
    autoConnect: enabled && Boolean(config.autoConnect),
    publicOrigin: config.publicOrigin,
    ssh2: {
      serverAddr: ssh2Raw.serverAddr as string,
      serverPort: ssh2Raw.serverPort as number,
      username: ssh2Raw.username as string,
      remotePort: ssh2Raw.remotePort as number | undefined,
      hostKeyType: ssh2Raw.hostKeyType as string,
      hostKeyPublicKey: ssh2Raw.hostKeyPublicKey as string,
      hostKeyFingerprint: ssh2Raw.hostKeyFingerprint as string,
      ...(ssh2HasKey ? { privateKey: ssh2Raw.privateKey as string } : {}),
    },
  };
};

export const redactTunnelText = (value: string): string =>
  value
    .replace(
      /(token|password|secret|passphrase)(\s*[=:]\s*)\S+/gi,
      "$1$2[REDACTED]",
    )
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "[SSH PRIVATE KEY]",
    )
    .replace(/-----BEGIN[\s\S]*?-----END CERTIFICATE-----/g, "[CERTIFICATE]")
    .slice(-8_000);

/** SSH2 永久失败判定：认证、主机密钥、授权范围类错误不应自动重试。 */
export const isPermanentSsh2Failure = (value: string): boolean =>
  /All configured authentication methods failed|authentication failed|Cannot parse privateKey|主机密钥|身份验证失败|重新授权|重新部署|授权范围|administratively prohibited|not permitted/i.test(
    value,
  );
