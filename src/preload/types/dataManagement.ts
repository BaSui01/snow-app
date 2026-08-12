/** Stable sections used by portable Snow App configuration packages. */
export const DATA_SECTIONS = [
  "api-config",
  "model-settings",
  "system-settings",
  "mcp",
  "prompts",
  "hooks",
  "sub-agents",
  "keyboard-shortcuts",
  "theme",
  "skills",
  "plugins",
] as const;

export type DataSection = (typeof DATA_SECTIONS)[number];

/** Version of the portable `.snow-config` manifest contract. */
export const DATA_MANAGEMENT_FORMAT_VERSION = 1 as const;

export type DataManifestFile = {
  path: string;
  sha256: string;
  sizeBytes: number;
};

export type DataManifest = {
  formatVersion: typeof DATA_MANAGEMENT_FORMAT_VERSION;
  appVersion: string;
  schemaVersion: number;
  createdAt: string;
  deviceId: string;
  sections: DataSection[];
  containsSecrets: boolean;
  encrypted: boolean;
  files: DataManifestFile[];
};

export type DataManagementTaskOperation =
  | "config-export"
  | "config-import"
  | "backup-create"
  | "backup-restore"
  | "sync";

export type DataManagementTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type DataManagementProgress = {
  taskId: string;
  operation: DataManagementTaskOperation;
  status: DataManagementTaskStatus;
  phase: string;
  completed: number;
  total: number;
  currentItem: string;
  cancellable: boolean;
  error?: string;
};

export type DataManagementSyncIntervalMinutes = 0 | 15 | 30 | 60;

/** Non-secret WebDAV settings. Passwords and encryption keys are never here. */
export type DataManagementWebDavSettings = {
  endpoint: string;
  remoteRoot: string;
  username: string;
  syncEnabled: boolean;
  syncIntervalMinutes: DataManagementSyncIntervalMinutes;
};

export type DataManagementSettings = {
  deviceName: string;
  webdav: DataManagementWebDavSettings;
};

export type DataManagementSettingsPatch = {
  deviceName?: string;
  webdav?: Partial<DataManagementWebDavSettings>;
};

export type DataManagementCredentialKind =
  | "webdav-password"
  | "sync-master-key";

/** This value is write-only from the Renderer perspective. */
export type DataManagementCredentialUpdate = {
  kind: DataManagementCredentialKind;
  value: string;
};

export type DataManagementCredentialStatus = {
  webdavPasswordConfigured: boolean;
  syncMasterKeyConfigured: boolean;
};

export type DataManagementState = {
  deviceId: string;
  deviceName: string;
  appVersion: string;
  manifestFormatVersion: typeof DATA_MANAGEMENT_FORMAT_VERSION;
  safeStorageAvailable: boolean;
  credentialStatus: DataManagementCredentialStatus;
  activeTask: DataManagementProgress | null;
};
