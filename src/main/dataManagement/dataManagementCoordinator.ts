import { app, BrowserWindow } from "electron";
import type {
  DataManagementCredentialStatus,
  DataManagementCredentialUpdate,
  DataManagementProgress,
  DataManagementSettings,
  DataManagementSettingsPatch,
  DataManagementState,
  DataManagementTaskOperation,
} from "../../preload/types/dataManagement";
import {
  deleteDataManagementCredential,
  getDataManagementCredentialStatus,
  isDataManagementSafeStorageAvailable,
  saveDataManagementCredential,
} from "./credentials";
import { getOrCreateDeviceIdentity } from "./deviceIdentity";
import {
  getDataManagementSettings,
  updateDataManagementSettings,
} from "./settingsStore";
import { DataManagementTaskCoordinator } from "./taskCoordinator";

const PROGRESS_CHANNEL = "data-management:progress";

/**
 * Main-process coordinator for all data management work.
 *
 * Phase 0 only exposes the contract and task boundary. Later phases can add
 * snapshot, import and WebDAV implementations without creating a second
 * IPC surface or allowing overlapping database operations.
 */
export class DataManagementCoordinator {
  private readonly tasks = new DataManagementTaskCoordinator();

  constructor() {
    this.tasks.subscribe((progress) => this.broadcastProgress(progress));
  }

  getState(): DataManagementState {
    const identity = getOrCreateDeviceIdentity();
    return {
      deviceId: identity.deviceId,
      deviceName: identity.deviceName,
      appVersion: app.getVersion(),
      manifestFormatVersion: 1,
      safeStorageAvailable: isDataManagementSafeStorageAvailable(),
      credentialStatus: getDataManagementCredentialStatus(),
      activeTask: this.tasks.getActiveTask(),
    };
  }

  getSettings(): DataManagementSettings {
    return getDataManagementSettings();
  }

  setSettings(patch: DataManagementSettingsPatch): DataManagementSettings {
    return updateDataManagementSettings(patch);
  }

  setCredential(update: DataManagementCredentialUpdate): DataManagementCredentialStatus {
    return saveDataManagementCredential(update.kind, update.value);
  }

  clearCredential(kind: DataManagementCredentialUpdate["kind"]): DataManagementCredentialStatus {
    return deleteDataManagementCredential(kind);
  }

  cancel(taskId?: string): boolean {
    return this.tasks.cancel(taskId);
  }

  async run<T>(
    operation: DataManagementTaskOperation,
    work: Parameters<DataManagementTaskCoordinator["run"]>[1]
  ): Promise<T> {
    return this.tasks.run(operation, work) as Promise<T>;
  }

  private broadcastProgress(progress: DataManagementProgress): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(PROGRESS_CHANNEL, progress);
      }
    }
  }
}

export const dataManagementCoordinator = new DataManagementCoordinator();
