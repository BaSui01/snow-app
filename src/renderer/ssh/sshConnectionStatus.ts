import type { SshConnectionStatus } from "../../preload";

type SshConnectionStatusMeta = {
  key: string;
  defaultValue: string;
};

/** 连接状态 → 文案键：三个视图共用同一份映射，避免直出英文枚举。 */
export const SSH_CONNECTION_STATUS_META: Record<
  SshConnectionStatus,
  SshConnectionStatusMeta
> = {
  idle: { key: "ssh.status.idle", defaultValue: "Not connected" },
  connecting: { key: "ssh.status.connecting", defaultValue: "Connecting" },
  connected: { key: "ssh.status.connected", defaultValue: "Connected" },
  degraded: { key: "ssh.status.degraded", defaultValue: "Connection degraded" },
  reconnecting: {
    key: "ssh.status.reconnecting",
    defaultValue: "Reconnecting",
  },
  offline: { key: "ssh.status.offline", defaultValue: "Connection failed" },
  auth_required: {
    key: "ssh.status.authRequired",
    defaultValue: "Authentication failed",
  },
  host_key_changed: {
    key: "ssh.status.hostKeyChanged",
    defaultValue: "Host key changed",
  },
};

export const getSshConnectionStatusLabel = (
  t: (key: string, options?: { defaultValue?: string }) => string,
  status: SshConnectionStatus,
): string => {
  const meta = SSH_CONNECTION_STATUS_META[status];
  return t(meta.key, { defaultValue: meta.defaultValue });
};
