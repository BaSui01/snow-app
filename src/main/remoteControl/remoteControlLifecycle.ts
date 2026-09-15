import { native } from "../native/nativeBridge";
import {
  getRemoteControlPairingState,
  markRemoteControlEnabled,
  persistRemoteControlPort,
  setRemoteControlLanToken,
  setRemoteControlWanToken,
  startRemoteControlServer,
  stopRemoteControlServer,
  type RemoteControlPairingState,
} from "./remoteControlServer";
import { installRemoteRendererBridge } from "./rendererBridge";
import { remoteTunnelManager } from "./remoteTunnelManager";
import {
  isRemoteFixedTokenStorageAvailable,
  loadRemoteFixedTokens,
  saveRemoteFixedTokens,
} from "./remoteTokenStore";

const SETTING_NAME = "Remote control enabled";
const SETTING_CODE = "remote_control_enabled";

/** 固定令牌长度约束（与原生侧 MIN_TOKEN_LEN 一致）。 */
const MIN_FIXED_TOKEN_LENGTH = 24;
const MAX_FIXED_TOKEN_LENGTH = 512;

/**
 * 注册渲染进程桥（幂等）：Rust 远控服务需要桌面 UI 状态时回调主进程。
 * 注册失败时忽略——服务本身仍可运行，仅桥相关接口暂时不可用。
 */
const ensureRendererBridge = async (): Promise<void> => {
  await installRemoteRendererBridge().catch(() => undefined);
};

/**
 * 手机远控总开关持久化于系统设置（Rust 存储），默认关闭。
 * 关闭时既不监听局域网端口，也不连接公网隧道。
 */
const readRemoteControlEnabled = async (): Promise<boolean> => {
  try {
    return (await native.getSystemSettingValue(SETTING_CODE)) === "true";
  } catch {
    return false;
  }
};

/** 应用启动时调用：仅在开关已持久化为开启时恢复服务与公网隧道。 */
export const initializeRemoteControl = async (): Promise<void> => {
  const enabled = await readRemoteControlEnabled();
  markRemoteControlEnabled(enabled);
  if (!enabled) return;
  await ensureRendererBridge();
  const info = await startRemoteControlServer();
  if (!info) return;
  // 隧道连接失败不影响局域网远控；失败原因在设置面板的隧道状态中呈现。
  await remoteTunnelManager.initialize().catch(() => undefined);
};

/** 设置面板切换总开关：先写持久化，再编排服务与隧道的启停。 */
export const applyRemoteControlEnabled = async (
  enabled: boolean,
): Promise<RemoteControlPairingState> => {
  await native.setSystemSetting(
    SETTING_NAME,
    SETTING_CODE,
    enabled ? "true" : "false",
  );
  markRemoteControlEnabled(enabled);
  if (enabled) {
    await ensureRendererBridge();
    const info = await startRemoteControlServer();
    if (!info) {
      throw new Error("手机远控服务启动失败，请检查端口占用后重试");
    }
    await remoteTunnelManager.initialize().catch(() => undefined);
  } else {
    await remoteTunnelManager.disconnect();
    await stopRemoteControlServer();
  }
  return getRemoteControlPairingState();
};

/**
 * 设置面板保存局域网端口：先持久化，再按需重启监听器。
 *
 * 端口变化必须重建监听器，旧令牌随之失效（已配对手机需重新扫码）；
 * 公网隧道依赖回环监听器，因此运行中的隧道需要断开后恢复。
 */
export const applyRemoteControlPort = async (
  port: number,
): Promise<RemoteControlPairingState> => {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("端口必须是 1 到 65535 的整数");
  }
  await persistRemoteControlPort(port);
  const current = await getRemoteControlPairingState();
  if (!current.running) return current;
  const tunnelWasActive = remoteTunnelManager.getStatus().stage !== "stopped";
  await remoteTunnelManager.disconnect().catch(() => undefined);
  await stopRemoteControlServer();
  const info = await startRemoteControlServer();
  if (!info) {
    throw new Error("端口已保存，但远控服务重启失败；请检查新端口是否被占用");
  }
  if (tunnelWasActive) {
    // 隧道恢复失败不影响局域网服务，状态会在面板轮询中呈现。
    await remoteTunnelManager.connect().catch(() => undefined);
  }
  return getRemoteControlPairingState();
};

export type RemoteFixedTokenKind = "lan" | "wan";

/**
 * 固定 / 取消固定令牌：先加密持久化，再按需应用到运行中的服务。
 * 服务或公网入口未运行时只写持久化，重启 / 下次连接后生效。
 */
export const applyRemoteControlFixedToken = async (
  kind: RemoteFixedTokenKind,
  token: string | null,
): Promise<RemoteControlPairingState> => {
  const next = token?.trim() ?? "";
  if (
    next &&
    (next.length < MIN_FIXED_TOKEN_LENGTH ||
      next.length > MAX_FIXED_TOKEN_LENGTH)
  ) {
    throw new Error(
      `令牌长度需为 ${MIN_FIXED_TOKEN_LENGTH} 到 ${MAX_FIXED_TOKEN_LENGTH} 个字符`,
    );
  }
  if (!isRemoteFixedTokenStorageAvailable()) {
    throw new Error("系统安全存储不可用，无法固定令牌");
  }
  saveRemoteFixedTokens({
    ...loadRemoteFixedTokens(),
    [kind]: next || null,
  });
  const current = await getRemoteControlPairingState();
  if (kind === "lan") {
    if (!current.running || current.token === next) return current;
    return setRemoteControlLanToken(next || null);
  }
  if (!current.wan.enabled || current.wan.fixedToken === next) return current;
  return setRemoteControlWanToken(next || null);
};
