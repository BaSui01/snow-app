import { native } from "../native/nativeBridge";
import {
  getRemoteControlPairingState,
  markRemoteControlEnabled,
  startRemoteControlServer,
  stopRemoteControlServer,
  type RemoteControlPairingState,
} from "./remoteControlServer";
import { remoteTunnelManager } from "./remoteTunnelManager";

const SETTING_NAME = "Remote control enabled";
const SETTING_CODE = "remote_control_enabled";

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
  const info = await startRemoteControlServer();
  if (!info) return;
  await remoteTunnelManager.initialize().catch((error) => {
    console.warn(
      "[Snow Remote] 自动连接公网隧道失败：",
      error instanceof Error ? error.message : String(error),
    );
  });
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
    const info = await startRemoteControlServer();
    if (!info) {
      throw new Error("手机远控服务启动失败，请检查端口占用后重试");
    }
    await remoteTunnelManager.initialize().catch((error) => {
      console.warn(
        "[Snow Remote] 开启手机远控后连接公网隧道失败：",
        error instanceof Error ? error.message : String(error),
      );
    });
  } else {
    await remoteTunnelManager.disconnect();
    await stopRemoteControlServer();
  }
  return getRemoteControlPairingState();
};
