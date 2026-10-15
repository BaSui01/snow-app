import { isIP } from "node:net";
import {
  DEFAULT_FRP_SERVER_PORT,
  DEFAULT_REMOTE_PORT,
  DEFAULT_SSH2_TUNNEL_PORT,
} from "./remoteTunnelSchema";

export type RemoteServerAuthMethod = "password" | "privateKey";

export type RemoteServerDeployInput = {
  serverIp: string;
  rootDomain: string;
  sshPort: number;
  sshUsername: string;
  authMethod: RemoteServerAuthMethod;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  /** frps 控制端口（bindPort）；缺省 7000。 */
  frpBindPort?: number;
  /** FRP 隧道远端端口（allowPorts 与 Caddy 反代目标）；缺省 18080。 */
  frpRemotePort?: number;
  /** 隧道类型：缺省 frp 保持旧行为；ssh2 使用进程内反向隧道。 */
  transport?: "frp" | "ssh2";
  /** SSH2 隧道服务端口（专用 snow-tunnel-sshd 实例）；缺省 7001。 */
  ssh2TunnelPort?: number;
  /** SSH2 隧道回环端口（PermitListen 与 Caddy 反代目标）；缺省 18080。 */
  ssh2RemotePort?: number;
};

export type NormalizedRemoteServerDeployInput = Omit<
  RemoteServerDeployInput,
  | "frpBindPort"
  | "frpRemotePort"
  | "transport"
  | "ssh2TunnelPort"
  | "ssh2RemotePort"
> & {
  transport: "frp" | "ssh2";
  publicDomain: string;
  frpDomain: string;
  frpBindPort: number;
  frpRemotePort: number;
  ssh2TunnelPort: number;
  ssh2RemotePort: number;
};

const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export const isPublicIpv4 = (value: string): boolean => {
  if (isIP(value) !== 4) return false;
  const [a, b] = value.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
};

export const extractDohIpv4Answers = (payload: unknown): string[] => {
  if (!payload || typeof payload !== "object") return [];
  const answer = (payload as { Answer?: unknown }).Answer;
  if (!Array.isArray(answer)) return [];
  return [
    ...new Set(
      answer.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const record = item as { type?: unknown; data?: unknown };
        return record.type === 1 &&
          typeof record.data === "string" &&
          isIP(record.data) === 4
          ? [record.data]
          : [];
      }),
    ),
  ];
};

export const deriveRemoteDomains = (
  rootDomain: string,
): { rootDomain: string; publicDomain: string; frpDomain: string } => {
  const normalized = rootDomain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\.$/, "");
  if (
    !HOSTNAME_PATTERN.test(normalized) ||
    normalized.includes("/") ||
    normalized.includes("@") ||
    normalized.includes("..")
  ) {
    throw new Error("请输入根域名，例如 example.com，不要填写 https:// 或路径");
  }
  return {
    rootDomain: normalized,
    publicDomain: `snow.${normalized}`,
    frpDomain: `frp.${normalized}`,
  };
};

