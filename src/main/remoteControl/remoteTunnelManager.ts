import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  loadStoredRemoteTunnelConfig,
  saveRemoteTunnelConfig,
  toRemoteTunnelConfigView,
} from "./remoteTunnelConfig";
import {
  isPermanentFrpcFailure,
  normalizeRemoteTunnelConfig,
  redactTunnelText,
  renderFrpcConfig,
  type RemoteTunnelConfigInput,
  type RemoteTunnelConfigView,
  type StoredRemoteTunnelConfig,
} from "./remoteTunnelSchema";
import {
  getRemoteControlPairingState,
  startRemoteWanListener,
  stopRemoteWanListener,
} from "./remoteControlServer";

export type RemoteTunnelStage =
  "stopped" | "starting" | "connecting" | "online" | "reconnecting" | "failed";

export type RemoteTunnelEndpointStage =
  "unchecked" | "checking" | "reachable" | "failed";

export type RemoteTunnelStatus = {
  config: RemoteTunnelConfigView;
  stage: RemoteTunnelStage;
  listenerPort: number;
  attempt: number;
  nextRetryAt: number | null;
  endpoint: {
    stage: RemoteTunnelEndpointStage;
    checkedAt: number | null;
  };
  error: { code: string; message: string } | null;
};

type FrpcManifest = {
  version: string;
  executable: { file: string; sha256: string; size: number };
};

const VERIFY_TIMEOUT_MS = 10_000;
const ENDPOINT_TIMEOUT_MS = 5_000;
const ENDPOINT_MONITOR_INTERVAL_MS = 30_000;
const MAX_LOG_TAIL = 8_000;

const restrictPermissions = (path: string): void => {
  try {
    chmodSync(path, 0o600);
  } catch {
    // safeStorage protects persisted secrets; runtime files are also short-lived.
  }
};

