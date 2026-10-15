import { app } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  deleteStoredRemoteTunnelConfig,
  loadStoredRemoteTunnelConfig,
  saveRemoteTunnelConfig,
  toRemoteTunnelConfigView,
} from "./remoteTunnelConfig";
import {
  isPermanentFrpcFailure,
  isPermanentSsh2Failure,
  normalizeRemoteTunnelConfig,
  redactTunnelText,
  renderFrpcConfig,
  type FrpTransportConfig,
  type RemoteTunnelConfigInput,
  type RemoteTunnelConfigView,
  type StoredRemoteTunnelConfig,
} from "./remoteTunnelSchema";
import {
  startRemoteWanListener,
  stopRemoteWanListener,
} from "./remoteControlServer";
import { probeRemoteTunnelTls } from "./remoteTunnelProbe";
import {
  Ssh2TunnelTransport,
  type Ssh2TransportCloseInfo,
} from "./ssh2TunnelTransport";

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
  frpc: { present: boolean; dir: string };
};

type FrpcManifest = {
  version: string;
  executable: { file: string; sha256: string; size: number };
};

type FrpcBundleFailureCode = "FRPC_FILE_MISSING" | "FRPC_FILE_TAMPERED";

class FrpcBundleError extends Error {
  readonly code: FrpcBundleFailureCode;

  constructor(code: FrpcBundleFailureCode, message: string) {
    super(message);
    this.code = code;
  }
}

const VERIFY_TIMEOUT_MS = 10_000;
const ENDPOINT_TIMEOUT_MS = 5_000;
const ENDPOINT_MONITOR_INTERVAL_MS = 30_000;
/** 首次探测窗口内未通过时的复查间隔，之后回到常规监控间隔。 */
const ENDPOINT_FIRST_RETRY_MS = 10_000;
/** 启动自动连接失败后的退避重试延迟（网络 / DNS 尚未就绪等临时故障）。 */
const STARTUP_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];
const MAX_LOG_TAIL = 8_000;
const PROXY_ENV_KEYS = [
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "all_proxy",
  "ALL_PROXY",
] as const;
/** 安装包内的 frpc 目录与资源名后缀，例如 win32-x64、darwin-arm64。 */
const FRPC_PLATFORM_DIRECTORY = `${process.platform}-${process.arch}`;

const frpcEnvironment = (): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of PROXY_ENV_KEYS) {
    delete env[key];
  }
  return env;
};

const restrictPermissions = (path: string): void => {
  try {
    chmodSync(path, 0o600);
  } catch {
    // safeStorage protects persisted secrets; runtime files are also short-lived.
  }
};

/** 二进制的内容与长度都必须与版本清单一致才允许执行。 */
const matchesFrpcDigest = (path: string, manifest: FrpcManifest): boolean => {
  if (!existsSync(path)) return false;
  const bytes = readFileSync(path);
  return (
    bytes.length === manifest.executable.size &&
    createHash("sha256").update(bytes).digest("hex") ===
      manifest.executable.sha256
  );
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

/** frpc 退出前一直占用隧道端口，普通结束信号无效时必须按平台强制终止。 */
const forceKill = async (pid: number): Promise<void> => {
  if (process.platform !== "win32") {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 进程可能已经退出，重复终止不是错误。
    }
    return;
  }
  const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
  await new Promise<void>((resolve) => {
    killer.once("error", () => resolve());
    killer.once("exit", () => resolve());
  });
};

const publicError = (
  code: string,
  message: string,
): { code: string; message: string } => ({
  code,
  message,
});

const FRPC_SPAWN_BLOCKED_CODES = ["EPERM", "EACCES", "EBUSY"];

const isFrpcSpawnBlocked = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && FRPC_SPAWN_BLOCKED_CODES.includes(code);
};

const FAILURE_DETAIL_MAX = 240;
const FAILURE_DETAIL_HINT =
  /(error|fail|x509|token|certificate|tls|refused|timeout|timed out|unreachable|denied|reject)/i;