const normalizeDeployPort = (value: number, label: string): number => {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${label}必须是 1 到 65535 的整数`);
  }
  return value;
};

export const normalizeRemoteServerDeployInput = (
  input: RemoteServerDeployInput,
): NormalizedRemoteServerDeployInput => {
  if (!input || typeof input !== "object") {
    throw new Error("服务器部署信息无效");
  }
  if (
    typeof input.serverIp !== "string" ||
    typeof input.rootDomain !== "string" ||
    typeof input.sshUsername !== "string" ||
    typeof input.sshPort !== "number"
  ) {
    throw new Error("服务器部署字段类型无效");
  }
  const serverIp = input.serverIp.trim();
  if (!isPublicIpv4(serverIp)) {
    throw new Error("服务器地址必须是独立公网 IPv4，不能填写内网地址");
  }
  if (
    !Number.isInteger(input.sshPort) ||
    input.sshPort < 1 ||
    input.sshPort > 65_535
  ) {
    throw new Error("SSH 端口必须是 1 到 65535 的整数");
  }
  const sshUsername = input.sshUsername.trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(sshUsername)) {
    throw new Error("SSH 用户名格式无效");
  }
  if (input.authMethod !== "password" && input.authMethod !== "privateKey") {
    throw new Error("请选择 SSH 密码或私钥登录");
  }
  if (input.authMethod === "password" && !input.password) {
    throw new Error("请输入 SSH 密码；密码只在本次部署期间保存在内存中");
  }
  if (input.password !== undefined && typeof input.password !== "string") {
    throw new Error("SSH 密码格式无效");
  }
  if (
    input.privateKeyPath !== undefined &&
    typeof input.privateKeyPath !== "string"
  ) {
    throw new Error("SSH 私钥路径格式无效");
  }
  if (input.passphrase !== undefined && typeof input.passphrase !== "string") {
    throw new Error("SSH 私钥密码格式无效");
  }
  const privateKeyPath = input.privateKeyPath?.trim();
  if (input.authMethod === "privateKey" && !privateKeyPath) {
    throw new Error("请选择 SSH 私钥文件");
  }
  if (
    (input.password?.length ?? 0) > 4096 ||
    (input.passphrase?.length ?? 0) > 4096
  ) {
    throw new Error("SSH 凭据长度异常");
  }
  const frpBindPort =
    input.frpBindPort === undefined
      ? DEFAULT_FRP_SERVER_PORT
      : normalizeDeployPort(input.frpBindPort, "FRP 控制端口");
  const frpRemotePort =
    input.frpRemotePort === undefined
      ? DEFAULT_REMOTE_PORT
      : normalizeDeployPort(input.frpRemotePort, "FRP 隧道端口");
  if (frpBindPort === frpRemotePort) {
    throw new Error("FRP 控制端口与 FRP 隧道端口不能相同");
  }
  const transport: "frp" | "ssh2" = input.transport === "ssh2" ? "ssh2" : "frp";
  const ssh2TunnelPort =
    input.ssh2TunnelPort === undefined
      ? DEFAULT_SSH2_TUNNEL_PORT
      : normalizeDeployPort(input.ssh2TunnelPort, "SSH2 隧道端口");
  const ssh2RemotePort =
    input.ssh2RemotePort === undefined
      ? DEFAULT_REMOTE_PORT
      : normalizeDeployPort(input.ssh2RemotePort, "SSH2 隧道回环端口");
  const reservedPorts = new Map<number, string>([
    [80, "Caddy 申请 HTTPS 证书"],
    [443, "Caddy 手机 HTTPS 访问"],
    [input.sshPort, "SSH 登录"],
  ]);
  for (const [label, port] of [
    ["FRP 控制端口", frpBindPort],
    ["FRP 隧道端口", frpRemotePort],
  ] as const) {
    const owner = reservedPorts.get(port);
    if (owner) {
      throw new Error(`${label} ${port} 与${owner}冲突，请更换`);
    }
  }
  if (transport === "ssh2") {
    for (const [label, port] of [
      ["SSH2 隧道端口", ssh2TunnelPort],
      ["SSH2 隧道回环端口", ssh2RemotePort],
    ] as const) {
      const owner = reservedPorts.get(port);
      if (owner) {
        throw new Error(`${label} ${port} 与${owner}冲突，请更换`);
      }
    }
    if (ssh2TunnelPort === ssh2RemotePort) {
      throw new Error("SSH2 隧道端口与 SSH2 隧道回环端口不能相同");
    }
    if (ssh2TunnelPort === frpBindPort) {
      throw new Error(
        "SSH2 隧道端口不能与 FRP 控制端口相同（切换期间 frps 可能仍在运行）",
      );
    }
  }
  const domains = deriveRemoteDomains(input.rootDomain);
  return {
    serverIp,
    rootDomain: domains.rootDomain,
    publicDomain: domains.publicDomain,
    frpDomain: domains.frpDomain,
    sshPort: input.sshPort,
    sshUsername,
    authMethod: input.authMethod,
    transport,
    frpBindPort,
    frpRemotePort,
    ssh2TunnelPort,
    ssh2RemotePort,
    ...(input.authMethod === "password" ? { password: input.password } : {}),
    ...(privateKeyPath ? { privateKeyPath } : {}),
    ...(input.passphrase ? { passphrase: input.passphrase } : {}),
  };
};

export const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, `'"'"'`)}'`;

export const buildRemoteInstallCommand = (
  remoteScriptPath: string,
  domains: {
    publicDomain: string;
    frpDomain: string;
    frpBindPort: number;
    frpRemotePort: number;
  },
  useSudo: boolean,
): string =>
  [
    useSudo ? "sudo -n" : "",
    "bash",
    shellQuote(remoteScriptPath),
    "--public-domain",
    shellQuote(domains.publicDomain),
    "--frp-domain",
    shellQuote(domains.frpDomain),
    "--frp-bind-port",
    String(domains.frpBindPort),
    "--frp-remote-port",
    String(domains.frpRemotePort),
  ]
    .filter(Boolean)
    .join(" ");

/** SSH2 隧道安装命令：上传脚本 + 公钥文件，安装受限 sshd 服务。 */
export const buildSsh2InstallCommand = (
  remoteScriptPath: string,
  params: {
    publicDomain: string;
    tunnelPort: number;
    remotePort: number;
    pubkeyPath: string;
  },
  useSudo: boolean,
): string =>
  [
    useSudo ? "sudo -n" : "",
    "bash",
    shellQuote(remoteScriptPath),
    "--public-domain",
    shellQuote(params.publicDomain),
    "--tunnel-port",
    String(params.tunnelPort),
    "--remote-port",
    String(params.remotePort),
    "--pubkey-file",
    shellQuote(params.pubkeyPath),
  ]
    .filter(Boolean)
    .join(" ");

/** SSH2 切换 Caddy 上游命令（也可用于失败回滚到旧端口）。 */
export const buildSsh2SwitchUpstreamCommand = (
  remoteScriptPath: string,
  params: { publicDomain: string; port: number },
  useSudo: boolean,
): string =>
  [
    useSudo ? "sudo -n" : "",
    "bash",
    shellQuote(remoteScriptPath),
    "--switch-upstream",
    String(params.port),
    "--public-domain",
    shellQuote(params.publicDomain),
  ]
    .filter(Boolean)
    .join(" ");

/**
 * 受支持的发行版与主版本号（/etc/os-release 的 ID 与 VERSION_ID 主版本）。
 * RHEL 系部分发行版的 VERSION_ID 带小版本（如 9.4），因此按主版本匹配。
 */
const SUPPORTED_SYSTEMS: Record<string, readonly string[]> = {
  ubuntu: ["22", "24"],
  debian: ["11", "12", "13"],
  centos: ["8", "9"],
  rhel: ["8", "9"],
  rocky: ["8", "9"],
  almalinux: ["8", "9"],
};

/** SSH2 按发行版最低主版本支持，不限制后续主版本。 */
const SSH2_MINIMUM_SYSTEM_VERSIONS: Record<string, number> = {
  ubuntu: 22,
  debian: 11,
  fedora: 44,
  centos: 9,
  rhel: 9,
  rocky: 9,
  almalinux: 9,
};

export const parseRemotePreflight = (
  output: string,
  transport: "frp" | "ssh2" = "frp",
): { os: string; version: string; arch: string; useSudo: boolean } => {
  const values = new Map(
    output
      .split(/\r?\n/)
      .map((line) => line.split("=", 2) as [string, string])
      .filter(([key, value]) => Boolean(key && value)),
  );
  const os = values.get("os")?.toLowerCase() ?? "";
  const version = values.get("version") ?? "";
  const arch = values.get("arch")?.toLowerCase() ?? "";
  const privilege = values.get("privilege") ?? "none";
  const majorVersion = version.split(".")[0];
  const minimumVersion = SSH2_MINIMUM_SYSTEM_VERSIONS[os];
  const supported =
    transport === "ssh2"
      ? minimumVersion !== undefined &&
        /^\d+$/.test(majorVersion) &&
        Number(majorVersion) >= minimumVersion
      : SUPPORTED_SYSTEMS[os]?.includes(majorVersion);
  if (!supported) {
    throw new Error(
      transport === "ssh2"
        ? `SSH2 模式支持 Ubuntu 22+、Debian 11+、Fedora 44+ 与 CentOS/RHEL/Rocky/AlmaLinux 9+ 的 x86_64/amd64 系统；检测到 ${os || "未知"} ${version}`
        : `服务器系统暂不支持：检测到 ${os || "未知"} ${version}；支持 Ubuntu 22.04/24.04、Debian 11+ 与 CentOS/RHEL/Rocky/AlmaLinux 8+ 的 x86_64 系统`,
    );
  }
  if (!new Set(["x86_64", "amd64"]).has(arch)) {
    throw new Error(`服务器必须是 x86_64；检测到 ${arch || "未知架构"}`);
  }
  if (privilege === "none") {
    throw new Error(
      "SSH 账号既不是 root，也没有免密码 sudo 权限；请改用 root 账号登录",
    );
  }
  return { os, version, arch, useSudo: privilege === "sudo" };
};