const waitForExit = async (
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> => {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
};

const publicError = (
  code: string,
  message: string,
): { code: string; message: string } => ({
  code,
  message,
});

export class RemoteTunnelManager {
  private child: ChildProcess | null = null;
  private runtimeDir: string | null = null;
  private generation = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private endpointMonitorTimer: ReturnType<typeof setTimeout> | null = null;
  private endpointFailureCount = 0;
  private logTail = "";
  private operation: Promise<void> = Promise.resolve();
  private status: Omit<RemoteTunnelStatus, "config"> = {
    stage: "stopped",
    listenerPort: 0,
    attempt: 0,
    nextRetryAt: null,
    endpoint: { stage: "unchecked", checkedAt: null },
    error: null,
  };
  private verifiedBinaryPath: string | null = null;

  getStatus(): RemoteTunnelStatus {
    let stored: StoredRemoteTunnelConfig | null = null;
    let configError: Error | null = null;
    try {
      stored = loadStoredRemoteTunnelConfig();
    } catch (error) {
      configError = error instanceof Error ? error : new Error(String(error));
    }
    return {
      config: toRemoteTunnelConfigView(stored),
      ...this.status,
      error:
        this.status.error ??
        (configError
          ? publicError("CONFIG_READ_FAILED", configError.message)
          : null),
    };
  }

  async save(input: RemoteTunnelConfigInput): Promise<RemoteTunnelStatus> {
    await saveRemoteTunnelConfig(input);
    if (!input.enabled && this.status.stage !== "stopped") {
      await this.disconnect();
    }
    return this.getStatus();
  }

  async initialize(): Promise<void> {
    const config = loadStoredRemoteTunnelConfig();
    if (config?.enabled && config.autoConnect) {
      await this.connect();
    }
  }

  async connect(): Promise<RemoteTunnelStatus> {
    await this.enqueue(async () => {
      await this.disconnectInternal(false);
      const config = loadStoredRemoteTunnelConfig();
      if (!config?.enabled) {
        throw new Error("请先保存并启用自建服务器配置");
      }
      const generation = ++this.generation;
      this.status = {
        stage: "starting",
        listenerPort: 0,
        attempt: 0,
        nextRetryAt: null,
        endpoint: { stage: "unchecked", checkedAt: null },
        error: null,
      };
      await this.startAttempt(config, generation, 0);
    });
    return this.getStatus();
  }

  /** Connect using credentials held only in memory; persistence is explicit. */
  async connectTransient(
    input: RemoteTunnelConfigInput,
  ): Promise<RemoteTunnelStatus> {
    const config = normalizeRemoteTunnelConfig(input, null);
    await this.enqueue(async () => {
      await this.disconnectInternal(false);
      const generation = ++this.generation;
      this.status = {
        stage: "starting",
        listenerPort: 0,
        attempt: 0,
        nextRetryAt: null,
        endpoint: { stage: "unchecked", checkedAt: null },
        error: null,
      };
      await this.startAttempt(config, generation, 0);
    });
    return {
      ...this.getStatus(),
      config: toRemoteTunnelConfigView(config),
    };
  }

  async disconnect(): Promise<RemoteTunnelStatus> {
    await this.enqueue(() => this.disconnectInternal(true));
    return this.getStatus();
  }

  async shutdown(): Promise<void> {
    await this.enqueue(() => this.disconnectInternal(true));
  }

  async reconnectAfterSystemResume(): Promise<void> {
    const config = loadStoredRemoteTunnelConfig();
    if (
      !config?.enabled ||
      this.status.stage === "stopped" ||
      this.status.error?.code === "AUTH_OR_CERTIFICATE_FAILED"
    ) {
      return;
    }
    await this.connect();
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.operation.then(operation, operation);
    this.operation = next.catch(() => undefined);
    return next;
  }

  private resolveBundle(): { executable: string; manifest: FrpcManifest } {
    const root = app.isPackaged
      ? join(
          process.resourcesPath,
          "remote-control",
          "frp",
          "win32-x64",
        )
      : join(
          app.getAppPath(),
          "resources",
          "remote-control",
          "frp",
          "win32-x64",
        );
    const manifestPath = join(root, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new Error("安装包缺少 frpc 版本清单");
    }
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as FrpcManifest;
    const executable = join(root, manifest.executable.file);
    if (!existsSync(executable)) {
      throw new Error("安装包缺少 frpc.exe");
    }
    if (this.verifiedBinaryPath !== executable) {
      const bytes = readFileSync(executable);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (
        bytes.length !== manifest.executable.size ||
        digest !== manifest.executable.sha256
      ) {
        throw new Error("frpc.exe 完整性校验失败");
      }
      this.verifiedBinaryPath = executable;
    }
    return { executable, manifest };
  }

  private prepareRuntime(
    config: StoredRemoteTunnelConfig,
    localPort: number,
  ): { configFile: string; executable: string } {
    const { executable } = this.resolveBundle();
    const dir = join(
      app.getPath("userData"),
      "remote-control",
      `runtime-${process.pid}-${randomBytes(6).toString("hex")}`,
    );
    mkdirSync(dir, { recursive: true });
    const tokenFile = join(dir, "token.txt");
    const caFile = join(dir, "ca.crt");
    const configFile = join(dir, "frpc.toml");
    writeFileSync(tokenFile, config.token, { mode: 0o600 });
    writeFileSync(caFile, config.caCertificate, { mode: 0o600 });
    writeFileSync(
      configFile,
      renderFrpcConfig(config, { tokenFile, caFile, localPort }),
      { mode: 0o600 },
    );
    for (const path of [tokenFile, caFile, configFile])
      restrictPermissions(path);
    this.runtimeDir = dir;
    return { configFile, executable };
  }

  private async verifyFrpc(
    executable: string,
    configFile: string,
  ): Promise<void> {
    const child = spawn(executable, ["verify", "-c", configFile], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output = (output + String(chunk)).slice(-MAX_LOG_TAIL);
    });
    child.stderr?.on("data", (chunk) => {
      output = (output + String(chunk)).slice(-MAX_LOG_TAIL);
    });
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("frpc 配置校验超时"));
      }, VERIFY_TIMEOUT_MS);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    if (exitCode !== 0) {
      throw new Error(`frpc 配置校验失败：${redactTunnelText(output)}`);
    }
  }

  private async startAttempt(
    config: StoredRemoteTunnelConfig,
    generation: number,
    attempt: number,
  ): Promise<void> {
    if (generation !== this.generation) return;
    this.status.stage = attempt === 0 ? "starting" : "reconnecting";
    this.status.attempt = attempt;
    this.status.nextRetryAt = null;
    this.status.error = null;
    try {
      const pairing = await startRemoteWanListener(config.publicOrigin, 0);
      const localPort = pairing.wan.localPort;
      this.status.listenerPort = localPort;
      const runtime = this.prepareRuntime(config, localPort);
      await this.verifyFrpc(runtime.executable, runtime.configFile);
      if (generation !== this.generation) return;
      this.status.stage = "connecting";
      this.logTail = "";
      const child = spawn(runtime.executable, ["-c", runtime.configFile], {
        shell: false,
        windowsHide: true,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.child = child;
      const collect = (chunk: unknown): void => {
        this.logTail = redactTunnelText(this.logTail + String(chunk));
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.once("error", (error) => {
        collect(error.message);
      });
      child.once("exit", () => {
        if (this.child === child) this.child = null;
        void this.handleUnexpectedExit(config, generation, attempt);
      });
      await this.probeEndpoint(config.publicOrigin, generation);
    } catch (error) {
      const message = redactTunnelText(
        error instanceof Error ? error.message : String(error),
      );
      await this.cleanupRuntime();
      await stopRemoteWanListener();
      this.status.stage = "failed";
      this.status.endpoint = { stage: "failed", checkedAt: Date.now() };
      this.status.error = publicError("CONNECT_FAILED", message);
      throw error;
    }
  }

  private async probeEndpoint(
    origin: string,
    generation: number,
  ): Promise<void> {
    this.status.endpoint = { stage: "checking", checkedAt: null };
    const deadline = Date.now() + 20_000;
    while (
      generation === this.generation &&
      this.child &&
      Date.now() < deadline
    ) {
      if (await this.isEndpointReachable(origin)) {
        this.status.stage = "online";
        this.status.endpoint = { stage: "reachable", checkedAt: Date.now() };
        this.status.error = null;
        this.endpointFailureCount = 0;
        this.scheduleEndpointMonitor(origin, generation);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (generation === this.generation && this.child) {
      this.status.endpoint = { stage: "failed", checkedAt: Date.now() };
      this.status.error = publicError(
        "ENDPOINT_UNREACHABLE",
        "隧道进程已启动，但 HTTPS 公网入口尚不可达",
      );
    }
  }

  private async isEndpointReachable(origin: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ENDPOINT_TIMEOUT_MS);
    try {
      const response = await fetch(`${origin}/health`, {
        method: "GET",
        redirect: "manual",
        cache: "no-store",
        signal: controller.signal,
      });
      return response.status === 401;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private scheduleEndpointMonitor(origin: string, generation: number): void {
    this.clearEndpointMonitor();
    this.endpointMonitorTimer = setTimeout(() => {
      this.endpointMonitorTimer = null;
      void (async () => {
        if (generation !== this.generation || !this.child) return;
        if (await this.isEndpointReachable(origin)) {
          this.endpointFailureCount = 0;
          this.status.stage = "online";
          this.status.endpoint = { stage: "reachable", checkedAt: Date.now() };
          this.status.error = null;
          this.scheduleEndpointMonitor(origin, generation);
          return;
        }
        this.endpointFailureCount += 1;
        this.status.endpoint = { stage: "failed", checkedAt: Date.now() };
        this.status.error = publicError(
          "ENDPOINT_UNREACHABLE",
          "公网 HTTPS 入口连续探测失败，正在确认是否需要重连",
        );
        if (this.endpointFailureCount >= 2) {
          this.child?.kill();
          return;
        }
        this.scheduleEndpointMonitor(origin, generation);
      })();
    }, ENDPOINT_MONITOR_INTERVAL_MS);
  }

  private clearEndpointMonitor(): void {
    if (this.endpointMonitorTimer) {
      clearTimeout(this.endpointMonitorTimer);
      this.endpointMonitorTimer = null;
    }
    this.endpointFailureCount = 0;
  }

  private async handleUnexpectedExit(
    config: StoredRemoteTunnelConfig,
    generation: number,
    attempt: number,
  ): Promise<void> {
    if (generation !== this.generation) return;
    this.clearEndpointMonitor();
    await this.cleanupRuntime();
    const permanent = isPermanentFrpcFailure(this.logTail);
    if (permanent || !config.enabled) {
      await stopRemoteWanListener();
      this.status.stage = "failed";
      this.status.error = publicError(
        permanent ? "AUTH_OR_CERTIFICATE_FAILED" : "TUNNEL_EXITED",
        permanent
          ? "FRP 身份验证或服务器证书校验失败，请检查配置"
          : "FRP 隧道已退出",
      );
      return;
    }
    const nextAttempt = attempt + 1;
    const base = Math.min(60_000, 1_000 * 2 ** Math.min(nextAttempt, 6));
    const delay = base + Math.floor(Math.random() * Math.max(250, base * 0.2));
    this.status.stage = "reconnecting";
    this.status.attempt = nextAttempt;
    this.status.nextRetryAt = Date.now() + delay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.startAttempt(config, generation, nextAttempt).catch(
        () => undefined,
      );
    }, delay);
  }

  private async disconnectInternal(
    incrementGeneration: boolean,
  ): Promise<void> {
    if (incrementGeneration) this.generation += 1;
    this.clearEndpointMonitor();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      child.kill();
      await waitForExit(child, 5_000);
      if (child.exitCode === null && child.pid) {
        const killer = spawn(
          "taskkill.exe",
          ["/PID", String(child.pid), "/T", "/F"],
          {
            shell: false,
            windowsHide: true,
            stdio: "ignore",
          },
        );
        await new Promise<void>((resolve) =>
          killer.once("exit", () => resolve()),
        );
      }
    }
    await this.cleanupRuntime();
    await stopRemoteWanListener();
    this.status = {
      stage: "stopped",
      listenerPort: 0,
      attempt: 0,
      nextRetryAt: null,
      endpoint: { stage: "unchecked", checkedAt: null },
      error: null,
    };
  }

  private async cleanupRuntime(): Promise<void> {
    const dir = this.runtimeDir;
    this.runtimeDir = null;
    if (!dir) return;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A later startup uses a fresh random directory; never reuse stale secrets.
    }
  }
}

export const remoteTunnelManager = new RemoteTunnelManager();
