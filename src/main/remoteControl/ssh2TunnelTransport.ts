import { createHash } from "node:crypto";
import { connect as connectTcp, type Socket } from "node:net";
import { createRequire } from "node:module";
import { isPermanentSsh2Failure } from "./remoteTunnelSchema";

const require2 = createRequire(import.meta.url);
const ssh2 = require2("ssh2") as typeof import("ssh2");
const { Client } = ssh2;

const READY_TIMEOUT_MS = 15_000;
const FORWARD_TIMEOUT_MS = 15_000;
const KEEPALIVE_INTERVAL_MS = 10_000;
const KEEPALIVE_COUNT_MAX = 3;
const STOP_TIMEOUT_MS = 2_000;
/** 单条隧道同时桥接的连接数上限（远控是低频 HTTP 场景，防御异常放大）。 */
const MAX_BRIDGE_CHANNELS = 64;

/** 服务器主机公钥期望值：部署时经可信管理连接取得并固定。 */
export type Ssh2HostKeyExpectation = {
  keyType: string;
  /** 原始主机密钥 blob 的 base64（无注释）。 */
  publicKey: string;
  /** 原始主机密钥 blob 的 SHA-256 十六进制。 */
  fingerprint: string;
};

export type Ssh2TransportCloseInfo = {
  /** 身份验证、主机密钥或授权类失败：不应自动重试，需要用户处理。 */
  permanent: boolean;
  /** 可供展示的失败细节（不含秘密）。 */
  detail: string | null;
};

export type Ssh2TransportOptions = {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  /** 服务器侧 127.0.0.1 监听端口（PermitListen 授权目标）。 */
  remoteBindPort: number;
  /** 本机 WAN listener 的实际端口。 */
  localTargetPort: number;
  expectedHostKey: Ssh2HostKeyExpectation;
  /** 非主动 stop 导致的断开（用于重连调度）。 */
  onUnexpectedClose: (info: Ssh2TransportCloseInfo) => void;
};

const readHostKeyType = (key: Buffer): string | null => {
  if (key.length < 5) return null;
  const length = key.readUInt32BE(0);
  const end = 4 + length;
  if (length === 0 || end > key.length) return null;
  const keyType = key.subarray(4, end).toString("ascii");
  return /^[A-Za-z0-9@._+-]+$/.test(keyType) ? keyType : null;
};

const fingerprintOf = (key: Buffer): string =>
  createHash("sha256").update(key).digest("hex");

/**
 * 进程内 SSH2 反向隧道：请求服务器监听 127.0.0.1:remoteBindPort，
 * 并把服务器回传的每条转发连接桥接到本机 WAN listener。
 *
 * 生命周期约定：connect() 成功即代表认证、主机密钥校验与反向监听申请都已完成；
 * 主动 stop() 不触发 onUnexpectedClose；网络中断等意外关闭会触发一次回调。
 */
export class Ssh2TunnelTransport {
  private readonly options: Ssh2TransportOptions;
  private client: import("ssh2").Client | null = null;
  private stopped = false;
  private established = false;
  private lastError: string | null = null;
  private hostKeyMismatch: { expected: string; received: string } | null = null;
  private readonly channels = new Set<import("ssh2").ClientChannel>();
  private readonly sockets = new Set<Socket>();

  constructor(options: Ssh2TransportOptions) {
    this.options = options;
  }

