import { randomBytes } from "node:crypto";
import { resolve4 } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import {
  connectSsh,
  deleteSshFile,
  disconnectSsh,
  executeSshCommand,
  readSshFile,
  writeInternalSshFile,
} from "../ssh/sshManager";
import {
  remoteTunnelManager,
  type RemoteTunnelStatus,
} from "./remoteTunnelManager";
import { parseRemoteTunnelImportBundle } from "./remoteTunnelSchema";
import {
  buildRemoteInstallCommand,
  deriveRemoteDomains,
  extractDohIpv4Answers,
  normalizeRemoteServerDeployInput,
  parseRemotePreflight,
  shellQuote,
  type RemoteServerDeployInput,
} from "./remoteServerDeploymentSchema";

const DNS_OVER_HTTPS_ENDPOINTS = [
  "https://dns.alidns.com/resolve",
  "https://cloudflare-dns.com/dns-query",
] as const;

const resolve4OverHttps = async (name: string): Promise<string[]> => {
  const results = await Promise.allSettled(
    DNS_OVER_HTTPS_ENDPOINTS.map(async (endpoint) => {
      const url = new URL(endpoint);
      url.searchParams.set("name", name);
      url.searchParams.set("type", "A");
      const response = await fetch(url, {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        throw new Error(`DNS-over-HTTPS returned ${response.status}`);
      }
      return extractDohIpv4Answers(await response.json());
    }),
  );
  return [
    ...new Set(
      results.flatMap((result) =>
        result.status === "fulfilled" ? result.value : [],
      ),
    ),
  ];
};

export type RemoteServerDnsRecord = {
  host: "snow" | "frp";
  name: string;
  expectedValue: string;
  resolvedValues: string[];
  ready: boolean;
};

export type RemoteServerDnsCheck = {
  ready: boolean;
  records: RemoteServerDnsRecord[];
};

export type RemoteServerDeployStage =
  | "checking_dns"
  | "connecting_ssh"
  | "checking_server"
  | "uploading"
  | "installing"
  | "importing"
  | "verifying"
  | "completed";

export type RemoteServerDeployProgress = {
  stage: RemoteServerDeployStage;
  message: string;
};

export type RemoteServerDeployResult = {
  dns: RemoteServerDnsCheck;
  tunnel: RemoteTunnelStatus;
};

const resolveRecord = async (
  host: "snow" | "frp",
  name: string,
  expectedValue: string,
): Promise<RemoteServerDnsRecord> => {
  let resolvedValues: string[] = [];
  try {
    resolvedValues = [...new Set(await resolve4(name))];
  } catch {
    // NXDOMAIN and propagation delays are represented as an empty answer.
  }
  // A system DNS answer may be stale, intercepted, split-horizon, or supplied
  // by a VPN/TUN fake-IP resolver. Whenever it does not contain the expected
  // address, cross-check independent DNS-over-HTTPS resolvers before reporting
  // that the user's public record is wrong. No address range is special-cased.
  if (!resolvedValues.includes(expectedValue)) {
    try {
      resolvedValues = [
        ...new Set([...resolvedValues, ...(await resolve4OverHttps(name))]),
      ];
    } catch {
      // Keep the system result; the UI can retry after a transient DoH error.
    }
  }
  return {
    host,
    name,
    expectedValue,
    resolvedValues,
    ready: resolvedValues.includes(expectedValue),
  };
};

export const checkRemoteServerDns = async (input: {
  serverIp: string;
  rootDomain: string;
}): Promise<RemoteServerDnsCheck> => {
  const normalized = normalizeRemoteServerDeployInput({
    ...input,
    sshPort: 22,
    sshUsername: "root",
    authMethod: "password",
    password: "dns-check-only",
  });
  const records = await Promise.all([
    resolveRecord("snow", normalized.publicDomain, normalized.serverIp),
    resolveRecord("frp", normalized.frpDomain, normalized.serverIp),
  ]);
  return { ready: records.every((record) => record.ready), records };
};

const deploymentScriptPath = (): string =>
  app.isPackaged
    ? join(
        process.resourcesPath,
        "remote-control",
        "deploy",
        "install-ubuntu.sh",
      )
    : join(app.getAppPath(), "deploy", "remote-control", "install-ubuntu.sh");

const preflightCommand = [
  "set -eu",
  ". /etc/os-release",
  'printf "os=%s\\nversion=%s\\narch=%s\\n" "$ID" "$VERSION_ID" "$(uname -m)"',
  'if [ "$(id -u)" -eq 0 ]; then echo privilege=root; elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then echo privilege=sudo; else echo privilege=none; fi',
].join("; ");

let activeDeployment: AbortController | null = null;

export const cancelRemoteServerDeployment = (): boolean => {
  if (!activeDeployment) return false;
  activeDeployment.abort();
  return true;
};

export const deployRemoteServer = async (
  rawInput: RemoteServerDeployInput,
  onProgress: (progress: RemoteServerDeployProgress) => void,
): Promise<RemoteServerDeployResult> => {
  if (activeDeployment) {
    throw new Error("已有服务器部署正在进行，请等待或先取消");
  }
  const input = normalizeRemoteServerDeployInput(rawInput);
  const controller = new AbortController();
  activeDeployment = controller;
  let sessionId: string | null = null;
  let remoteScriptPath = "";
  let useSudo = false;
  let importedConfig: ReturnType<typeof parseRemoteTunnelImportBundle> | null =
    null;
  let completed = false;
  const report = (stage: RemoteServerDeployStage, message: string): void =>
    onProgress({ stage, message });

  try {
    report("checking_dns", "正在检查两条域名解析");
    const dns = await checkRemoteServerDns(input);
    if (!dns.ready) {
      const missing = dns.records
        .filter((record) => !record.ready)
        .map((record) => `${record.host} → ${record.expectedValue}`)
        .join("；");
      throw new Error(
        `DNS 尚未生效。请在域名解析中添加 A 记录：${missing}，然后重新检测`,
      );
    }

    report("connecting_ssh", "正在安全连接服务器");
    sessionId = await connectSsh(
      {
        host: input.serverIp,
        port: input.sshPort,
        username: input.sshUsername,
        authMethod: input.authMethod,
        ...(input.password ? { password: input.password } : {}),
        ...(input.privateKeyPath
          ? { privateKeyPath: input.privateKeyPath }
          : {}),
        ...(input.passphrase ? { passphrase: input.passphrase } : {}),
      },
      { signal: controller.signal },
    );

    report("checking_server", "正在检查 Ubuntu、架构和管理员权限");
    const preflight = parseRemotePreflight(
      await executeSshCommand(sessionId, preflightCommand, {
        timeoutMs: 30_000,
        signal: controller.signal,
      }),
    );
    useSudo = preflight.useSudo;

    const suffix = randomBytes(12).toString("hex");
    remoteScriptPath = `/tmp/snow-remote-install-${suffix}.sh`;
    report("uploading", "正在上传 Snow 内置部署程序");
    const script = await readFile(deploymentScriptPath());
    await writeInternalSshFile(sessionId, remoteScriptPath, script, {
      signal: controller.signal,
      expectedVersion: { exists: false },
    });

    report("installing", "正在安装并配置 FRP 与 HTTPS，通常需要 2–8 分钟");
    const installCommand = buildRemoteInstallCommand(
      remoteScriptPath,
      input,
      useSudo,
    );
    await executeSshCommand(
      sessionId,
      `chmod 700 ${shellQuote(remoteScriptPath)} && ${installCommand}`,
      { timeoutMs: 12 * 60_000, signal: controller.signal },
    );

    report("importing", "正在直接导入服务器配置；不会生成本机明文文件");
    const privilege = useSudo ? "sudo -n " : "";
    const bundleBytes = useSudo
      ? Buffer.from(
          await executeSshCommand(
            sessionId,
            `${privilege}cat /root/snow-remote-client.json`,
            { timeoutMs: 30_000, signal: controller.signal },
          ),
          "utf8",
        )
      : await readSshFile(sessionId, "/root/snow-remote-client.json", {
          signal: controller.signal,
        });
    if (bundleBytes.length > 96 * 1024) {
      throw new Error("服务器返回的 Snow 配置包长度异常，已拒绝导入");
    }
    const config = parseRemoteTunnelImportBundle(
      JSON.parse(bundleBytes.toString("utf8")) as unknown,
    );
    importedConfig = config;
    report("verifying", "正在连接 FRP 并验证公网 HTTPS");
    const tunnel = await remoteTunnelManager.connectTransient(config);
    if (tunnel.stage !== "online" || tunnel.endpoint.stage !== "reachable") {
      throw new Error(
        tunnel.error?.message ??
          "服务器已安装，但公网入口仍不可达；请确认安全组已放行 TCP 80、443、7000",
      );
    }
    const listenCheck = await executeSshCommand(
      sessionId,
      `${privilege}systemctl is-active snow-frps.service snow-caddy.service && ${privilege}ss -ltnH`,
      { timeoutMs: 30_000, signal: controller.signal },
    );
    if (
      !/127\.0\.0\.1:18080\b/.test(listenCheck) ||
      /(?:0\.0\.0\.0|\[::\]|\*):18080\b/.test(listenCheck)
    ) {
      throw new Error("服务器端口检查失败：18080 必须且只能监听 127.0.0.1");
    }

    // Persist only after the tunnel, HTTPS endpoint, and loopback isolation pass.
    await remoteTunnelManager.save(config);

    report("completed", "公网远控部署完成，可以扫描公网二维码");
    completed = true;
    return { dns, tunnel };
  } finally {
    if (importedConfig && !completed) {
      await remoteTunnelManager.disconnect().catch(() => undefined);
    }
    if (sessionId) {
      const privilege = useSudo ? "sudo -n " : "";
      const paths = [remoteScriptPath, "/root/snow-remote-client.json"].filter(
        Boolean,
      );
      if (paths.length > 0) {
        try {
          await executeSshCommand(
            sessionId,
            `${privilege}rm -f -- ${paths.map(shellQuote).join(" ")}`,
            { timeoutMs: 30_000 },
          );
        } catch {
          if (remoteScriptPath && !useSudo) {
            await deleteSshFile(sessionId, remoteScriptPath).catch(
              () => undefined,
            );
          }
        }
      }
      disconnectSsh(sessionId);
    }
    if (activeDeployment === controller) activeDeployment = null;
  }
};
