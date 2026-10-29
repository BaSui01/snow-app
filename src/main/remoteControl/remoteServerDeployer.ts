import { randomBytes } from "node:crypto";
import { resolve4 } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import {
  connectSsh,
  disconnectSsh,
  executeSshCommand,
  readSshFile,
  writeInternalSshFile,
} from "../ssh/sshManager";
import {
  remoteTunnelManager,
  type RemoteTunnelStatus,
} from "./remoteTunnelManager";
import {
  toRemoteTunnelConfigInput,
  type RemoteTunnelConfigInput,
} from "./remoteTunnelSchema";
import {
  deleteStoredRemoteTunnelConfig,
  loadStoredRemoteTunnelConfig,
} from "./remoteTunnelConfig";
import { generateSsh2TunnelKeyPair, publicKeyFromPrivateKey } from "./ssh2Key";
import {
  buildSsh2InstallCommand,
  buildSsh2SwitchUpstreamCommand,
  extractDohIpv4Answers,
  normalizeRemoteServerDeployInput,
  parseRemotePreflight,
  shellQuote,
  type NormalizedRemoteServerDeployInput,
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
  host: "snow";
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
    host: "snow",
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
    resolveRecord(normalized.publicDomain, normalized.serverIp),
  ]);
  return { ready: records.every((record) => record.ready), records };
};

const deploymentScriptPath = (fileName: string): string =>
  app.isPackaged
    ? join(process.resourcesPath, "remote-control", "deploy", fileName)
    : join(app.getAppPath(), "deploy", "remote-control", fileName);

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

/**
 * 部署末尾的服务端校验：确认隧道服务与 Caddy 正在运行，并取回监听表，
 * 交给 assertLoopbackOnlyPort 断言回环端口没有暴露到公网。
 */
const readServiceListeners = async (
  sessionId: string,
  services: readonly string[],
  privilege: string,
  signal: AbortSignal,
): Promise<string> =>
  executeSshCommand(
    sessionId,
    `${privilege}systemctl is-active ${services.join(" ")} && ${privilege}ss -ltnH`,
    { timeoutMs: 30_000, signal },
  );

/** 回环端口必须且只能监听 127.0.0.1；出现在 0.0.0.0、[::] 或 * 上即判部署失败。 */
const assertLoopbackOnlyPort = (
  listenCheck: string,
  remotePort: number,
): void => {
  if (
    !new RegExp(`127\\.0\\.0\\.1:${remotePort}\\b`).test(listenCheck) ||
    new RegExp(`(?:0\\.0\\.0\\.0|\\[::\\]|\\*):${remotePort}\\b`).test(
      listenCheck,
    )
  ) {
    throw new Error(
      `服务器端口检查失败：${remotePort} 必须且只能监听 127.0.0.1`,
    );
  }
};

/** 服务器端 SSH2 元数据文件路径（由 install-ssh2.sh 生成）。 */
const SSH2_METADATA_PATH = "/root/snow-remote-ssh2.json";

type Ssh2ServerMetadata = {
  schemaVersion: 1;
  kind: "snow-remote-ssh2-server";
  publicDomain: string;
  username: string;
  tunnelPort: number;
  remotePort: number;
  hostKeyType: string;
  hostKeyPublicKey: string;
  hostKeyFingerprint: string;
  caddy: { present: boolean; upstreamPort: number | null };
};