  /** 建立连接并申请反向监听；成功时服务器已开始监听目标回环端口。 */
  connect(): Promise<void> {
    if (this.client || this.stopped) {
      return Promise.reject(new Error("SSH2 隧道传输已启动或已停止"));
    }
    return new Promise<void>((resolve, reject) => {
      const client = new Client();
      this.client = client;
      let settled = false;
      let forwardTimer: ReturnType<typeof setTimeout> | null = null;

      const clearForwardTimer = (): void => {
        if (forwardTimer) {
          clearTimeout(forwardTimer);
          forwardTimer = null;
        }
      };

      const failInitial = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearForwardTimer();
        reject(error);
      };

      client.on("ready", () => {
        forwardTimer = setTimeout(() => {
          failInitial(
            new Error(
              `SSH2 隧道已认证，但 ${Math.round(FORWARD_TIMEOUT_MS / 1_000)} 秒内未完成反向监听申请：请检查服务器隧道服务状态后重试`,
            ),
          );
          try {
            client.end();
          } catch {
            // 连接可能已关闭。
          }
        }, FORWARD_TIMEOUT_MS);
        client.forwardIn(
          "127.0.0.1",
          this.options.remoteBindPort,
          (error, boundPort) => {
            if (error) {
              failInitial(this.describeForwardError(error));
              try {
                client.end();
              } catch {
                // 连接可能已关闭。
              }
              return;
            }
            clearForwardTimer();
            this.established = true;
            // boundPort 是服务器确认的端口；固定请求下应与 remoteBindPort 一致。
            void boundPort;
            if (!settled) {
              settled = true;
              resolve();
            }
          },
        );
      });

      client.on("tcp connection", (_details, accept, rejectChannel) => {
        if (
          this.stopped ||
          !this.established ||
          this.channels.size >= MAX_BRIDGE_CHANNELS
        ) {
          rejectChannel();
          return;
        }
        this.bridgeChannel(accept());
      });

      client.on("error", (error: Error) => {
        this.lastError = error.message;
        failInitial(this.describeConnectError(error as NodeJS.ErrnoException));
      });

      client.on("close", () => {
        clearForwardTimer();
        if (this.client === client) {
          this.client = null;
        }
        this.destroyBridges();
        if (this.stopped) return;
        if (!this.established) {
          failInitial(new Error(this.lastError ?? "SSH2 连接在建立前已关闭"));
          return;
        }
        const detail = this.hostKeyMismatch
          ? `主机密钥与部署记录不一致（预期 ${this.hostKeyMismatch.expected}，实际 ${this.hostKeyMismatch.received}）`
          : this.lastError;
        this.options.onUnexpectedClose({
          permanent: isPermanentSsh2Failure(detail ?? ""),
          detail,
        });
      });

      try {
        client.connect({
          host: this.options.host,
          port: this.options.port,
          username: this.options.username,
          privateKey: this.options.privateKey,
          readyTimeout: READY_TIMEOUT_MS,
          keepaliveInterval: KEEPALIVE_INTERVAL_MS,
          keepaliveCountMax: KEEPALIVE_COUNT_MAX,
          agentForward: false,
          hostVerifier: (value: string | Buffer): boolean =>
            this.verifyHostKey(value),
        });
      } catch (error) {
        failInitial(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** 主动停止：不触发 onUnexpectedClose，可在失败清理时安全重复调用。 */
  async stop(): Promise<void> {
    this.stopped = true;
    this.established = false;
    const client = this.client;
    this.client = null;
    this.destroyBridges();
    if (!client) return;
    await new Promise<void>((resolve) => {
      let finished = false;
      const done = (): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          client.destroy();
        } catch {
          // 忽略重复销毁。
        }
        done();
      }, STOP_TIMEOUT_MS);
      client.once("close", done);
      try {
        client.end();
      } catch {
        done();
      }
    });
  }

  /** 把一条 SSH 转发连接桥接到本机 WAN listener，双向管道并统一清理。 */
  private bridgeChannel(channel: import("ssh2").ClientChannel): void {
    const socket = connectTcp({
      host: "127.0.0.1",
      port: this.options.localTargetPort,
    });
    socket.setNoDelay(true);
    this.channels.add(channel);
    this.sockets.add(socket);
    let finished = false;
    const cleanup = (): void => {
      if (finished) return;
      finished = true;
      this.channels.delete(channel);
      this.sockets.delete(socket);
      try {
        socket.destroy();
      } catch {
        // 已关闭。
      }
      try {
        channel.destroy();
      } catch {
        // 已关闭。
      }
    };
    socket.on("connect", () => {
      channel.pipe(socket);
      socket.pipe(channel);
    });
    socket.on("error", cleanup);
    socket.on("close", cleanup);
    channel.on("error", cleanup);
    channel.on("close", cleanup);
  }

  private destroyBridges(): void {
    for (const channel of this.channels) {
      try {
        channel.destroy();
      } catch {
        // 已关闭。
      }
    }
    for (const socket of this.sockets) {
      try {
        socket.destroy();
      } catch {
        // 已关闭。
      }
    }
    this.channels.clear();
    this.sockets.clear();
  }

  /** 严格比对部署时固定的主机公钥；不匹配时记录差异并拒绝握手。 */
  private verifyHostKey(value: Buffer | string): boolean {
    const key = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const expected = this.options.expectedHostKey;
    const keyType = readHostKeyType(key);
    const fingerprint = fingerprintOf(key);
    const matches =
      keyType === expected.keyType &&
      (expected.publicKey
        ? key.toString("base64") === expected.publicKey
        : fingerprint === expected.fingerprint);
    if (!matches) {
      this.hostKeyMismatch = {
        expected: expected.fingerprint,
        received: fingerprint,
      };
    }
    return matches;
  }

  /**
   * 把底层错误翻译成可读描述。只描述发生了什么，不给出与具体系统绑定的操作指引：
   * 各发行版的命令与路径不同，指令性提示会把用户引向错误方向。
   */
  private describeConnectError(error: NodeJS.ErrnoException): Error {
    if (this.hostKeyMismatch) {
      return new Error(
        `隧道服务器主机密钥与部署记录不一致（预期 ${this.hostKeyMismatch.expected}，实际 ${this.hostKeyMismatch.received}）：已中止连接，请核对服务器身份后重新部署`,
      );
    }
    const endpoint = `${this.options.host}:${this.options.port}`;
    const message = error.message ?? "";
    if (/All configured authentication methods failed/i.test(message)) {
      return new Error(
        "SSH2 隧道身份验证失败：服务器拒绝了本机隧道专用密钥（可能密钥未获授权、隧道账户不可用，或授权记录读取失败）。请重新授权此设备",
      );
    }
    if (/Cannot parse privateKey/i.test(message)) {
      return new Error(
        "本机 SSH2 隧道私钥无法解析，请重新部署以生成新的专用密钥",
      );
    }
    const level = (error as { level?: unknown }).level;
    if (
      /Timed out while waiting for handshake/i.test(message) ||
      level === "client-timeout"
    ) {
      return new Error(
        `连接 ${endpoint} 超时：在限定时间内没有完成 SSH 握手（端口可能不可达，或在防火墙层面被丢弃）`,
      );
    }
    if (/Connection lost before handshake/i.test(message)) {
      return new Error(
        `${endpoint} SSH 握手未完成：连接建立后对端未发出 SSH 标识即中断（可能是网络中间层或代理干扰，或该端口并非 SSH 服务）`,
      );
    }
    switch (error.code) {
      case "ECONNREFUSED":
        return new Error(
          `${endpoint} 拒绝连接：该端口没有服务在监听（隧道服务可能未运行，或端口配置不一致）`,
        );
      case "ETIMEDOUT":
        return new Error(
          `连接 ${endpoint} 超时：端口在限定时间内无响应（可能在防火墙层面被丢弃）`,
        );
      case "ENOTFOUND":
      case "EAI_AGAIN":
        return new Error(
          `无法解析 ${this.options.host}：请检查服务器地址后重试`,
        );
      case "EHOSTUNREACH":
      case "ENETUNREACH":
        return new Error(`无法到达 ${endpoint}：请检查本机网络连接`);
      default:
        return new Error(`${endpoint} SSH2 连接失败：${message || "未知错误"}`);
    }
  }

  private describeForwardError(error: Error): Error {
    const message = error.message ?? "";
    if (/administratively prohibited|not permitted/i.test(message)) {
      return new Error(
        `服务器拒绝反向监听 127.0.0.1:${this.options.remoteBindPort}：专用密钥的授权范围可能已变化，请重新部署此设备`,
      );
    }
    return new Error(
      `请求服务器监听 127.0.0.1:${this.options.remoteBindPort} 失败：${message}；请确认端口未被占用且隧道服务运行正常`,
    );
  }
}
