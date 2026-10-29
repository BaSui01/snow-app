import {
  deleteStoredRemoteTunnelConfig,
  loadStoredRemoteTunnelConfig,
  saveRemoteTunnelConfig,
  toRemoteTunnelConfigView,
} from "./remoteTunnelConfig";
import {
  isPermanentSsh2Failure,
  normalizeRemoteTunnelConfig,
  redactTunnelText,
  type RemoteTunnelConfigInput,
  type RemoteTunnelConfigView,
  type StoredRemoteTunnelConfig,
} from "./remoteTunnelSchema";
import {
  startRemoteWanListener,
  stopRemoteWanListener,
} from "./remoteControlServer";
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
};

const ENDPOINT_TIMEOUT_MS = 5_000;
const ENDPOINT_MONITOR_INTERVAL_MS = 30_000;
/** 首次探测窗口内未通过时的复查间隔，之后回到常规监控间隔。 */
const ENDPOINT_FIRST_RETRY_MS = 10_000;
/** 启动自动连接失败后的退避重试延迟（网络 / DNS 尚未就绪等临时故障）。 */
const STARTUP_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000];

const publicError = (
  code: string,
  message: string,
): { code: string; message: string } => ({
  code,
  message,
});

const withDetail = (message: string, detail: string | null): string =>
  detail ? `${message}（${detail}）` : message;

export class RemoteTunnelManager {
  private generation = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private endpointMonitorTimer: ReturnType<typeof setTimeout> | null = null;
  private endpointFailureCount = 0;
  /**
   * 部署期的临时隧道标记：connectTransient 建立候选隧道后，公网入口还没切换好，
   * 此时端点探测失败属于预期，绝不能据此拆除正在使用的传输。
   */
  private transientDeploy = false;
  private exitHandling: Promise<void> | null = null;
  private operation: Promise<void> = Promise.resolve();
  private status: Omit<RemoteTunnelStatus, "config"> = {
    stage: "stopped",
    listenerPort: 0,
    attempt: 0,
    nextRetryAt: null,
    endpoint: { stage: "unchecked", checkedAt: null },
    error: null,
  };
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
   * 凭据或主机密钥类永久失败直接透出，避免无意义重试。
   */
  private async connectWithStartupRetry(): Promise<void> {
    try {
      await this.connect();
      this.startupAttempts = 0;
    } catch (error) {
      const message = redactTunnelText(
        error instanceof Error ? error.message : String(error),
      );
      if (isPermanentSsh2Failure(message)) {
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

  /** 移除本机保存的公网配置：先断开隧道，再删除加密保存的隧道私钥。 */
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

  /**
   * SSH2 反向隧道尝试：本机 WAN listener → 进程内 SSH2 传输 → 服务器回环端口。
   * 认证、主机密钥校验与反向监听申请全部完成后才开始公网探测。
   */
  private async startAttempt(
    config: StoredRemoteTunnelConfig,
    generation: number,
    attempt: number,
  ): Promise<void> {
    if (generation !== this.generation) return;
    this.activeConfig = config;
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
      await stopRemoteWanListener();
      this.status.stage = "failed";
      this.status.endpoint = { stage: "failed", checkedAt: Date.now() };
      this.status.error = isPermanentSsh2Failure(message)
        ? publicError("AUTH_OR_CERTIFICATE_FAILED", message)
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
      "SSH2 隧道已建立，但 HTTPS 公网入口尚不可达；Snow 会继续自动探测",
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

  /** SSH2 意外断开：永久性失败直接终止，其余按退避策略重连。 */
  private async handleSsh2Loss(
    config: StoredRemoteTunnelConfig,
    generation: number,
    attempt: number,
    info: Ssh2TransportCloseInfo,
  ): Promise<void> {
    if (generation !== this.generation) return;
    this.clearEndpointMonitor();
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
    return Boolean(this.ssh2Transport);
  }

  /** 强制关闭当前传输并按意外断开处理（用于公网入口连续探测失败后的重启）。 */
  private terminateTransport(generation: number): void {
    const transport = this.ssh2Transport;
    if (!transport) return;
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
    this.exitHandling = null;
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
}

export const remoteTunnelManager = new RemoteTunnelManager();
