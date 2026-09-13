import { isIP } from "node:net";

export type RemoteTunnelConfigInput = {
  enabled: boolean;
  autoConnect: boolean;
  serverAddr: string;
  serverPort: number;
  publicOrigin: string;
  tlsServerName: string;
  token?: string;
  caCertificate?: string;
};

export type RemoteTunnelImportBundle = {
  schemaVersion: 1;
  kind: "snow-remote-client-config";
  generatedAt?: string;
  config: RemoteTunnelConfigInput;
};

export type StoredRemoteTunnelConfig = Omit<
  RemoteTunnelConfigInput,
  "token" | "caCertificate"
> & {
  version: 1;
  token: string;
  caCertificate: string;
};

export type RemoteTunnelConfigView = Omit<
  StoredRemoteTunnelConfig,
  "version" | "token" | "caCertificate"
> & {
  configured: boolean;
  hasToken: boolean;
  hasCaCertificate: boolean;
  secureStorageAvailable: boolean;
};

const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

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

const normalizePort = (value: number): number => {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error("FRP 服务器端口必须是 1 到 65535 的整数");
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
    typeof input.serverAddr !== "string" ||
    typeof input.publicOrigin !== "string" ||
    typeof input.tlsServerName !== "string"
  ) {
    throw new Error("公网远控配置字段类型无效");
  }
  const token =
    input.token === undefined
      ? (previous?.token ?? "")
      : !input.enabled && input.token.trim() === ""
        ? ""
        : normalizeToken(input.token);
  const caCertificate =
    input.caCertificate === undefined
      ? (previous?.caCertificate ?? "")
      : !input.enabled && input.caCertificate.trim() === ""
        ? ""
        : normalizeCa(input.caCertificate);
  if (input.enabled && (!token || !caCertificate)) {
    throw new Error("启用公网远控前必须提供 FRP 凭据和 CA 证书");
  }
  return {
    version: 1,
    enabled: Boolean(input.enabled),
    autoConnect: Boolean(input.autoConnect),
    serverAddr: normalizeHost(input.serverAddr, "FRP 服务器地址"),
    serverPort: normalizePort(input.serverPort),
    publicOrigin: normalizePublicOrigin(input.publicOrigin),
    tlsServerName: normalizeHost(input.tlsServerName, "TLS 服务器名称"),
    token,
    caCertificate,
  };
};

export const parseRemoteTunnelImportBundle = (
  value: unknown,
): RemoteTunnelConfigInput => {
  if (!value || typeof value !== "object") {
    throw new Error("Snow 公网远控配置包不是有效的 JSON 对象");
  }
  const bundle = value as Partial<RemoteTunnelImportBundle>;
  if (
    bundle.schemaVersion !== 1 ||
    bundle.kind !== "snow-remote-client-config" ||
    !bundle.config ||
    typeof bundle.config !== "object"
  ) {
    throw new Error("Snow 公网远控配置包类型或版本不受支持");
  }
  const normalized = normalizeRemoteTunnelConfig(
    bundle.config as RemoteTunnelConfigInput,
    null,
  );
  return {
    enabled: normalized.enabled,
    autoConnect: normalized.autoConnect,
    serverAddr: normalized.serverAddr,
    serverPort: normalized.serverPort,
    publicOrigin: normalized.publicOrigin,
    tlsServerName: normalized.tlsServerName,
    token: normalized.token,
    caCertificate: normalized.caCertificate,
  };
};

const tomlString = (value: string): string => JSON.stringify(value);

export const renderFrpcConfig = (
  config: StoredRemoteTunnelConfig,
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
    `serverAddr = ${tomlString(config.serverAddr)}`,
    `serverPort = ${config.serverPort}`,
    "loginFailExit = true",
    'auth.method = "token"',
    'auth.additionalScopes = ["HeartBeats", "NewWorkConns"]',
    'auth.tokenSource.type = "file"',
    `auth.tokenSource.file.path = ${tomlString(normalizedPath(paths.tokenFile))}`,
    "transport.tls.enable = true",
    `transport.tls.trustedCaFile = ${tomlString(normalizedPath(paths.caFile))}`,
    `transport.tls.serverName = ${tomlString(config.tlsServerName)}`,
    'log.to = "console"',
    'log.level = "info"',
    "log.disablePrintColor = true",
    "[[proxies]]",
    'name = "snow-remote-control"',
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    `localPort = ${paths.localPort}`,
    "remotePort = 18080",
    'transport.bandwidthLimit = "20MB"',
    'transport.bandwidthLimitMode = "server"',
    "",
  ].join("\n");
};

export const redactTunnelText = (value: string): string =>
  value
    .replace(/(token|password|secret)(\s*[=:]\s*)\S+/gi, "$1$2[REDACTED]")
    .replace(/-----BEGIN[\s\S]*?-----END CERTIFICATE-----/g, "[CERTIFICATE]")
    .slice(-8_000);

export const isPermanentFrpcFailure = (value: string): boolean =>
  /authentication failed|authorization failed|invalid token|certificate|x509|tls handshake|session shutdown/i.test(
    value,
  );