const extractFrpcFailureDetail = (
  value: string,
  fallback = false,
): string | null => {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const picked =
    [...lines].reverse().find((line) => FAILURE_DETAIL_HINT.test(line)) ??
    (fallback ? lines[lines.length - 1] : null);
  if (!picked) return null;
  const collapsed = picked.replace(/\s+/g, " ");
  return collapsed.length > FAILURE_DETAIL_MAX
    ? `${collapsed.slice(0, FAILURE_DETAIL_MAX)}…`
    : collapsed;
};

const withDetail = (message: string, detail: string | null): string =>
  detail ? `${message}（${detail}）` : message;

export class RemoteTunnelManager {
  private child: ChildProcess | null = null;
  private runtimeDir: string | null = null;
  private generation = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private endpointMonitorTimer: ReturnType<typeof setTimeout> | null = null;
  private endpointFailureCount = 0;
  /**
   * 部署期的临时隧道标记：connectTransient 建立候选隧道后，公网入口还没切换好，
   * 此时端点探测失败属于预期，绝不能据此拆除正在使用的传输。
   */
  private transientDeploy = false;
  private logTail = "";
  private exitHandling: Promise<void> | null = null;
  private operation: Promise<void> = Promise.resolve();
  private status: Omit<RemoteTunnelStatus, "config" | "frpc"> = {
    stage: "stopped",
    listenerPort: 0,
    attempt: 0,
    nextRetryAt: null,
    endpoint: { stage: "unchecked", checkedAt: null },
    error: null,
  };
  private verifiedBinaryPath: string | null = null;
  private startupAttempts = 0;
  private ssh2Transport: Ssh2TunnelTransport | null = null;
  private activeConfig: StoredRemoteTunnelConfig | null = null;

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
      frpc: this.describeFrpcBundle(),
      error:
        this.status.error ??
        (configError
          ? publicError("CONFIG_READ_FAILED", configError.message)
          : null),
    };
  }

  async save(input: RemoteTunnelConfigInput): Promise<RemoteTunnelStatus> {
    // 配置一旦落盘，部署期的临时隧道就成为正式隧道，端点监控恢复正常判定。
    this.transientDeploy = false;
    await saveRemoteTunnelConfig(input);
    if (!input.enabled && this.status.stage !== "stopped") {
      await this.disconnect();
    }
    return this.getStatus();
  }

  async initialize(): Promise<void> {
    const config = loadStoredRemoteTunnelConfig();
    if (config?.enabled && config.autoConnect) {
      this.startupAttempts = 0;
      await this.connectWithStartupRetry();
    }
  }

  /**
   * 启动自动连接：系统刚开机时网络、DNS 可能尚未就绪，首次失败按退避重试；
   * 凭据或证书类永久失败直接透出，避免无意义重试。
   */
  private async connectWithStartupRetry(): Promise<void> {
    try {
      await this.connect();
      this.startupAttempts = 0;
    } catch (error) {
      const message = redactTunnelText(
        error instanceof Error ? error.message : String(error),
      );
      if (
        error instanceof FrpcBundleError ||
        isPermanentFrpcFailure(message) ||
        isPermanentSsh2Failure(message)
      ) {
        throw error;
      }
      const delay = STARTUP_RETRY_DELAYS_MS[this.startupAttempts];
      if (delay === undefined) throw error;
      this.startupAttempts += 1;
      this.status.stage = "reconnecting";
      this.status.attempt = this.startupAttempts;
      this.status.nextRetryAt = Date.now() + delay;
      this.status.error = publicError(
        "CONNECT_RETRY",
        `${message}；${Math.round(delay / 1_000)} 秒后自动重试`,
      );
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        void this.connectWithStartupRetry().catch(() => undefined);
      }, delay);
    }
  }

  async connect(): Promise<RemoteTunnelStatus> {
    // 正式连接取代任何部署期的临时隧道。
    this.transientDeploy = false;
    await this.enqueue(async () => {
      const generation = ++this.generation;
      await this.disconnectInternal();
      const config = loadStoredRemoteTunnelConfig();
      if (!config?.enabled) {
        throw new Error("请先保存并启用自建服务器配置");
      }
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
    this.transientDeploy = true;
    try {
      await this.enqueue(async () => {
        const generation = ++this.generation;
        await this.disconnectInternal();
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
    } catch (error) {
      // 候选隧道没能建立：退出部署期，交由部署器按失败流程处理。
      this.transientDeploy = false;
      throw error;
    }
    return {
      ...this.getStatus(),
      config: toRemoteTunnelConfigView(config),
    };
  }

  async disconnect(): Promise<RemoteTunnelStatus> {
    // 主动断开即结束部署期，避免标记残留影响后续正常连接的端点监控。
    this.transientDeploy = false;
    await this.enqueue(async () => {
      this.generation += 1;
      await this.disconnectInternal();
    });
    return this.getStatus();
  }

  /** 移除本机保存的公网配置：先断开隧道，再删除加密的 FRP 凭据与 CA 证书。 */
  async remove(): Promise<RemoteTunnelStatus> {
    await this.enqueue(async () => {
      this.generation += 1;
      await this.disconnectInternal();
      deleteStoredRemoteTunnelConfig();
    });
    return this.getStatus();
  }

  async shutdown(): Promise<void> {
    await this.enqueue(async () => {
      this.generation += 1;
      await this.disconnectInternal();
    });
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

  private resolveFrpcRoot(): string {
    return app.isPackaged
      ? join(
          process.resourcesPath,
          "remote-control",
          "frp",
          FRPC_PLATFORM_DIRECTORY,
        )
      : join(
          app.getAppPath(),
          "resources",
          "remote-control",
          "frp",
          FRPC_PLATFORM_DIRECTORY,
        );
  }

  private describeFrpcBundle(): { present: boolean; dir: string } {
    const root = this.resolveFrpcRoot();
    try {
      const manifest = JSON.parse(
        readFileSync(join(root, "manifest.json"), "utf8"),
      ) as FrpcManifest;
      return {
        present: existsSync(join(root, manifest.executable.file)),
        dir: root,
      };
    } catch {
      return { present: false, dir: root };
    }
  }

  private resolveBundle(): { executable: string; manifest: FrpcManifest } {
    const root = this.resolveFrpcRoot();
    const manifestPath = join(root, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new Error(
        `安装包缺少 ${FRPC_PLATFORM_DIRECTORY} 平台的 frpc 版本清单`,
      );
    }
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8"),
    ) as FrpcManifest;
    const bundled = join(root, manifest.executable.file);
    if (!existsSync(bundled)) {
      throw new FrpcBundleError(
        "FRPC_FILE_MISSING",
        `内置隧道组件 ${manifest.executable.file} 缺失，可能被杀毒软件删除或隔离`,
      );
    }
    if (
      this.verifiedBinaryPath !== bundled &&
      !matchesFrpcDigest(bundled, manifest)
    ) {
      throw new FrpcBundleError(
        "FRPC_FILE_TAMPERED",
        `内置隧道组件 ${manifest.executable.file} 完整性校验失败，可能被杀毒软件隔离或修改`,
      );
    }
    this.verifiedBinaryPath = bundled;
    return {
      executable: this.materializeExecutable(bundled, manifest),
      manifest,
    };
  }

  /**
   * POSIX 安装包内的二进制可能因 Git 检出、解压或只读挂载（如 AppImage）缺少
   * 可执行位，先复制到用户目录并补齐权限位再运行；Windows 直接使用安装包文件。
   */
  private materializeExecutable(
    bundled: string,
    manifest: FrpcManifest,
  ): string {
    if (process.platform === "win32") return bundled;
    const target = join(
      app.getPath("userData"),
      "remote-control",
      "frpc",
      `${FRPC_PLATFORM_DIRECTORY}-${manifest.executable.sha256.slice(0, 16)}`,
      manifest.executable.file,
    );
    try {
      if (!matchesFrpcDigest(target, manifest)) {
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(bundled, target);
        chmodSync(target, 0o700);
      }
      return target;
    } catch {
      return bundled;
    }
  }

  private prepareRuntime(
    frp: FrpTransportConfig,
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
    writeFileSync(tokenFile, frp.token, { mode: 0o600 });
    writeFileSync(caFile, frp.caCertificate, { mode: 0o600 });
    writeFileSync(
      configFile,
      renderFrpcConfig(frp, { tokenFile, caFile, localPort }),
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
    this.activeConfig = config;
    if (config.activeTransport === "ssh2") {
      await this.startSsh2Attempt(config, generation, attempt);
      return;
    }
    this.status.stage = attempt === 0 ? "starting" : "reconnecting";
    this.status.attempt = attempt;
    this.status.nextRetryAt = null;
    this.status.error = null;
    try {
      const frp = config.frp;
      if (!frp) throw new Error("缺少 FRP 隧道配置");
      if (attempt === 0) {
        await probeRemoteTunnelTls(frp);
        if (generation !== this.generation) return;
      }
      const pairing = await startRemoteWanListener(config.publicOrigin, 0);
      const localPort = pairing.wan.localPort;
      this.status.listenerPort = localPort;
      const runtime = this.prepareRuntime(frp, localPort);
      await this.verifyFrpc(runtime.executable, runtime.configFile);
      if (generation !== this.generation) return;
      this.status.stage = "connecting";
      this.logTail = "";
      this.exitHandling = null;
      const child = spawn(runtime.executable, ["-c", runtime.configFile], {
        shell: false,
        windowsHide: true,
        detached: false,
        env: frpcEnvironment(),
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
        this.exitHandling = this.handleUnexpectedExit(
          config,
          generation,
          attempt,
        ).catch(() => undefined);
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
      this.status.error =
        error instanceof FrpcBundleError
          ? { code: error.code, message }
          : isFrpcSpawnBlocked(error)
            ? publicError(
                "FRPC_FILE_BLOCKED",
                "内置隧道组件无法启动，可能被杀毒软件拦截",
              )
            : publicError("CONNECT_FAILED", message);
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
      this.hasActiveTransport() &&
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
    if (generation !== this.generation) return;
    if (!this.hasActiveTransport()) {
      await this.exitHandling;
      return;
    }
    this.status.endpoint = { stage: "failed", checkedAt: Date.now() };
    this.status.error = publicError(
      "ENDPOINT_UNREACHABLE",
      withDetail(
        "隧道进程已启动，但 HTTPS 公网入口尚不可达；Snow 会继续自动探测",
        extractFrpcFailureDetail(this.logTail),
      ),
    );
    // 应用刚启动时公网入口就绪可能更慢：继续自动探测，恢复可达即转在线，
    // 连续探测失败则由监控重启隧道，不需要用户手动断开重连。
    this.scheduleEndpointMonitor(origin, generation, ENDPOINT_FIRST_RETRY_MS);
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

  private scheduleEndpointMonitor(
    origin: string,
    generation: number,
    delayMs = ENDPOINT_MONITOR_INTERVAL_MS,
  ): void {
    this.clearEndpointMonitor();
    this.endpointMonitorTimer = setTimeout(() => {
      this.endpointMonitorTimer = null;
      void (async () => {
        if (generation !== this.generation || !this.hasActiveTransport())
          return;
        if (this.transientDeploy) {
          // 部署尚未完成：入口不可达是预期状态，只继续探测，不累计失败、不重启隧道。
          this.scheduleEndpointMonitor(origin, generation);
          return;
        }
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
          this.terminateTransport(generation);
          return;
        }
        this.scheduleEndpointMonitor(origin, generation);
      })();
    }, delayMs);
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
    const detail = extractFrpcFailureDetail(this.logTail, true);
    await this.cleanupRuntime();
    if (generation !== this.generation) return;
    const permanent = isPermanentFrpcFailure(this.logTail);
    if (permanent || !config.enabled) {
      const tlsRejected = /session shutdown/i.test(this.logTail);
      await stopRemoteWanListener();
      if (generation !== this.generation) return;
      this.status.stage = "failed";
      this.status.error = publicError(
        permanent ? "AUTH_OR_CERTIFICATE_FAILED" : "TUNNEL_EXITED",
        withDetail(
          permanent
            ? tlsRejected
              ? "FRP 服务端证书校验未通过，连接未能建立；请检查服务器证书、frp 域名解析与服务器时间"
              : "FRP 身份验证或服务器证书校验失败，请检查配置"
            : "FRP 隧道已退出",
          detail,
        ),
      );
      return;
    }
    const nextAttempt = attempt + 1;
    const base = Math.min(60_000, 1_000 * 2 ** Math.min(nextAttempt, 6));
    const delay = base + Math.floor(Math.random() * Math.max(250, base * 0.2));
    this.status.stage = "reconnecting";
    this.status.attempt = nextAttempt;
    this.status.nextRetryAt = Date.now() + delay;
    this.status.error = publicError(
      "TUNNEL_EXITED",
      withDetail("FRP 隧道已断开，正在重连", detail),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.startAttempt(config, generation, nextAttempt).catch(
        () => undefined,
      );
    }, delay);
  }

  /**
   * SSH2 反向隧道尝试：本机 WAN listener → 进程内 SSH2 传输 → 服务器回环端口。
   * 认证、主机密钥校验与反向监听申请全部完成后才开始公网探测。
   */
  private async startSsh2Attempt(
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
      const ssh2Config = config.ssh2;
      if (!ssh2Config) throw new Error("缺少 SSH2 隧道配置");
      if (!ssh2Config.privateKey) {
        throw new Error(
          "缺少 SSH2 隧道私钥，请使用“自动部署并连接”重新授权此设备",
        );
      }
      const pairing = await startRemoteWanListener(config.publicOrigin, 0);
      const localPort = pairing.wan.localPort;
      this.status.listenerPort = localPort;
      if (generation !== this.generation) return;
      this.status.stage = "connecting";
      this.exitHandling = null;
      const transport = new Ssh2TunnelTransport({
        host: ssh2Config.serverAddr,
        port: ssh2Config.serverPort,
        username: ssh2Config.username,
        privateKey: ssh2Config.privateKey,
        remoteBindPort: ssh2Config.remotePort,
        localTargetPort: localPort,
        expectedHostKey: {
          keyType: ssh2Config.hostKeyType,
          publicKey: ssh2Config.hostKeyPublicKey,
          fingerprint: ssh2Config.hostKeyFingerprint,
        },
        onUnexpectedClose: (info) =>
          this.onSsh2UnexpectedClose(transport, generation, info),
      });
      this.ssh2Transport = transport;
      await transport.connect();
      if (generation !== this.generation) {
        if (this.ssh2Transport === transport) this.ssh2Transport = null;
        await transport.stop().catch(() => undefined);
        return;
      }
      await this.probeEndpoint(config.publicOrigin, generation);
    } catch (error) {
      const message = redactTunnelText(
        error instanceof Error ? error.message : String(error),
      );
      const transport = this.ssh2Transport;
      this.ssh2Transport = null;
      if (transport) {
        await transport.stop().catch(() => undefined);
      }
      await this.cleanupRuntime();
      await stopRemoteWanListener();
      this.status.stage = "failed";
      this.status.endpoint = { stage: "failed", checkedAt: Date.now() };
      this.status.error = isPermanentSsh2Failure(message)
        ? publicError("AUTH_OR_CERTIFICATE_FAILED", message)
        : publicError("CONNECT_FAILED", message);
      throw error;
    }
  }

  private onSsh2UnexpectedClose(
    transport: Ssh2TunnelTransport,
    generation: number,
    info: Ssh2TransportCloseInfo,
  ): void {
    if (this.ssh2Transport !== transport) return;
    this.ssh2Transport = null;
    const config = this.activeConfig;
    if (!config || generation !== this.generation) return;
    this.exitHandling = this.handleSsh2Loss(
      config,
      generation,
      this.status.attempt,
      info,
    ).catch(() => undefined);
  }

  /** SSH2 意外断开：永久性失败直接终止，其余按与 FRP 相同的退避策略重连。 */
  private async handleSsh2Loss(
    config: StoredRemoteTunnelConfig,
    generation: number,
    attempt: number,
    info: Ssh2TransportCloseInfo,
  ): Promise<void> {
    if (generation !== this.generation) return;
    this.clearEndpointMonitor();
    await this.cleanupRuntime();
    if (generation !== this.generation) return;
    if (info.permanent || !config.enabled) {
      await stopRemoteWanListener();
      if (generation !== this.generation) return;
      this.status.stage = "failed";
      this.status.error = publicError(
        info.permanent ? "AUTH_OR_CERTIFICATE_FAILED" : "TUNNEL_EXITED",
        withDetail(
          info.permanent
            ? "SSH2 隧道身份验证或授权失败，请检查配置或重新授权此设备"
            : "SSH2 隧道已退出",
          info.detail,
        ),
      );
      return;
    }
    const nextAttempt = attempt + 1;
    const base = Math.min(60_000, 1_000 * 2 ** Math.min(nextAttempt, 6));
    const delay = base + Math.floor(Math.random() * Math.max(250, base * 0.2));
    this.status.stage = "reconnecting";
    this.status.attempt = nextAttempt;
    this.status.nextRetryAt = Date.now() + delay;
    this.status.error = publicError(
      "TUNNEL_EXITED",
      withDetail("SSH2 隧道已断开，正在重连", info.detail),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.startAttempt(config, generation, nextAttempt).catch(
        () => undefined,
      );
    }, delay);
  }

  private hasActiveTransport(): boolean {
    return Boolean(this.child) || Boolean(this.ssh2Transport);
  }

  /** 强制关闭当前传输并按意外断开处理（用于公网入口连续探测失败后的重启）。 */
  private terminateTransport(generation: number): void {
    const transport = this.ssh2Transport;
    if (transport) {
      this.ssh2Transport = null;
      void transport.stop();
      const config = this.activeConfig;
      if (config) {
        this.exitHandling = this.handleSsh2Loss(
          config,
          generation,
          this.status.attempt,
          {
            permanent: false,
            detail: "公网 HTTPS 入口连续探测失败，正在重启隧道",
          },
        ).catch(() => undefined);
      }
      return;
    }
    this.child?.kill();
  }

  /** 立即重新探测公网入口并返回最新状态（部署切换上游后调用）。 */
  async probeEndpointNow(): Promise<RemoteTunnelStatus> {
    const config = this.activeConfig;
    if (
      config &&
      this.hasActiveTransport() &&
      this.status.stage !== "stopped"
    ) {
      await this.probeEndpoint(config.publicOrigin, this.generation);
    }
    return this.getStatus();
  }

  private async disconnectInternal(): Promise<void> {
    this.clearEndpointMonitor();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const transport = this.ssh2Transport;
    this.ssh2Transport = null;
    if (transport) {
      await transport.stop().catch(() => undefined);
    }
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      child.kill();
      await waitForExit(child, 5_000);
      if (child.exitCode === null && child.pid) {
        await forceKill(child.pid);
      }
    }
    this.exitHandling = null;
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
