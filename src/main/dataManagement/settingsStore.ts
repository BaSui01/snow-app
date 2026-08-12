import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type {
  DataManagementSettings,
  DataManagementSettingsPatch,
  DataManagementSyncIntervalMinutes,
  DataManagementWebDavSettings,
} from "../../preload/types/dataManagement";
import { getOrCreateDeviceIdentity, setDeviceName } from "./deviceIdentity";
import { getDataManagementDirectory, getSettingsPath } from "./paths";

type StoredSettings = {
  webdav?: Partial<DataManagementWebDavSettings>;
};

const DEFAULT_WEBDAV_SETTINGS: DataManagementWebDavSettings = {
  endpoint: "",
  remoteRoot: "snow-app",
  username: "",
  syncEnabled: false,
  syncIntervalMinutes: 0,
};

const VALID_INTERVALS = new Set<DataManagementSyncIntervalMinutes>([
  0,
  15,
  30,
  60,
]);

const ensureDirectory = (): void => {
  const directory = getDataManagementDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // Ignore unsupported permission operations.
  }
};

const readStoredSettings = (): StoredSettings => {
  ensureDirectory();
  const path = getSettingsPath();
  if (!existsSync(path)) {
    return {};
  }
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object") {
      return {};
    }
    const webdav = (value as Record<string, unknown>).webdav;
    return webdav && typeof webdav === "object"
      ? { webdav: webdav as Partial<DataManagementWebDavSettings> }
      : {};
  } catch {
    return {};
  }
};

const writeStoredSettings = (settings: StoredSettings): void => {
  ensureDirectory();
  const path = getSettingsPath();
  const stagingPath = `${path}.${process.pid}.tmp`;
  writeFileSync(stagingPath, JSON.stringify(settings, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    chmodSync(stagingPath, 0o600);
  } catch {
    // Ignore unsupported permission operations.
  }
  renameSync(stagingPath, path);
};

const normalizeWebDavSettings = (
  value: Partial<DataManagementWebDavSettings> | undefined
): DataManagementWebDavSettings => {
  const endpoint = typeof value?.endpoint === "string" ? value.endpoint : "";
  const remoteRoot =
    typeof value?.remoteRoot === "string" && value.remoteRoot.trim()
      ? value.remoteRoot.trim()
      : DEFAULT_WEBDAV_SETTINGS.remoteRoot;
  const username = typeof value?.username === "string" ? value.username : "";
  const syncEnabled = value?.syncEnabled === true;
  const interval = value?.syncIntervalMinutes;
  const syncIntervalMinutes = VALID_INTERVALS.has(
    interval as DataManagementSyncIntervalMinutes
  )
    ? (interval as DataManagementSyncIntervalMinutes)
    : DEFAULT_WEBDAV_SETTINGS.syncIntervalMinutes;

  return {
    endpoint,
    remoteRoot,
    username,
    syncEnabled,
    syncIntervalMinutes,
  };
};

export const getDataManagementSettings = (): DataManagementSettings => {
  const identity = getOrCreateDeviceIdentity();
  return {
    deviceName: identity.deviceName,
    webdav: normalizeWebDavSettings(readStoredSettings().webdav),
  };
};

export const updateDataManagementSettings = (
  patch: DataManagementSettingsPatch
): DataManagementSettings => {
  if (patch.deviceName !== undefined) {
    setDeviceName(patch.deviceName);
  }

  const current = getDataManagementSettings();
  const nextWebdav = normalizeWebDavSettings({
    ...current.webdav,
    ...(patch.webdav ?? {}),
  });

  writeStoredSettings({ webdav: nextWebdav });
  return {
    deviceName: getOrCreateDeviceIdentity().deviceName,
    webdav: nextWebdav,
  };
};