const parseSsh2ServerMetadata = (bytes: Buffer): Ssh2ServerMetadata => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("服务器返回的 SSH2 元数据不是有效 JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("服务器返回的 SSH2 元数据字段不完整");
  }
  const record = parsed as Record<string, unknown>;
  const caddy = (record.caddy ?? {}) as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    record.kind !== "snow-remote-ssh2-server" ||
    typeof record.publicDomain !== "string" ||
    typeof record.username !== "string" ||
    typeof record.tunnelPort !== "number" ||
    typeof record.remotePort !== "number" ||
    typeof record.hostKeyType !== "string" ||
    typeof record.hostKeyPublicKey !== "string" ||
    typeof record.hostKeyFingerprint !== "string"
  ) {
    throw new Error("服务器返回的 SSH2 元数据字段不完整");
  }
  return {
    schemaVersion: 1,
    kind: "snow-remote-ssh2-server",
    publicDomain: record.publicDomain,
    username: record.username,
    tunnelPort: record.tunnelPort,
    remotePort: record.remotePort,
    hostKeyType: record.hostKeyType,
    hostKeyPublicKey: record.hostKeyPublicKey,
    hostKeyFingerprint: record.hostKeyFingerprint,
    caddy: {
      present: Boolean(caddy.present),
      upstreamPort:
        typeof caddy.upstreamPort === "number" ? caddy.upstreamPort : null,
    },
  };
};

/**
 * 直接以 HTTPS 访问手机入口 /health，确认公网链路可达（期望未配对 401）。
 * 首次部署时 Caddy 需要现场向 ACME 申请证书（十秒量级），
 * 单次请求必然失败，因此在窗口内重试，只有持续不可达才判定部署失败。
 */
const PUBLIC_PROBE_WINDOW_MS = 90_000;
const PUBLIC_PROBE_TIMEOUT_MS = 15_000;
const PUBLIC_PROBE_INTERVAL_MS = 2_000;

const probePublicHealth = async (origin: string): Promise<boolean> => {
  const deadline = Date.now() + PUBLIC_PROBE_WINDOW_MS;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PUBLIC_PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(`${origin}/health`, {
        method: "GET",
        redirect: "manual",
        cache: "no-store",
        signal: controller.signal,
      });
      if (response.status === 401) {
        return true;
      }
    } catch {
      // 证书签发、上游就绪都可能需要时间：继续重试直到窗口结束。
    } finally {
      clearTimeout(timer);
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, PUBLIC_PROBE_INTERVAL_MS),
    );
  }
};

const privilegeFor = (useSudo: boolean): string => (useSudo ? "sudo -n " : "");

/**
 * SSH2 部署：安装受限隧道服务 → 候选端口验证 → 切换 Caddy 上游 → 保存配置。
 * 任一步失败都会尽力回滚 Caddy 上游与本机隧道配置。
 */
