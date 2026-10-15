import { isIP } from "node:net";

/** FRP 服务器端口默认值（frps bindPort）：仅用于展示与部署表单缺省值。 */
export const DEFAULT_FRP_SERVER_PORT = 7000;

/** 隧道远端回环端口默认值（frps allowPorts / SSH2 PermitListen / Caddy 反代目标）。 */
export const DEFAULT_REMOTE_PORT = 18080;

/** FRP 已占用默认回环端口时，SSH2 隧道使用的候选回环端口。 */
export const FALLBACK_REMOTE_PORT = 18081;

/** SSH2 隧道服务端口默认值（专用 snow-tunnel-sshd 实例，避开 frps 常用 7000）。 */
export const DEFAULT_SSH2_TUNNEL_PORT = 7001;

/** 活动传输类型：FRP 保持现状，SSH2 为进程内反向隧道。 */
export type RemoteTransportKind = "frp" | "ssh2";

/** FRP 传输配置输入：token/CA/remotePort 缺省时沿用已存值。 */
export type FrpTransportConfigInput = {
  serverAddr: string;
  serverPort: number;
  remotePort?: number;
  tlsServerName: string;
  token?: string;
  caCertificate?: string;
};

export type FrpTransportConfig = {
  serverAddr: string;
  serverPort: number;
  remotePort: number;
  tlsServerName: string;
  token: string;
  caCertificate: string;
};

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

/** 保存 / 连接输入：transport 为本次要启用的活动传输，两种传输各自携带一套配置。 */
export type RemoteTunnelConfigInput = {
  enabled: boolean;
  autoConnect: boolean;
  transport: RemoteTransportKind;
  publicOrigin: string;
  frp?: FrpTransportConfigInput;
  ssh2?: Ssh2TransportConfigInput;
};

/**
 * v2 存储结构：公共字段位于顶层，FRP 与 SSH2 各保留一套配置；
 * 私钥属于 SSH2 配置的一部分，仅经系统安全存储加密落盘。
 */
export type StoredRemoteTunnelConfig = {
  version: 2;
  activeTransport: RemoteTransportKind;
  enabled: boolean;
  autoConnect: boolean;
  publicOrigin: string;
  frp: FrpTransportConfig | null;
  ssh2: Ssh2TransportConfig | null;
};

