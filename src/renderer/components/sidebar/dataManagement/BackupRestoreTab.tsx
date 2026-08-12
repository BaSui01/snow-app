import { Archive, Database, DatabaseBackup, ShieldCheck } from "lucide-react";
import { useI18n } from "../../../i18n";
import type { DataManagementState } from "../../../../preload";

type BackupRestoreTabProps = {
  state: DataManagementState | null;
};

export function BackupRestoreTab({
  state,
}: BackupRestoreTabProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="data-management-tab-content">
      <div className="data-management-hero">
        <div className="data-management-hero-icon">
          <DatabaseBackup size={20} strokeWidth={1.7} />
        </div>
        <div>
          <strong>
            {t("settings.dataManagementBackupTitle", {
              defaultValue: "Database snapshots and recovery",
            })}
          </strong>
          <p>
            {t("settings.dataManagementBackupInfo", {
              defaultValue:
                "Snapshots will use SQLite Online Backup so WAL writes remain consistent while the app is running.",
            })}
          </p>
        </div>
        <span className="data-management-phase-badge">
          {t("settings.dataManagementPhase1", { defaultValue: "Phase 1" })}
        </span>
      </div>

      <section className="data-management-card">
        <div className="data-management-card-heading">
          <ShieldCheck size={16} aria-hidden="true" />
          <strong>
            {t("settings.dataManagementSnapshotScope", {
              defaultValue: "Snapshot scope",
            })}
          </strong>
        </div>
        <div className="data-management-database-list">
          <div className="data-management-database-row">
            <Database size={15} aria-hidden="true" />
            <div>
              <strong>snowapp.db</strong>
              <span>
                {t("settings.dataManagementMainDatabase", {
                  defaultValue: "Main application database",
                })}
              </span>
            </div>
            <span className="data-management-scope-badge">
              {t("settings.dataManagementIncluded", {
                defaultValue: "Included",
              })}
            </span>
          </div>
          <div className="data-management-database-row">
            <Archive size={15} aria-hidden="true" />
            <div>
              <strong>archive.db</strong>
              <span>
                {t("settings.dataManagementArchiveDatabase", {
                  defaultValue: "Archived conversations",
                })}
              </span>
            </div>
            <span className="data-management-scope-badge">
              {t("settings.dataManagementIncluded", {
                defaultValue: "Included",
              })}
            </span>
          </div>
        </div>
      </section>

      <div className="data-management-card-grid">
        <section className="data-management-card">
          <div className="data-management-card-heading">
            <DatabaseBackup size={16} aria-hidden="true" />
            <strong>
              {t("settings.dataManagementManualSnapshot", {
                defaultValue: "Create a snapshot",
              })}
            </strong>
          </div>
          <p>
            {t("settings.dataManagementManualSnapshotInfo", {
              defaultValue:
                "Manual and automatic backup scheduling will be added with the staging and integrity-check pipeline.",
            })}
          </p>
          <button className="data-management-secondary-button" disabled type="button">
            {t("settings.dataManagementComingPhase1", {
              defaultValue: "Available in Phase 1",
            })}
          </button>
        </section>

        <section className="data-management-card">
          <div className="data-management-card-heading">
            <Archive size={16} aria-hidden="true" />
            <strong>
              {t("settings.dataManagementRestore", {
                defaultValue: "Restore safely",
              })}
            </strong>
          </div>
          <p>
            {t("settings.dataManagementRestoreInfo", {
              defaultValue:
                "Restoration will be staged and applied before storage initialization after an explicit app restart.",
            })}
          </p>
          <span className="data-management-muted-note">
            {state?.activeTask
              ? state.activeTask.phase
              : t("settings.dataManagementNoActiveTask", {
                  defaultValue: "No active task",
                })}
          </span>
        </section>
      </div>
    </div>
  );
}