const deploySsh2RemoteServer = async (
  input: NormalizedRemoteServerDeployInput,
  onProgress: (progress: RemoteServerDeployProgress) => void,
  controller: AbortController,
): Promise<RemoteServerDeployResult> => {
  let sessionId: string | null = null;
  let remoteScriptPath = "";
  let pubkeyPath = "";
  let useSudo = false;
  let completed = false;
  let savedNew = false;
  let switched = false;
  let authorizationReplaced = false;
  let previousUpstream: number | null = null;
  const previousStored = loadStoredRemoteTunnelConfig();
  const report = (stage: RemoteServerDeployStage, message: string): void =>
    onProgress({ stage, message });

  try {
    report("checking_dns", "正在检查域名解析");
    const dns = await checkRemoteServerDns({
      serverIp: input.serverIp,
      rootDomain: input.rootDomain,
    });
    if (!dns.ready) {
      const missing = dns.records
        .filter((record) => !record.ready)
        .map((record) => `${record.name} → ${record.expectedValue}`)
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

    report("checking_server", "正在检查发行版、架构和管理员权限");
    const preflight = parseRemotePreflight(
      await executeSshCommand(sessionId, preflightCommand, {
        timeoutMs: 30_000,
        signal: controller.signal,
      }),
    );
    useSudo = preflight.useSudo;
    const privilege = privilegeFor(useSudo);

    const keyPair = generateSsh2TunnelKeyPair();
    const suffix = randomBytes(12).toString("hex");
    remoteScriptPath = `/tmp/snow-ssh2-install-${suffix}.sh`;
    pubkeyPath = `/tmp/snow-ssh2-key-${suffix}.pub`;
    report("uploading", "正在上传 SSH2 隧道部署程序与专用公钥");
    const script = await readFile(deploymentScriptPath("install-ssh2.sh"));
    await writeInternalSshFile(sessionId, remoteScriptPath, script, {
      signal: controller.signal,
      expectedVersion: { exists: false },
    });
    await writeInternalSshFile(
      sessionId,
      pubkeyPath,
      Buffer.from(`${keyPair.publicKey}\n`, "utf8"),
      { signal: controller.signal, expectedVersion: { exists: false } },
    );

    report("installing", "正在安装受限 SSH 隧道服务，通常需要 1–4 分钟");
    await executeSshCommand(
      sessionId,
      `chmod 600 ${shellQuote(pubkeyPath)} && chmod 700 ${shellQuote(
        remoteScriptPath,
      )} && ${buildSsh2InstallCommand(
        remoteScriptPath,
        {
          publicDomain: input.publicDomain,
          tunnelPort: input.ssh2TunnelPort,
          remotePort: input.ssh2RemotePort,
          pubkeyPath,
        },
        useSudo,
      )}`,
      { timeoutMs: 10 * 60_000, signal: controller.signal },
    );
    // 安装成功即代表服务器 authorized_keys 已替换为本机新公钥。
    authorizationReplaced = true;

    report("importing", "正在读取服务器隧道信息；不会生成本机明文文件");
    const metadataBytes = useSudo
      ? Buffer.from(
          await executeSshCommand(
            sessionId,
            `${privilege}cat ${SSH2_METADATA_PATH}`,
            { timeoutMs: 30_000, signal: controller.signal },
          ),
          "utf8",
        )
      : await readSshFile(sessionId, SSH2_METADATA_PATH, {
          signal: controller.signal,
        });
    if (metadataBytes.length > 96 * 1024) {
      throw new Error("服务器返回的 SSH2 元数据长度异常，已拒绝导入");
    }
    const metadata = parseSsh2ServerMetadata(metadataBytes);
    if (
      metadata.publicDomain !== input.publicDomain ||
      metadata.tunnelPort !== input.ssh2TunnelPort ||
      metadata.remotePort !== input.ssh2RemotePort
    ) {
      throw new Error("服务器返回的 SSH2 元数据与本次部署参数不一致，已停止");
    }
    previousUpstream = metadata.caddy.upstreamPort;

    const configInput: RemoteTunnelConfigInput = {
      enabled: true,
      autoConnect: true,
      publicOrigin: `https://${input.publicDomain}`,
      ssh2: {
        serverAddr: input.serverIp,
        serverPort: input.ssh2TunnelPort,
        username: metadata.username,
        remotePort: input.ssh2RemotePort,
        hostKeyType: metadata.hostKeyType,
        hostKeyPublicKey: metadata.hostKeyPublicKey,
        hostKeyFingerprint: metadata.hostKeyFingerprint,
        privateKey: keyPair.privateKey,
      },
    };

    report("verifying", "正在建立 SSH2 隧道并验证转发");
    const tunnel = await remoteTunnelManager.connectTransient(configInput);
    if (tunnel.stage === "failed" || tunnel.listenerPort < 1) {
      throw new Error(
        tunnel.error?.message ??
          "SSH2 隧道未能建立，请检查安全组与隧道服务状态",
      );
    }
    // 经服务器回环端口直查隧道转发（不经过 Caddy），确认反向隧道已把请求送到本机。
    const candidate = (
      await executeSshCommand(
        sessionId,
        `${privilege}curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -H ${shellQuote(
          `Host: ${input.publicDomain}`,
        )} http://127.0.0.1:${input.ssh2RemotePort}/health`,
        { timeoutMs: 30_000, signal: controller.signal },
      )
    ).trim();
    if (candidate !== "401") {
      throw new Error(
        `SSH2 隧道已建立，但服务器回环端口返回 ${
          candidate || "无响应"
        }；预期为未配对的 401`,
      );
    }

    // 确认受限 sshd 与 Caddy 正在运行，且回环端口没有暴露到公网。
    const listenCheck = await readServiceListeners(
      sessionId,
      ["snow-tunnel-sshd.service", "snow-caddy.service"],
      privilege,
      controller.signal,
    );
    assertLoopbackOnlyPort(listenCheck, input.ssh2RemotePort);

    report("verifying", "正在切换 HTTPS 入口到 SSH2 隧道");
    await executeSshCommand(
      sessionId,
      buildSsh2SwitchUpstreamCommand(
        remoteScriptPath,
        { publicDomain: input.publicDomain, port: input.ssh2RemotePort },
        useSudo,
      ),
      { timeoutMs: 10 * 60_000, signal: controller.signal },
    );
    switched =
      previousUpstream !== null && previousUpstream !== input.ssh2RemotePort;

    if (!(await probePublicHealth(`https://${input.publicDomain}`))) {
      throw new Error("HTTPS 入口切换后公网探测失败，正在回滚到原有隧道");
    }

    await remoteTunnelManager.save(configInput);
    savedNew = true;
    const status = await remoteTunnelManager.probeEndpointNow();
    if (status.stage !== "online" || status.endpoint.stage !== "reachable") {
      throw new Error(
        status.error?.message ?? "SSH2 隧道已切换，但公网入口验证未通过",
      );
    }

    report("completed", "SSH2 公网远控部署完成，可以扫描公网二维码");
    completed = true;
    return { dns, tunnel: status };
  } finally {
    if (!completed) {
      // 回滚顺序：恢复 Caddy 上游 → 恢复旧设备公钥授权 → 恢复本机隧道配置。
      if (switched && previousUpstream !== null && sessionId) {
        try {
          await executeSshCommand(
            sessionId,
            buildSsh2SwitchUpstreamCommand(
              remoteScriptPath,
              { publicDomain: input.publicDomain, port: previousUpstream },
              useSudo,
            ),
            { timeoutMs: 60_000 },
          );
        } catch {
          // 回滚失败时保留现状；用户可按教程手动恢复。
        }
      }
      if (authorizationReplaced && previousStored?.ssh2 && sessionId) {
        const previousPublicKey = publicKeyFromPrivateKey(
          previousStored.ssh2.privateKey,
        );
        if (previousPublicKey) {
          try {
            await executeSshCommand(
              sessionId,
              `${privilegeFor(
                useSudo,
              )}printf '%s\\n' ${shellQuote(previousPublicKey)} > ${shellQuote(
                pubkeyPath,
              )}`,
              { timeoutMs: 30_000 },
            );
            await executeSshCommand(
              sessionId,
              buildSsh2InstallCommand(
                remoteScriptPath,
                {
                  publicDomain: input.publicDomain,
                  tunnelPort: previousStored.ssh2.serverPort,
                  remotePort: previousStored.ssh2.remotePort,
                  pubkeyPath,
                },
                useSudo,
              ),
              { timeoutMs: 5 * 60_000 },
            );
          } catch {
            // 尽力恢复旧公钥授权；失败时提示用户重新部署。
          }
        }
      }
      if (previousStored) {
        if (savedNew) {
          await remoteTunnelManager
            .save(toRemoteTunnelConfigInput(previousStored))
            .catch(() => undefined);
        }
        await remoteTunnelManager.disconnect().catch(() => undefined);
        if (previousStored.enabled) {
          await remoteTunnelManager.connect().catch(() => undefined);
        }
      } else {
        await remoteTunnelManager.disconnect().catch(() => undefined);
        if (savedNew) deleteStoredRemoteTunnelConfig();
      }
    }
    if (sessionId) {
      const privilege = privilegeFor(useSudo);
      const paths = [remoteScriptPath, pubkeyPath, SSH2_METADATA_PATH].filter(
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
          // 尽力清理临时文件；失败不影响部署结果。
        }
      }
      disconnectSsh(sessionId);
    }
  }
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
  try {
    return await deploySsh2RemoteServer(input, onProgress, controller);
  } finally {
    if (activeDeployment === controller) activeDeployment = null;
  }
};