export type RemoteTunnelFrpView = {
  configured: boolean;
  serverAddr: string;
  serverPort: number;
  remotePort: number;
  tlsServerName: string;
  hasToken: boolean;
  hasCaCertificate: boolean;
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

/** 状态视图：只暴露凭据是否存在，不包含 token / CA / 私钥正文。 */
export type RemoteTunnelConfigView = {
  configured: boolean;
  enabled: boolean;
  autoConnect: boolean;
  activeTransport: RemoteTransportKind;
  publicOrigin: string;
  secureStorageAvailable: boolean;
  frp: RemoteTunnelFrpView;
  ssh2: RemoteTunnelSsh2View;
};

export type RemoteTunnelImportBundleV1 = {
  schemaVersion: 1;
  kind: "snow-remote-client-config";
  generatedAt?: string;
  config: {
    enabled: boolean;
    autoConnect: boolean;
    serverAddr: string;
    serverPort: number;
    remotePort?: number;
    publicOrigin: string;
    tlsServerName: string;
    token?: string;
    caCertificate?: string;
  };
};

/** v2 配置包：FRP 携带完整凭据；SSH2 只含非敏感元数据，私钥永不导出。 */
export type RemoteTunnelImportBundleV2 = {
  schemaVersion: 2;
  kind: "snow-remote-client-config";
  generatedAt?: string;
  config: {
    enabled: boolean;
    autoConnect: boolean;
    transport: RemoteTransportKind;
    publicOrigin: string;
    frp?: FrpTransportConfigInput;
    ssh2?: Omit<Ssh2TransportConfigInput, "privateKey">;
  };
};

export type RemoteTunnelImportBundle =
  RemoteTunnelImportBundleV1 | RemoteTunnelImportBundleV2;

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

const normalizeToken = (value: string): string => {
  const token = value.trim();
  if (token.length < 32 || token.length > 512) {
    throw new Error("FRP 凭据必须是 32 到 512 个字符");
  }
  if (/\r|\n|\0/.test(token)) {
    throw new Error("FRP 凭据不能包含换行或空字符");
  }
  return token;
};

const normalizeCa = (value: string): string => {
  const pem = value.trim();
  if (
    pem.length > 64 * 1024 ||
    !pem.startsWith("-----BEGIN CERTIFICATE-----") ||
    !pem.endsWith("-----END CERTIFICATE-----")
  ) {
    throw new Error("CA 证书必须是小于 64 KiB 的 PEM 证书");
  }
  return `${pem}\n`;
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

const buildFrpConfig = (
  input: FrpTransportConfigInput | undefined,
  previous: FrpTransportConfig | null,
  enabled: boolean,
): FrpTransportConfig => {
  if (!input) {
    if (previous) return previous;
    throw new Error("缺少 FRP 隧道配置");
  }
  if (
    typeof input.serverAddr !== "string" ||
    typeof input.serverPort !== "number" ||
    typeof input.tlsServerName !== "string"
  ) {
    throw new Error("FRP 隧道配置字段类型无效");
  }
  const token =
    input.token === undefined
      ? (previous?.token ?? "")
      : !enabled && input.token.trim() === ""
        ? ""
        : normalizeToken(input.token);
  const caCertificate =
    input.caCertificate === undefined
      ? (previous?.caCertificate ?? "")
      : !enabled && input.caCertificate.trim() === ""
        ? ""
        : normalizeCa(input.caCertificate);
  const remotePort =
    input.remotePort === undefined
      ? (previous?.remotePort ?? DEFAULT_REMOTE_PORT)
      : normalizePort(input.remotePort, "FRP 隧道端口必须是 1 到 65535 的整数");
  return {
    serverAddr: normalizeHost(input.serverAddr, "FRP 服务器地址"),
    serverPort: normalizePort(
      input.serverPort,
      "FRP 服务器端口必须是 1 到 65535 的整数",
    ),
    remotePort,
    tlsServerName: normalizeHost(input.tlsServerName, "TLS 服务器名称"),
    token,
    caCertificate,
  };
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

/**
 * 归一化保存 / 连接输入：两种传输分别校验并保留另一套已存配置；
 * 启用时要求活动传输凭据完整（FRP：token + CA；SSH2：本机私钥）。
 */
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
  const transport: RemoteTransportKind =
    input.transport === "ssh2" ? "ssh2" : "frp";
  const enabled = Boolean(input.enabled);
  const frp =
    input.frp !== undefined || previous?.frp
      ? buildFrpConfig(input.frp, previous?.frp ?? null, enabled)
      : null;
  const ssh2 =
    input.ssh2 !== undefined || previous?.ssh2
      ? buildSsh2Config(input.ssh2, previous?.ssh2 ?? null)
      : null;
  if (enabled) {
    if (transport === "frp" && (!frp || !frp.token || !frp.caCertificate)) {
      throw new Error("启用公网远控前必须提供 FRP 凭据和 CA 证书");
    }
    if (transport === "ssh2" && (!ssh2 || !ssh2.privateKey)) {
      throw new Error(
        "启用 SSH2 隧道前必须在本机生成专用密钥；请使用“自动部署并连接”完成授权",
      );
    }
  }
  return {
    version: 2,
    activeTransport: transport,
    enabled,
    autoConnect: Boolean(input.autoConnect),
    publicOrigin: normalizePublicOrigin(input.publicOrigin),
    frp,
    ssh2,
  };
};

type StoredRemoteTunnelConfigV1 = {
  version: 1;
  enabled: boolean;
  autoConnect: boolean;
  serverAddr: string;
  serverPort: number;
  remotePort: number;
  publicOrigin: string;
  tlsServerName: string;
  token: string;
  caCertificate: string;
};

const asStoredV1 = (value: unknown): StoredRemoteTunnelConfigV1 | null => {
  if (!isRecord(value) || value.version !== 1) return null;
  if (
    typeof value.enabled !== "boolean" ||
    typeof value.autoConnect !== "boolean" ||
    typeof value.serverAddr !== "string" ||
    typeof value.serverPort !== "number" ||
    typeof value.remotePort !== "number" ||
    typeof value.publicOrigin !== "string" ||
    typeof value.tlsServerName !== "string" ||
    typeof value.token !== "string" ||
    typeof value.caCertificate !== "string"
  ) {
    return null;
  }
  return value as StoredRemoteTunnelConfigV1;
};

/** 解析落盘结构：version 1 旧配置迁移为 v2 的 FRP 传输，不静默改写文件。 */
export const parseStoredRemoteTunnelConfig = (
  value: unknown,
): StoredRemoteTunnelConfig => {
  if (!isRecord(value)) {
    throw new Error("公网远控配置无效");
  }
  const v1 = asStoredV1(value);
  if (v1) {
    return normalizeRemoteTunnelConfig(
      {
        enabled: v1.enabled,
        autoConnect: v1.autoConnect,
        transport: "frp",
        publicOrigin: v1.publicOrigin,
        frp: {
          serverAddr: v1.serverAddr,
          serverPort: v1.serverPort,
          remotePort: v1.remotePort,
          tlsServerName: v1.tlsServerName,
          token: v1.token,
          caCertificate: v1.caCertificate,
        },
      },
      null,
    );
  }
  if (value.version === 2) {
    return normalizeRemoteTunnelConfig(
      {
        enabled: Boolean(value.enabled),
        autoConnect: Boolean(value.autoConnect),
        transport: value.activeTransport === "ssh2" ? "ssh2" : "frp",
        publicOrigin:
          typeof value.publicOrigin === "string" ? value.publicOrigin : "",
        ...(isRecord(value.frp)
          ? { frp: value.frp as FrpTransportConfigInput }
          : {}),
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
  transport: config.activeTransport,
  publicOrigin: config.publicOrigin,
  ...(config.frp ? { frp: { ...config.frp } } : {}),
  ...(config.ssh2 ? { ssh2: { ...config.ssh2 } } : {}),
});

/**
 * 导出可分享配置包：FRP 保持携带完整凭据（与旧行为一致）；
 * SSH2 只含非敏感元数据，私钥绝不进入配置包。
 */
export const createRemoteTunnelBundle = (
  config: StoredRemoteTunnelConfig,
): RemoteTunnelImportBundleV2 => ({
  schemaVersion: 2,
  kind: "snow-remote-client-config",
  generatedAt: new Date().toISOString(),
  config: {
    enabled: config.enabled,
    autoConnect: config.autoConnect,
    transport: config.activeTransport,
    publicOrigin: config.publicOrigin,
    ...(config.frp ? { frp: { ...config.frp } } : {}),
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
 * 解析配置包：兼容 v1（FRP 旧包）与 v2。
 * SSH2 配置包不含私钥；导入后需要重新部署授权才能连接。
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
  if (bundle.schemaVersion === 1) {
    if (typeof config.publicOrigin !== "string") {
      throw new Error("Snow 公网远控配置包字段类型无效");
    }
    return {
      enabled: Boolean(config.enabled),
      autoConnect: Boolean(config.autoConnect),
      transport: "frp",
      publicOrigin: config.publicOrigin,
      frp: {
        serverAddr: config.serverAddr as string,
        serverPort: config.serverPort as number,
        remotePort: config.remotePort as number | undefined,
        tlsServerName: config.tlsServerName as string,
        token: config.token as string | undefined,
        caCertificate: config.caCertificate as string | undefined,
      },
    };
  }
  if (bundle.schemaVersion === 2) {
    if (typeof config.publicOrigin !== "string") {
      throw new Error("Snow 公网远控配置包字段类型无效");
    }
    const transport: RemoteTransportKind =
      config.transport === "ssh2" ? "ssh2" : "frp";
    const ssh2Raw = isRecord(config.ssh2) ? config.ssh2 : null;
    const ssh2HasKey =
      typeof ssh2Raw?.privateKey === "string" &&
      ssh2Raw.privateKey.trim() !== "";
    const enabled =
      Boolean(config.enabled) && (transport !== "ssh2" || ssh2HasKey);
    return {
      enabled,
      autoConnect: enabled && Boolean(config.autoConnect),
      transport,
      publicOrigin: config.publicOrigin,
      ...(isRecord(config.frp)
        ? { frp: config.frp as FrpTransportConfigInput }
        : {}),
      ...(ssh2Raw
        ? {
            ssh2: {
              serverAddr: ssh2Raw.serverAddr as string,
              serverPort: ssh2Raw.serverPort as number,
              username: ssh2Raw.username as string,
              remotePort: ssh2Raw.remotePort as number | undefined,
              hostKeyType: ssh2Raw.hostKeyType as string,
              hostKeyPublicKey: ssh2Raw.hostKeyPublicKey as string,
              hostKeyFingerprint: ssh2Raw.hostKeyFingerprint as string,
              ...(ssh2HasKey
                ? { privateKey: ssh2Raw.privateKey as string }
                : {}),
            },
          }
        : {}),
    };
  }
  throw new Error("Snow 公网远控配置包类型或版本不受支持");
};

const tomlString = (value: string): string => JSON.stringify(value);

export const renderFrpcConfig = (
  frp: FrpTransportConfig,
  paths: { tokenFile: string; caFile: string; localPort: number },
): string => {
  if (
    !Number.isInteger(paths.localPort) ||
    paths.localPort < 1 ||
    paths.localPort > 65_535
  ) {
    throw new Error("Snow WAN listener 端口无效");
  }
  const normalizedPath = (value: string): string => value.replace(/\\/g, "/");
  return [
    `serverAddr = ${tomlString(frp.serverAddr)}`,
    `serverPort = ${frp.serverPort}`,
    "loginFailExit = true",
    'auth.method = "token"',
    'auth.additionalScopes = ["HeartBeats", "NewWorkConns"]',
    'auth.tokenSource.type = "file"',
    `auth.tokenSource.file.path = ${tomlString(normalizedPath(paths.tokenFile))}`,
    "transport.tls.enable = true",
    `transport.tls.trustedCaFile = ${tomlString(normalizedPath(paths.caFile))}`,
    `transport.tls.serverName = ${tomlString(frp.tlsServerName)}`,
    'log.to = "console"',
    'log.level = "info"',
    "log.disablePrintColor = true",
    "[[proxies]]",
    'name = "snow-remote-control"',
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    `localPort = ${paths.localPort}`,
    `remotePort = ${frp.remotePort}`,
    'transport.bandwidthLimit = "20MB"',
    'transport.bandwidthLimitMode = "server"',
    "",
  ].join("\n");
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

export const isPermanentFrpcFailure = (value: string): boolean =>
  /authentication failed|authorization failed|invalid token|token in login|certificate|x509|tls handshake|tls:|session shutdown|unsupported message codec|version_mismatch/i.test(
    value,
  );

/** SSH2 永久失败判定：认证、主机密钥、授权范围类错误不应自动重试。 */
export const isPermanentSsh2Failure = (value: string): boolean =>
  /All configured authentication methods failed|authentication failed|Cannot parse privateKey|主机密钥|身份验证失败|重新授权|重新部署|授权范围|administratively prohibited|not permitted/i.test(
    value,
  );
