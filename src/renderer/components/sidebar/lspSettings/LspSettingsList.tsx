import { Download, Pencil, Trash2 } from "lucide-react";
import { useI18n } from "../../../i18n";

export type LspSettingsListItem = {
  lang: string;
  command: string;
  enabled: boolean;
  detail: string;
  source: string;
  /** 安装命令（未安装时显示「安装」按钮；空值不显示） */
  installCommand?: string;
  /** 继承自全局配置（项目作用域下 id 无 project: 前缀的条目）：交互禁用 */
  inherited: boolean;
};

type LspSettingsListProps = {
  servers: LspSettingsListItem[];
  isBusy: boolean;
  listTitle: string;
  emptyMessage: string;
  /** command → 是否已安装（PATH 探测结果，undefined = 未探测） */
  installedByCommand?: Readonly<Record<string, boolean>>;
  onToggleEnabled: (server: LspSettingsListItem) => void;
  onEdit: (server: LspSettingsListItem) => void;
  onDelete: (server: LspSettingsListItem) => void;
  onInstall: (server: LspSettingsListItem) => void;
};

export function LspSettingsList({
  servers,
  isBusy,
  listTitle,
  emptyMessage,
  installedByCommand,
  onToggleEnabled,
  onEdit,
  onDelete,
  onInstall,
}: LspSettingsListProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="api-settings-form-section">
      <div className="api-settings-form-section-header">
        <strong className="api-settings-form-section-title">{listTitle}</strong>
      </div>

      <div className="system-prompt-list mcp-server-list">
        {servers.length === 0 ? (
          <div className="system-prompt-empty">{emptyMessage}</div>
        ) : (
          servers.map((server) => {
            const activeLabel = server.enabled
              ? t("settings.lspDisableServer", { defaultValue: "Disable" })
              : t("settings.lspEnableServer", { defaultValue: "Enable" });
            const activeStateLabel = server.enabled
              ? t("settings.active", { defaultValue: "Active" })
              : t("settings.inactive", { defaultValue: "Inactive" });
            const installed = installedByCommand?.[server.command];
            const installLabel =
              installed === true
                ? t("settings.lspInstalled", {
                    defaultValue: "Installed",
                  })
                : installed === false
                  ? t("settings.lspNotInstalled", {
                      defaultValue: "Not installed",
                    })
                  : "";
            const inheritedHint = t("settings.lspInheritedHint", {
              defaultValue:
                "Inherited from global config. Edit it in the Global tab instead.",
            });
            // 继承条目的开关可独立切换（创建项目覆盖，仅影响本项目）；
            // 编辑/删除仍导向全局页签。
            const inheritedToggleHint = t("settings.lspInheritedToggleHint", {
              defaultValue:
                "Toggle creates a project-specific override for this project only.",
            });
            const editLabel = t("settings.edit", { defaultValue: "Edit" });
            const deleteLabel = t("settings.delete", { defaultValue: "Delete" });
            const switchTitle = server.inherited
              ? `${activeLabel}. ${inheritedToggleHint}`
              : activeLabel;
            const editTitle = server.inherited
              ? `${editLabel}. ${inheritedHint}`
              : editLabel;
            const deleteTitle = server.inherited
              ? `${deleteLabel}. ${inheritedHint}`
              : deleteLabel;

            return (
              <div
                key={server.lang}
                className={`system-prompt-item ${server.enabled ? "active" : ""}`}
              >
                <div className="system-prompt-item-main">
                  <label
                    className="toggle-switch system-prompt-switch"
                    aria-label={activeLabel}
                    title={switchTitle}
                  >
                    <input
                      type="checkbox"
                      checked={server.enabled}
                      onChange={() => onToggleEnabled(server)}
                      disabled={isBusy}
                      hidden
                    />
                    <span className="toggle-slider" />
                    <span>{activeStateLabel}</span>
                  </label>
                  <div className="system-prompt-item-info">
                    <div className="lsp-item-title-row">
                      <strong>{server.lang}</strong>
                      {server.inherited && (
                        <span className="lsp-inherited-badge">
                          {t("settings.lspInheritedBadge", {
                            defaultValue: "From global",
                          })}
                        </span>
                      )}
                    </div>
                    <span title={server.detail}>{server.detail || "-"}</span>
                  </div>
                </div>
                <div className="system-prompt-item-actions">
                  {installLabel && (
                    <span
                      className={`lsp-install-badge ${
                        installed ? "installed" : "missing"
                      }`}
                      title={server.command}
                    >
                      {installLabel}
                    </span>
                  )}
                  {installed === false && server.installCommand && (
                    <button
                      className="icon-btn ghost"
                      onClick={() => onInstall(server)}
                      type="button"
                      aria-label={t("settings.lspInstallServer", {
                        defaultValue: "Install",
                      })}
                      title={t("settings.lspInstallServer", {
                        defaultValue: "Install",
                      })}
                      disabled={isBusy}
                    >
                      <Download size={14} strokeWidth={1.9} />
                    </button>
                  )}
                  <button
                    className="icon-btn ghost"
                    onClick={() => onEdit(server)}
                    type="button"
                    aria-label={editLabel}
                    title={editTitle}
                    disabled={isBusy || server.inherited}
                  >
                    <Pencil size={14} strokeWidth={1.9} />
                  </button>
                  <button
                    className="icon-btn ghost danger"
                    onClick={() => onDelete(server)}
                    type="button"
                    aria-label={deleteLabel}
                    title={deleteTitle}
                    disabled={isBusy || server.inherited}
                  >
                    <Trash2 size={14} strokeWidth={1.9} />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
