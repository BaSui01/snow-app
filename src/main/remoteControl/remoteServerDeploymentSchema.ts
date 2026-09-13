import { isIP } from "node:net";

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
};

export type NormalizedRemoteServerDeployInput = RemoteServerDeployInput & {
  publicDomain: string;
  frpDomain: string;
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
  const domains = deriveRemoteDomains(input.rootDomain);
  return {
    serverIp,
    rootDomain: domains.rootDomain,
    publicDomain: domains.publicDomain,
    frpDomain: domains.frpDomain,
    sshPort: input.sshPort,
    sshUsername,
    authMethod: input.authMethod,
    ...(input.authMethod === "password" ? { password: input.password } : {}),
    ...(privateKeyPath ? { privateKeyPath } : {}),
    ...(input.passphrase ? { passphrase: input.passphrase } : {}),
  };
};

export const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, `'"'"'`)}'`;

export const buildRemoteInstallCommand = (
  remoteScriptPath: string,
  domains: { publicDomain: string; frpDomain: string },
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
  ]
    .filter(Boolean)
    .join(" ");

export const parseRemotePreflight = (
  output: string,
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
  if (os !== "ubuntu" || !["22.04", "24.04"].includes(version)) {
    throw new Error(
      `服务器系统必须是 Ubuntu 22.04 或 24.04；检测到 ${os || "未知"} ${version}`,
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
