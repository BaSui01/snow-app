import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import { APP_ICON_PATH } from "../app/constants";
import { native } from "../native/nativeBridge";

/**
 * 手机远控服务的 Node 侧薄壳。
 *
 * 监听、鉴权、静态资源、附件上传与图片解析全部由 Rust 原生服务处理
 * （见 native/src/remote_control）；这里只负责：
 * - 解析环境变量与应用路径，驱动原生服务启停 / 轮换凭据；
 * - 组装配对链接（局域网地址枚举依赖 Node 的网卡信息）；
 * - 同步总开关的内存镜像（持久化与启停编排见 remoteControlLifecycle）。
 */

/** 远控服务默认监听地址与端口（可用环境变量覆盖）。 */
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8788;

export type RemoteServerInfo = {
  host: string;
  port: number;
  pairingUrls: string[];
};

type NativeRemoteServerState = Awaited<
  ReturnType<typeof native.getRemoteControlServerState>
>;

export type RemoteControlPairingState = {
  enabled: boolean;
  running: boolean;
  host: string;
  port: number;
  pairingUrls: string[];
  generation: number;
  wan: {
    enabled: boolean;
    localPort: number;
    publicOrigin: string;
    pairingUrl: string;
    pairingExpiresAt: number | null;
  };
};

/** 总开关的内存镜像；持久化与启停编排由 remoteControlLifecycle 负责。 */
let remoteControlEnabled = false;

const getLanAddresses = (): string[] => {
  const addresses = new Set<string>(["127.0.0.1"]);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal)
        addresses.add(entry.address);
    }
  }
  return [...addresses];
};

/**
 * 移动端页面产物目录（out/mobile）。
 *
 * 打包后产物在 app.asar 内，而 Rust 原生代码无法穿透 asar，因此构建配置
 * 通过 asarUnpack 把 out/mobile 解包到 app.asar.unpacked 下读取。
 */
const resolveMobileDir = (): string =>
  app.isPackaged
    ? join(process.resourcesPath, "app.asar.unpacked", "out", "mobile")
    : join(app.getAppPath(), "out", "mobile");

const parsePort = (): number => {
  const raw = process.env.SNOW_REMOTE_PORT;
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SNOW_REMOTE_PORT 必须是 1 到 65535 的整数");
  }
  return port;
};

const parseWanPort = (): number => {
  const raw = process.env.SNOW_REMOTE_WAN_PORT;
  if (!raw) return 0;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("SNOW_REMOTE_WAN_PORT 必须是 0 到 65535 的整数");
  }
  return port;
};

const toPairingState = (
  state: NativeRemoteServerState,
): RemoteControlPairingState => {
  const hosts = state.host === "0.0.0.0" ? getLanAddresses() : [state.host];
  return {
    enabled: remoteControlEnabled,
    running: state.running,
    host: state.host,
    port: state.port,
    pairingUrls:
      state.running && state.token
        ? hosts.map(
            (address) =>
              `http://${address}:${state.port}/?token=${state.token}`,
          )
        : [],
    generation: state.generation,
    wan: {
      enabled: state.wan.enabled,
      localPort: state.wan.localPort,
      publicOrigin: state.wan.publicOrigin,
      pairingUrl: state.wan.pairingUrl,
      // 原生侧无配对码时省略该字段；这里归一化为 null 以保持既有契约。
      pairingExpiresAt: state.wan.pairingExpiresAt ?? null,
    },
  };
};

/** 读取当前配对状态（原生侧无 I/O，仅内存快照）。 */
export const getRemoteControlPairingState =
  async (): Promise<RemoteControlPairingState> =>
    toPairingState(await native.getRemoteControlServerState());

/**
 * 启动远控服务；失败时返回 null（主应用继续运行）。
 * 公网入口地址（SNOW_REMOTE_PUBLIC_ORIGIN）配置时一并启动回环监听器，
 * 其失败不影响局域网服务。
 */
export const startRemoteControlServer =
  async (): Promise<RemoteServerInfo | null> => {
    try {
      const state = await native.startRemoteControlServer({
        host: process.env.SNOW_REMOTE_HOST?.trim() || DEFAULT_HOST,
        port: parsePort(),
        token: process.env.SNOW_REMOTE_TOKEN?.trim() || undefined,
        mobileDir: resolveMobileDir(),
        iconPath: APP_ICON_PATH,
        wanPublicOrigin:
          process.env.SNOW_REMOTE_PUBLIC_ORIGIN?.trim() || undefined,
        wanPort: parseWanPort(),
      });
      return {
        host: state.host,
        port: state.port,
        pairingUrls: toPairingState(state).pairingUrls,
      };
    } catch {
      return null;
    }
  };

/** 停止局域网与公网监听器；失败忽略（退出流程不应被阻塞）。 */
export const stopRemoteControlServer = async (): Promise<void> => {
  await native.stopRemoteControlServer().catch(() => undefined);
};

/** 轮换局域网令牌与公网配对码；服务未运行时抛出。 */
export const rotateRemoteControlToken =
  async (): Promise<RemoteControlPairingState> =>
    toPairingState(await native.rotateRemoteControlToken());

/** 启动 / 替换公网回环监听器（frpc 隧道入口）；服务未运行时抛出。 */
export const startRemoteWanListener = async (
  publicOrigin: string,
  preferredPort = 0,
): Promise<RemoteControlPairingState> =>
  toPairingState(
    await native.startRemoteWanListener(publicOrigin, preferredPort),
  );

/** 停止公网回环监听器并撤销全部公网会话；局域网不受影响。 */
export const stopRemoteWanListener = async (): Promise<void> => {
  await native.stopRemoteWanListener();
};

/** 由 lifecycle 同步总开关的内存镜像（读取持久化值或切换开关时）。 */
export const markRemoteControlEnabled = (enabled: boolean): void => {
  remoteControlEnabled = enabled;
};
