import { ipcRenderer } from "electron";
import type {
  DataManagementCredentialStatus,
  DataManagementCredentialUpdate,
  DataManagementProgress,
  DataManagementSettings,
  DataManagementSettingsPatch,
  DataManagementState,
} from "../types/dataManagement";

export const dataManagementApi = {
  getDataManagementState: (): Promise<DataManagementState> =>
    ipcRenderer.invoke("data-management:get-state"),

  getDataManagementSettings: (): Promise<DataManagementSettings> =>
    ipcRenderer.invoke("data-management:get-settings"),

  setDataManagementSettings: (
    patch: DataManagementSettingsPatch
  ): Promise<DataManagementSettings> =>
    ipcRenderer.invoke("data-management:set-settings", patch),

  /** Write-only secret update. The Renderer cannot read a saved secret. */
  setDataManagementCredential: (
    update: DataManagementCredentialUpdate
  ): Promise<DataManagementCredentialStatus> =>
    ipcRenderer.invoke("data-management:set-credential", update),

  clearDataManagementCredential: (
    kind: DataManagementCredentialUpdate["kind"]
  ): Promise<DataManagementCredentialStatus> =>
    ipcRenderer.invoke("data-management:clear-credential", kind),

  cancelDataManagementTask: (taskId?: string): Promise<boolean> =>
    ipcRenderer.invoke("data-management:cancel", taskId),

  onDataManagementProgress: (
    listener: (progress: DataManagementProgress) => void
  ): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown): void => {
      if (!value || typeof value !== "object") {
        return;
      }
      listener(value as DataManagementProgress);
    };
    ipcRenderer.on("data-management:progress", handler);
    return () => ipcRenderer.removeListener("data-management:progress", handler);
  },
};
