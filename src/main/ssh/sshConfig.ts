import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 跳板机（ProxyJump）连接字段，已从 ssh config 别名解析。 */
export type SshConfigJumpHost = {
  /** 匹配到的 ssh config 别名；直接以 host 形式给出时为 undefined */
  alias?: string;
  host: string;
  port: number;
  user?: string;
  identityFile?: string;
};

export type SshConfigHost = {
  /** `Host` 关键字的值（别名），多个别名时取第一个非通配符值 */
  alias: string;
  /** 解析后的实际主机名（HostName，缺失时回退为 alias） */
  host: string;
  /** 登录用户名（User） */
  user?: string;
  /** 端口（Port），默认 22 */
  port: number;
  /** 私钥文件路径（IdentityFile，已展开 ~ 与 %d 等 token） */
  identityFile?: string;
  /** ProxyJump 原始值（`[user@]host[:port]` 或 ssh config 别名） */
  proxyJump?: string;
  /** ProxyJump 解析后的跳板机字段 */
  proxyJumpHost?: SshConfigJumpHost;
};

type ParsedJumpSpec = {
  user?: string;
  hostPart: string;
  port?: number;
};

const expandPath = (value: string, homeDir: string): string => {
  // %d -> home dir, %u -> 当前用户名（本机，非远端），~ -> home dir
  const expanded = value
    .replace(/%d/g, homeDir)
    .replace(/^~(?=[\\/])/, homeDir);
  return expanded.replace(/\\/g, "/");
};

const parseJumpSpec = (value: string): ParsedJumpSpec => {
  const atIndex = value.lastIndexOf("@");
  const user = atIndex > 0 ? value.slice(0, atIndex) : undefined;
  const hostPart = atIndex > 0 ? value.slice(atIndex + 1) : value;
  const bracketMatch = /^\[([^\]]+)\](?::(\d+))?$/.exec(hostPart);
  if (bracketMatch) {
    return {
      user,
      hostPart: bracketMatch[1],
      port: bracketMatch[2] ? parseInt(bracketMatch[2], 10) : undefined,
    };
  }
  const colonIndex = hostPart.lastIndexOf(":");
  if (colonIndex > 0 && /^\d+$/.test(hostPart.slice(colonIndex + 1))) {
    return {
      user,
      hostPart: hostPart.slice(0, colonIndex),
      port: parseInt(hostPart.slice(colonIndex + 1), 10),
    };
  }
  return { user, hostPart };
};

const findAliasEntry = (
  hosts: SshConfigHost[],
  alias: string,
): SshConfigHost | undefined =>
  hosts.find((host) => host.alias.toLowerCase() === alias.toLowerCase());

const resolveJumpHost = (
  spec: string,
  hosts: SshConfigHost[],
): SshConfigJumpHost | null => {
  // 多级 ProxyJump（a,b）只支持第一跳，与 ssh2 单级中转一致。
  const firstHop = spec.split(",")[0]?.trim() ?? "";
  if (!firstHop) {
    return null;
  }
  const parsed = parseJumpSpec(firstHop);
  if (!parsed.hostPart) {
    return null;
  }
  const entry = findAliasEntry(hosts, parsed.hostPart);
  if (entry) {
    return {
      alias: entry.alias,
      host: entry.host,
      port: parsed.port ?? entry.port,
      user: parsed.user ?? entry.user,
      identityFile: entry.identityFile,
    };
  }
  return {
    host: parsed.hostPart,
    port: parsed.port ?? 22,
    user: parsed.user,
  };
};

const parseSshConfigHosts = (): SshConfigHost[] => {
  const homeDir = homedir();
  const configPath = join(homeDir, ".ssh", "config");

  let content: string;
  try {
    content = readFileSync(configPath, "utf-8");
  } catch {
    return [];
  }

  const hosts: SshConfigHost[] = [];
  let current: Partial<SshConfigHost> | null = null;

  const pushCurrent = (): void => {
    if (!current?.alias) {
      return;
    }
    hosts.push({
      alias: current.alias,
      host: current.host || current.alias,
      user: current.user,
      port: current.port ?? 22,
      identityFile: current.identityFile,
      proxyJump: current.proxyJump,
    });
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.search(/\s/);
    const keyword = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
    const value = separatorIndex >= 0 ? line.slice(separatorIndex).trim() : "";

    if (keyword === "Host") {
      pushCurrent();
      current = {};
      // 取第一个非通配符别名作为展示名；整条若只有通配符则跳过
      const alias = value
        .split(/\s+/)
        .filter((item) => item && item !== "*")[0];
      if (alias) {
        current.alias = alias;
      }
      continue;
    }

    if (!current) {
      // Host 关键字之前的散落配置（全局段）不参与条目解析
      continue;
    }

    if (keyword === "HostName" && value) {
      current.host = value;
    } else if (keyword === "User" && value) {
      current.user = value;
    } else if (keyword === "Port" && /^\d+$/.test(value)) {
      current.port = parseInt(value, 10);
    } else if (keyword === "IdentityFile" && value) {
      current.identityFile = expandPath(value, homeDir);
    } else if (keyword === "ProxyJump" && value) {
      current.proxyJump = value;
    }
  }
  pushCurrent();

  return hosts;
};

/**
 * 读取本地 ~/.ssh/config 并解析其中的主机条目。
 *
 * 支持 SSH config 最常用的字段：Host / HostName / User / Port / IdentityFile /
 * ProxyJump（单级，解析为 proxyJumpHost），忽略注释与空行；`*` 通配符条目、
 * Include 等高级指令不展开（保持简单）。文件不存在或不可读时返回空数组，不抛出异常。
 */
export const listSshConfigHosts = (): SshConfigHost[] => {
  const hosts = parseSshConfigHosts();
  return hosts.map((host) => {
    if (!host.proxyJump) {
      return host;
    }
    const proxyJumpHost = resolveJumpHost(host.proxyJump, hosts);
    return proxyJumpHost ? { ...host, proxyJumpHost } : host;
  });
};

/**
 * 解析跳板机描述为连接字段：优先匹配 ~/.ssh/config 别名（取其 HostName /
 * User / Port / IdentityFile），否则按 `[user@]host[:port]` 直接解析。
 * 无法解析时返回 null。
 */
export const resolveSshConfigJumpHost = (
  spec: string,
): SshConfigJumpHost | null =>
  resolveJumpHost(spec.trim(), parseSshConfigHosts());
