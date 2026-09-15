import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import { APP_ICON_PATH } from "../app/constants";
import { native } from "../native/nativeBridge";
import {
  isRemoteFixedTokenStorageAvailable,
  loadRemoteFixedTokens,
  saveRemoteFixedTokens,
  type RemoteFixedTokens,
} from "./remoteTokenStore";

/**
 * 手机远控服务的 Node 侧薄壳。
 *
 * 监听、鉴权、静态资源、附件上传与图片解析全部由 Rust 原生服务处理
 * （见 native/src/remote_control）；这里只负责：
 * - 解析环境变量与应用路径，驱动原生服务启停 / 轮换凭据；
 * - 组装配对链接（局域网地址枚举依赖 Node 的网卡信息）；
 * - 同步总开关的内存镜像（持久化与启停编排见 remoteControlLifecycle）。
 */

/** 远控服务默认监听地址与端口；端口可由设置面板持久化，或由环境变量显式覆盖。 */
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8788;
/** 端口设置的持久化键（设置面板写入）。 */
const SETTING_NAME_PORT = "Remote control port";
const SETTING_CODE_PORT = "remote_control_port";

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
  /** 设置面板配置的期望端口（服务未运行时 port 为 0，这里仍有值）。 */
  configuredPort: number;
  pairingUrls: string[];
  generation: number;
  /** 当前局域网令牌（服务未运行时为空串）。 */
  token: string;
  /** 局域网令牌是否来自用户固定值；未固定时为本次启动生成的随机令牌。 */
  tokenPinned: boolean;
  /** 系统安全存储是否可用（固定令牌需要）。 */
  tokenStorageAvailable: boolean;
  wan: {
    enabled: boolean;
    localPort: number;
    publicOrigin: string;
    pairingUrl: string;
    /** 当前生效的公网令牌；公网入口未连接时为已保存值。 */
    token: string;
    /** 公网令牌是否为已保存值；否则为本次连接生成的随机令牌。 */
    tokenPinned: boolean;
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

const isValidPort = (port: number): boolean =>
  Number.isInteger(port) && port >= 1 && port <= 65_535;

/**
 * 局域网监听端口：环境变量（显式覆盖）> 设置面板持久化值 > 默认 8788。
 * 环境变量或设置值非法时回退默认端口，避免阻断面板轮询。
 */
const readConfiguredPort = async (): Promise<number> => {
  const raw = process.env.SNOW_REMOTE_PORT?.trim();
  if (raw) {
    const port = Number(raw);
    if (isValidPort(port)) return port;
  }
  try {
    const stored = await native.getSystemSettingValue(SETTING_CODE_PORT);
    const port = Number(stored);
    if (stored && isValidPort(port)) return port;
  } catch {
    // 原生存储暂不可用时回退默认端口。
  }
  return DEFAULT_PORT;
};

/** 持久化设置面板提交的端口（供 lifecycle 调用）。 */
export const persistRemoteControlPort = async (port: number): Promise<void> => {
  await native.setSystemSetting(
    SETTING_NAME_PORT,
    SETTING_CODE_PORT,
    String(port),
  );
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

/** 环境变量显式指定的局域网令牌（开发 / 排障用）优先于面板固定值。 */
const readEnvToken = (): string => process.env.SNOW_REMOTE_TOKEN?.trim() ?? "";

/** 生成与原生侧同构的随机令牌（24 字节 base64url）。 */
const createRandomToken = (): string => randomBytes(24).toString("base64url");

/** 首次连接公网入口时生成并加密保存初始令牌；安全存储不可用时只在本进程内使用。 */
const ensureWanToken = (stored: RemoteFixedTokens): string => {
  if (stored.wan) return stored.wan;
  const token = createRandomToken();
  try {
    saveRemoteFixedTokens({ ...stored, wan: token });
  } catch {
    // 安全存储不可用时仅本次运行有效，面板会提示无法保存令牌。
  }
  return token;
};

const toPairingState = (
  state: NativeRemoteServerState,
  configuredPort: number,
  stored: RemoteFixedTokens,
): RemoteControlPairingState => {
  const hosts = state.host === "0.0.0.0" ? getLanAddresses() : [state.host];
  const envToken = readEnvToken();
  // 服务未运行时没有内存令牌：改为回显已固定值，面板才能如实显示待生效的配置。
  const lanToken = state.running ? state.token : (stored.lan ?? "");
  const wanToken = state.wan.enabled ? state.wan.token : (stored.wan ?? "");
  return {
    enabled: remoteControlEnabled,
    running: state.running,
    host: state.host,
    port: state.port,
    configuredPort,
    pairingUrls:
      state.running && state.token
        ? hosts.map(
            (address) =>
              `http://${address}:${state.port}/?token=${state.token}`,
          )
        : [],
    generation: state.generation,
    token: lanToken,
    tokenPinned: !envToken && Boolean(stored.lan) && lanToken === stored.lan,
    tokenStorageAvailable: isRemoteFixedTokenStorageAvailable(),
    wan: {
      enabled: state.wan.enabled,
      localPort: state.wan.localPort,
      publicOrigin: state.wan.publicOrigin,
      pairingUrl: state.wan.pairingUrl,
      token: wanToken,
      tokenPinned: Boolean(stored.wan) && wanToken === stored.wan,
    },
  };
};

/** 读取当前配对状态（原生侧无 I/O，仅内存快照）。 */
export const getRemoteControlPairingState =
  async (): Promise<RemoteControlPairingState> => {
    const [state, configuredPort] = await Promise.all([
      native.getRemoteControlServerState(),
      readConfiguredPort(),
    ]);
    return toPairingState(state, configuredPort, loadRemoteFixedTokens());
  };

/**
 * 启动远控服务；失败时返回 null（主应用继续运行）。
 * 公网入口地址（SNOW_REMOTE_PUBLIC_ORIGIN）配置时一并启动回环监听器，
 * 其失败不影响局域网服务。
 */
export const startRemoteControlServer =
  async (): Promise<RemoteServerInfo | null> => {
    try {
      const configuredPort = await readConfiguredPort();
      const stored = loadRemoteFixedTokens();
      const state = await native.startRemoteControlServer({
        host: process.env.SNOW_REMOTE_HOST?.trim() || DEFAULT_HOST,
        port: configuredPort,
        token: readEnvToken() || stored.lan || undefined,
        mobileDir: resolveMobileDir(),
        iconPath: APP_ICON_PATH,
        wanPublicOrigin:
          process.env.SNOW_REMOTE_PUBLIC_ORIGIN?.trim() || undefined,
        wanPort: parseWanPort(),
        wanToken: stored.wan ?? undefined,
      });
      return {
        host: state.host,
        port: state.port,
        pairingUrls: toPairingState(state, configuredPort, stored).pairingUrls,
      };
    } catch {
      return null;
    }
  };

/** 停止局域网与公网监听器；失败忽略（退出流程不应被阻塞）。 */
export const stopRemoteControlServer = async (): Promise<void> => {
  await native.stopRemoteControlServer().catch(() => undefined);
};

/** 应用面板固定的局域网令牌；null 表示取消固定（回到随机令牌）。 */
export const setRemoteControlLanToken = async (
  token: string | null,
): Promise<RemoteControlPairingState> => {
  const [state, configuredPort] = await Promise.all([
    native.setRemoteControlLanToken(token ?? undefined),
    readConfiguredPort(),
  ]);
  return toPairingState(state, configuredPort, loadRemoteFixedTokens());
};

/** 应用面板提交的公网令牌；null 表示取消保存（回到本次随机令牌）。 */
export const setRemoteControlWanToken = async (
  token: string | null,
): Promise<RemoteControlPairingState> => {
  const [state, configuredPort] = await Promise.all([
    native.setRemoteControlWanToken(token ?? undefined),
    readConfiguredPort(),
  ]);
  return toPairingState(state, configuredPort, loadRemoteFixedTokens());
};

/** 启动 / 替换公网回环监听器（frpc 隧道入口）；服务未运行时抛出。 */
export const startRemoteWanListener = async (
  publicOrigin: string,
  preferredPort = 0,
): Promise<RemoteControlPairingState> => {
  const stored = loadRemoteFixedTokens();
  const wanToken = ensureWanToken(stored);
  const [state, configuredPort] = await Promise.all([
    native.startRemoteWanListener(publicOrigin, preferredPort, wanToken),
    readConfiguredPort(),
  ]);
  return toPairingState(state, configuredPort, {
    ...stored,
    wan: wanToken,
  });
};

/** 停止公网回环监听器；局域网不受影响。 */
export const stopRemoteWanListener = async (): Promise<void> => {
  await native.stopRemoteWanListener();
};

/** 由 lifecycle 同步总开关的内存镜像（读取持久化值或切换开关时）。 */
export const markRemoteControlEnabled = (enabled: boolean): void => {
  remoteControlEnabled = enabled;
};
