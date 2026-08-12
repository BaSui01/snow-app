import { Check, Cloud, LockKeyhole, Save, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../../../i18n";
import type {
  DataManagementSettings,
  DataManagementSettingsPatch,
  DataManagementState,
} from "../../../../preload";

type CloudSyncTabProps = {
  state: DataManagementState | null;
  settings: DataManagementSettings | null;
  isSaving: boolean;
  onUpdateSettings: (patch: DataManagementSettingsPatch) => Promise<void>;
};

export function CloudSyncTab({
  state,
  settings,
  isSaving,
  onUpdateSettings,
}: CloudSyncTabProps): React.JSX.Element {
  const { t } = useI18n();
  const [deviceName, setDeviceName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [remoteRoot, setRemoteRoot] = useState("");
  const [username, setUsername] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!settings) {
      return;
    }
    setDeviceName(settings.deviceName);
    setEndpoint(settings.webdav.endpoint);
    setRemoteRoot(settings.webdav.remoteRoot);
    setUsername(settings.webdav.username);
  }, [settings]);

  const handleSave = async (): Promise<void> => {
    await onUpdateSettings({
      deviceName,
      webdav: { endpoint, remoteRoot, username },
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2200);
  };

  const safeStorageReady = state?.safeStorageAvailable === true;

  return (
    <div className="data-management-tab-content">
      <div className="data-management-hero">
        <div className="data-management-hero-icon">
          <Cloud size={20} strokeWidth={1.7} />
        </div>
        <div>
          <strong>
            {t("settings.dataManagementCloudTitle", {
              defaultValue: "WebDAV cloud sync",
            })}
          </strong>
          <p>
            {t("settings.dataManagementCloudInfo", {
              defaultValue:
                "Configuration sync will keep encrypted objects on your WebDAV server and coordinate changes with revisions and ETags.",
            })}
          </p>
        </div>
        <span className="data-management-phase-badge">
          {t("settings.dataManagementPhase3", { defaultValue: "Phase 3" })}
        </span>
      </div>

      <section className="data-management-card">
        <div className="data-management-card-heading">
          <Cloud size={16} aria-hidden="true" />
          <strong>
            {t("settings.dataManagementDeviceIdentity", {
              defaultValue: "This device",
            })}
          </strong>
          {state && (
            <span className="data-management-card-meta">
              {state.deviceId.slice(0, 8)}…
            </span>
          )}
        </div>
        <div className="data-management-form-row">
          <label htmlFor="data-management-device-name">
            {t("settings.dataManagementDeviceName", {
              defaultValue: "Device name",
            })}
          </label>
          <input
            id="data-management-device-name"
            value={deviceName}
            maxLength={64}
            onChange={(event) => setDeviceName(event.target.value)}
            placeholder={t("settings.dataManagementDeviceNamePlaceholder", {
              defaultValue: "Snow App",
            })}
          />
        </div>
      </section>

      <section className="data-management-card">
        <div className="data-management-card-heading">
          <LockKeyhole size={16} aria-hidden="true" />
          <strong>
            {t("settings.dataManagementWebDavConnection", {
              defaultValue: "WebDAV connection",
            })}
          </strong>
          <span className="data-management-inline-status">
            {t("settings.dataManagementConfigurationOnly", {
              defaultValue: "Configuration only",
            })}
          </span>
        </div>
        <div className="data-management-form-grid">
          <label>
            <span>
              {t("settings.dataManagementEndpoint", {
                defaultValue: "Endpoint",
              })}
            </span>
            <input
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="https://dav.example.com/remote.php/dav/files/user"
              inputMode="url"
            />
          </label>
          <label>
            <span>
              {t("settings.dataManagementRemoteRoot", {
                defaultValue: "Remote root",
              })}
            </span>
            <input
              value={remoteRoot}
              onChange={(event) => setRemoteRoot(event.target.value)}
              placeholder="snow-app"
            />
          </label>
          <label>
            <span>
              {t("settings.dataManagementUsername", {
                defaultValue: "Username",
              })}
            </span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
            />
          </label>
        </div>
        <div className="data-management-form-footer">
          <span className="data-management-muted-note">
            {t("settings.dataManagementPasswordLater", {
              defaultValue:
                "The password and sync encryption key will be saved through OS-level secure storage in a later phase.",
            })}
          </span>
          <button
            className="data-management-primary-button"
            type="button"
            onClick={() => void handleSave()}
            disabled={isSaving || !deviceName.trim()}
          >
            {saved ? <Check size={14} aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}
            {saved
              ? t("settings.dataManagementSaved", { defaultValue: "Saved" })
              : t("settings.dataManagementSave", { defaultValue: "Save" })}
          </button>
        </div>
      </section>

      <section
        className={`data-management-card data-management-status-card ${
          safeStorageReady ? "is-ready" : "is-warning"
        }`}
      >
        {safeStorageReady ? (
          <LockKeyhole size={16} aria-hidden="true" />
        ) : (
          <ShieldAlert size={16} aria-hidden="true" />
        )}
        <div>
          <strong>
            {safeStorageReady
              ? t("settings.dataManagementSecureStorageReady", {
                  defaultValue: "Secure credential storage is available",
                })
              : t("settings.dataManagementSecureStorageUnavailable", {
                  defaultValue: "Secure credential storage is unavailable",
                })}
          </strong>
          <span>
            {state?.credentialStatus.webdavPasswordConfigured
              ? t("settings.dataManagementPasswordConfigured", {
                  defaultValue: "A WebDAV password is configured locally.",
                })
              : t("settings.dataManagementPasswordNotConfigured", {
                  defaultValue: "No WebDAV password is stored.",
                })}
          </span>
        </div>
      </section>
    </div>
  );
}
