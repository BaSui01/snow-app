import { ipcMain } from "electron";
import type {
  DataManagementCredentialKind,
  DataManagementCredentialUpdate,
  DataManagementSettingsPatch,
} from "../../../preload/types/dataManagement";
import { dataManagementCoordinator } from "../../dataManagement/dataManagementCoordinator";

const CREDENTIAL_KINDS: readonly DataManagementCredentialKind[] = [
  "webdav-password",
  "sync-master-key",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const requireSettingsPatch = (value: unknown): DataManagementSettingsPatch => {
  if (!isRecord(value)) {
    throw new Error("Data management settings are required");
  }

  const patch: DataManagementSettingsPatch = {};
  if (value.deviceName !== undefined) {
    if (typeof value.deviceName !== "string") {
      throw new Error("Device name must be a string");
    }
    patch.deviceName = value.deviceName;
  }

  if (value.webdav !== undefined) {
    if (!isRecord(value.webdav)) {
      throw new Error("WebDAV settings must be an object");
    }
    const webdav = value.webdav;
    const next: NonNullable<DataManagementSettingsPatch["webdav"]> = {};
    if (webdav.endpoint !== undefined) {
      if (typeof webdav.endpoint !== "string" || webdav.endpoint.length > 2048) {
        throw new Error("WebDAV endpoint is invalid");
      }
      next.endpoint = webdav.endpoint.trim();
    }
    if (webdav.remoteRoot !== undefined) {
      if (
        typeof webdav.remoteRoot !== "string" ||
        webdav.remoteRoot.trim().length > 512
      ) {
        throw new Error("WebDAV remote root is invalid");
      }
      next.remoteRoot = webdav.remoteRoot.trim();
    }
    if (webdav.username !== undefined) {
      if (typeof webdav.username !== "string" || webdav.username.length > 512) {
        throw new Error("WebDAV username is invalid");
      }
      next.username = webdav.username.trim();
    }
    if (webdav.syncEnabled !== undefined) {
      if (typeof webdav.syncEnabled !== "boolean") {
        throw new Error("WebDAV syncEnabled must be a boolean");
      }
      next.syncEnabled = webdav.syncEnabled;
    }
    if (webdav.syncIntervalMinutes !== undefined) {
      if (![0, 15, 30, 60].includes(webdav.syncIntervalMinutes as number)) {
        throw new Error("WebDAV sync interval is invalid");
      }
      next.syncIntervalMinutes = webdav.syncIntervalMinutes as 0 | 15 | 30 | 60;
    }
    patch.webdav = next;
  }

  return patch;
};

const requireCredentialUpdate = (
  value: unknown
): DataManagementCredentialUpdate => {
  if (!isRecord(value)) {
    throw new Error("Credential update is required");
  }
  if (
    typeof value.kind !== "string" ||
    !CREDENTIAL_KINDS.includes(value.kind as DataManagementCredentialKind)
  ) {
    throw new Error("Credential kind is invalid");
  }
  if (typeof value.value !== "string" || !value.value.trim()) {
    throw new Error("Credential value is required");
  }
  if (value.value.length > 1024 * 1024) {
    throw new Error("Credential value is too large");
  }
  return {
    kind: value.kind as DataManagementCredentialKind,
    value: value.value,
  };
};

const requireCredentialKind = (value: unknown): DataManagementCredentialKind => {
  if (
    typeof value !== "string" ||
    !CREDENTIAL_KINDS.includes(value as DataManagementCredentialKind)
  ) {
    throw new Error("Credential kind is invalid");
  }
  return value as DataManagementCredentialKind;
};

export const registerDataManagementHandlers = (): void => {
  ipcMain.handle("data-management:get-state", () =>
    dataManagementCoordinator.getState()
  );

  ipcMain.handle("data-management:get-settings", () =>
    dataManagementCoordinator.getSettings()
  );

  ipcMain.handle("data-management:set-settings", (_event, value: unknown) =>
    dataManagementCoordinator.setSettings(requireSettingsPatch(value))
  );

  // The value is accepted only for the duration of this IPC call. The return
  // value contains status booleans, never the plaintext or decrypted secret.
  ipcMain.handle(
    "data-management:set-credential",
    (_event, value: unknown) =>
      dataManagementCoordinator.setCredential(requireCredentialUpdate(value))
  );

  ipcMain.handle(
    "data-management:clear-credential",
    (_event, value: unknown) =>
      dataManagementCoordinator.clearCredential(requireCredentialKind(value))
  );

  ipcMain.handle("data-management:cancel", (_event, taskId: unknown) => {
    if (taskId !== undefined && typeof taskId !== "string") {
      throw new Error("Task ID must be a string");
    }
    return dataManagementCoordinator.cancel(taskId as string | undefined);
  });
};
