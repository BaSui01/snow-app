import {
  Folder,
  Globe2,
  Loader2,
  Plus,
  Power,
  RefreshCw,
  ScanSearch,
  Undo2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LspServerConfigRecord,
  ProjectStackDetection,
  WorkspaceDirectoryRecord,
} from "../../../preload";
import { useI18n } from "../../i18n";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { Modal } from "../common/Modal";
import { LspSettingsEditor, LspSettingsEditorActions } from "./lspSettings/LspSettingsEditor";
import {
  LspSettingsList,
  type LspSettingsListItem,
} from "./lspSettings/LspSettingsList";
import { LspSettingsSummary } from "./lspSettings/LspSettingsSummary";
import {
  createLspStringItem,
  toDraft,
  toInput,
  validateInitializationOptions,
} from "./lspSettings/lspSettingsUtils";
import type { LspServerConfig, LspServerDraft } from "./lspSettings/types";

type LspSettingsPanelProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
  onClose?: () => void;
};

type LspScope = "global" | "project";

const EMPTY_LSP_DRAFT: LspServerDraft = {
  id: "",
  lang: "",
  command: "",
  args: [],
  fileExtensions: [],
  installCommand: "",
  initializationOptions: "",
  enabled: true,
  sortOrder: 0,
  source: "manual",
};

export function LspSettingsPanel({
  activeDirectory,
  onClose,
}: LspSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [activeScope, setActiveScope] = useState<LspScope>("global");
  const [servers, setServers] = useState<LspServerConfig[]>([]);
  const [installedByCommand, setInstalledByCommand] = useState<
    Record<string, boolean>
  >({});
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isProbing, setIsProbing] = useState(false);
  const [pendingInstall, setPendingInstall] =
    useState<LspSettingsListItem | null>(null);
  const [isInstalling, setIsInstalling] = useState(false);
  const [draft, setDraft] = useState<LspServerDraft | null>(null);
  const [pendingDelete, setPendingDelete] = useState<LspSettingsListItem | null>(
    null
  );
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [stackDetections, setStackDetections] = useState<
    ProjectStackDetection[] | null
  >(null);
  const [isDetecting, setIsDetecting] = useState(false);
  const loadGenerationRef = useRef(0);

  const isBusy =
    isLoading || isSaving || isProbing || isInstalling || isDetecting;
  const isGlobalScope = activeScope === "global";
  const operationProjectId = activeDirectory?.directoryId;

  const load = useCallback(async (): Promise<void> => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    setIsLoading(true);
    setError("");

    try {
      const [items, probes] = await Promise.all([
        isGlobalScope
          ? window.snow.listLspServerConfigs()
          : operationProjectId
            ? window.snow.listEffectiveLspServerConfigs(operationProjectId)
            : Promise.resolve([]),
        window.snow.probeLspServerCommands(
          isGlobalScope ? undefined : operationProjectId
        ),
      ]);
      if (loadGenerationRef.current !== generation) {
        return;
      }
      setServers(items);
      setInstalledByCommand(
        Object.fromEntries(
          probes.map((probe) => [probe.command, probe.installed])
        )
      );
    } catch (loadError) {
      if (loadGenerationRef.current === generation) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : t("settings.lspLoadError", {
                defaultValue: "Failed to load LSP server configs",
              })
        );
      }
    } finally {
      if (loadGenerationRef.current === generation) {
        setIsLoading(false);
      }
    }
  }, [isGlobalScope, operationProjectId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!activeDirectory && activeScope === "project") {
      setActiveScope("global");
    }
  }, [activeDirectory, activeScope]);

  // 手动「重新检测」：只刷新安装状态，不重新加载列表（轻量）。
  const reprobe = useCallback(async (): Promise<void> => {
    setIsProbing(true);
    setError("");
    try {
      const probes = await window.snow.probeLspServerCommands(
        isGlobalScope ? undefined : operationProjectId
      );
      setInstalledByCommand(
        Object.fromEntries(
          probes.map((probe) => [probe.command, probe.installed])
        )
      );
      setStatus(
        t("settings.lspRecheckDone", {
          defaultValue: "Installation status refreshed.",
        })
      );
    } catch (probeError) {
      setError(
        probeError instanceof Error
          ? probeError.message
          : t("settings.lspProbeError", {
              defaultValue: "Failed to detect language servers",
            })
      );
    } finally {
      setIsProbing(false);
    }
  }, [isGlobalScope, operationProjectId, t]);

  // 技术栈检测：扫描项目根目录（纯文件系统，无副作用），结果与 effective 列表对比展示状态。
  const detectStack = async (): Promise<void> => {
    if (!activeDirectory) return;
    setIsDetecting(true);
    setError("");
    try {
      const detections = await window.snow.detectProjectStack(
        activeDirectory.path
      );
      setStackDetections(detections);
    } catch (detectError) {
      setError(
        detectError instanceof Error
          ? detectError.message
          : t("settings.lspStackDetectError", {
              defaultValue: "Failed to detect project stack",
            })
      );
    } finally {
      setIsDetecting(false);
    }
  };

  // 安装语言服务器：确认对话框展示确切命令 → 执行 installCommand → 重新探测。
  const confirmInstall = async (): Promise<void> => {
    const pending = pendingInstall;
    if (!pending) return;
    const config = servers.find((item) => item.lang === pending.lang);
    if (!config?.installCommand) return;

    setPendingInstall(null);
    setIsInstalling(true);
    setError("");
    setStatus(
      t("settings.lspInstallRunning", {
        defaultValue: "Installing language server...",
        values: { lang: pending.lang },
      })
    );
    try {
      const result = await window.snow.installLspServer(
        pending.lang,
        isGlobalScope ? undefined : operationProjectId
      );
      if (result.exitCode === 0) {
        setStatus(
          t("settings.lspInstallSuccess", {
            defaultValue: "Installed language server for {{lang}}.",
            values: { lang: pending.lang },
          })
        );
      } else {
        setError(
          t("settings.lspInstallFailed", {
            defaultValue:
              "Install failed (exit {{code}}): {{output}}",
            values: {
              lang: pending.lang,
              code: String(result.exitCode ?? "?"),
              output: result.output.trim().slice(-1500),
            },
          })
        );
      }
      // 安装后立即重新探测，徽标状态即时更新。
      const probes = await window.snow.probeLspServerCommands(
        isGlobalScope ? undefined : operationProjectId
      );
      setInstalledByCommand(
        Object.fromEntries(
          probes.map((probe) => [probe.command, probe.installed])
        )
      );
    } catch (installError) {
      setError(
        installError instanceof Error
          ? installError.message
          : t("settings.lspInstallError", {
              defaultValue: "Failed to install language server",
            })
      );
    } finally {
      setIsInstalling(false);
    }
  };

  useEffect(() => {
    setDraft(null);
    setStatus("");
    setError("");
    setStackDetections(null);
  }, [activeDirectory?.directoryId]);

  const startAdd = (): void => {
    const maxSortOrder = servers.reduce(
      (max, server) => Math.max(max, server.sortOrder),
      -1
    );
    setDraft({
      ...EMPTY_LSP_DRAFT,
      sortOrder: maxSortOrder + 1,
      source: isGlobalScope ? "manual" : "project",
    });
    setError("");
    setStatus("");
  };

  const startEdit = (server: LspServerConfigRecord): void => {
    setDraft(toDraft(server));
    setError("");
    setStatus("");
  };

  const cancelDraft = (): void => {
    setDraft(null);
    setError("");
  };

  const patchDraft = (patch: Partial<LspServerDraft>): void => {
    setDraft((previous) => (previous ? { ...previous, ...patch } : null));
  };

  const updateItem = (
    group: "args" | "fileExtensions",
    itemId: string,
    value: string
  ): void => {
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            [group]: previous[group].map((item) =>
              item.id === itemId ? { ...item, value } : item
            ),
          }
        : null
    );
  };

  const addItem = (group: "args" | "fileExtensions"): void => {
    setDraft((previous) =>
      previous
        ? { ...previous, [group]: [...previous[group], createLspStringItem()] }
        : null
    );
  };

  const removeItem = (
    group: "args" | "fileExtensions",
    itemId: string
  ): void => {
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            [group]: previous[group].filter((item) => item.id !== itemId),
          }
        : null
    );
  };

  const saveDraft = async (): Promise<void> => {
    if (!draft) return;

    const lang = draft.lang.trim();
    if (!lang) {
      setError(
        t("settings.lspLangRequired", {
          defaultValue: "Language is required.",
        })
      );
      setStatus("");
      return;
    }

    if (!draft.command.trim()) {
      setError(
        t("settings.lspCommandRequired", {
          defaultValue: "Command is required.",
        })
      );
      setStatus("");
      return;
    }

    const initOptionsError = validateInitializationOptions(
      draft.initializationOptions
    );
    if (initOptionsError) {
      setError(initOptionsError);
      setStatus("");
      return;
    }

    // 语言唯一键校验：编辑自身除外（upsert 按 lang 冲突更新）。
    // 项目作用域只与项目覆盖条目比较（允许添加与继承条目同 lang 的覆盖）。
    const duplicate = servers.find(
      (server) =>
        server.lang === lang &&
        server.id !== draft.id &&
        (activeScope === "global" || server.id.startsWith("project:"))
    );
    if (duplicate) {
      setError(
        t("settings.lspDuplicateLang", {
          defaultValue:
            "Language {{lang}} is already configured. Edit the existing entry instead.",
          values: { lang },
        })
      );
      setStatus("");
      return;
    }

    const operationScope = activeScope;
    if (operationScope === "project" && !operationProjectId) {
      setError(
        t("settings.lspProjectRequired", {
          defaultValue: "Select a project before saving project LSP servers.",
        })
      );
      return;
    }

    setIsSaving(true);
    setError("");
    setStatus("");

    try {
      const items =
        operationScope === "global"
          ? await window.snow.upsertLspServerConfig(toInput(draft))
          : await window.snow.upsertProjectLspServerConfig(
              operationProjectId as string,
              toInput(draft)
            );
      setServers(items);
      setDraft(null);
      setStatus(
        draft.id
          ? t("settings.lspSaveSuccess", {
              defaultValue: "Saved language server.",
            })
          : t("settings.lspAddSuccess", {
              defaultValue: "Added language server.",
            })
      );
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : t("settings.lspSaveError", {
              defaultValue: "Failed to save language server",
            })
      );
    } finally {
      setIsSaving(false);
    }
  };

  const toggleEnabled = async (server: LspServerConfig): Promise<void> => {
    setError("");
    setStatus("");

    const input = {
      lang: server.lang,
      command: server.command,
      argsJson: server.argsJson,
      fileExtensionsJson: server.fileExtensionsJson,
      // napi Option<String> 不接受 null：空值省略字段
      ...(server.installCommand ? { installCommand: server.installCommand } : {}),
      ...(server.initializationOptionsJson
        ? { initializationOptionsJson: server.initializationOptionsJson }
        : {}),
      enabled: !server.enabled,
      sortOrder: server.sortOrder,
      source: server.source,
    };

    try {
      const items = isGlobalScope
        ? await window.snow.upsertLspServerConfig(input)
        : await window.snow.upsertProjectLspServerConfig(
            operationProjectId as string,
            input
          );
      setServers(items);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : t("settings.lspSaveError", {
              defaultValue: "Failed to update language server",
            })
      );
    }
  };

  // 「一键启用」：对检测结果中 effective 已配置且未启用的 lang，复制记录字段
  // 创建项目覆盖（enabled=true，source=project）；未配置的 lang 没有命令可复制，跳过。
  const enableDetected = async (): Promise<void> => {
    if (!operationProjectId || !stackDetections) return;
    setIsSaving(true);
    setError("");
    try {
      let items = servers;
      for (const detection of stackDetections) {
        const existing = servers.find((s) => s.lang === detection.lang);
        if (!existing || existing.enabled) continue;
        items = await window.snow.upsertProjectLspServerConfig(
          operationProjectId,
          {
            lang: existing.lang,
            command: existing.command,
            argsJson: existing.argsJson,
            fileExtensionsJson: existing.fileExtensionsJson,
            // napi Option<String> 不接受 null：空值省略字段
            ...(existing.installCommand
              ? { installCommand: existing.installCommand }
              : {}),
            ...(existing.initializationOptionsJson
              ? { initializationOptionsJson: existing.initializationOptionsJson }
              : {}),
            enabled: true,
            sortOrder: existing.sortOrder,
            source: "project",
          }
        );
      }
      // 最后一次 upsert 返回的 effective 合并视图即为最新列表。
      setServers(items);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : t("settings.lspSaveError", {
              defaultValue: "Failed to enable detected language servers",
            })
      );
    } finally {
      setIsSaving(false);
    }
  };

  // 「一键卸载」：移除检测 lang 集合中存在的项目覆盖（id 前缀 project:），
  // 回退全局继承；不动全局配置。
  const removeDetectedOverrides = async (): Promise<void> => {
    if (!operationProjectId || !stackDetections) return;
    const detectedLangs = new Set(stackDetections.map((d) => d.lang));
    const overrides = servers.filter(
      (s) => s.id.startsWith("project:") && detectedLangs.has(s.lang)
    );
    if (overrides.length === 0) return;
    setIsSaving(true);
    setError("");
    try {
      let items = servers;
      for (const server of overrides) {
        items = await window.snow.deleteProjectLspServerConfig(
          operationProjectId,
          server.lang
        );
      }
      // 最后一次 delete 返回的 effective 合并视图即为最新列表。
      setServers(items);
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : t("settings.lspDeleteError", {
              defaultValue: "Failed to remove detected overrides",
            })
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleListToggle = (server: LspSettingsListItem): void => {
    const config = servers.find((item) => item.lang === server.lang);
    if (config) {
      void toggleEnabled(config);
    }
  };

  const handleListEdit = (server: LspSettingsListItem): void => {
    const config = servers.find((item) => item.lang === server.lang);
    if (config) {
      startEdit(config);
    }
  };

  const handleListDelete = (server: LspSettingsListItem): void => {
    setPendingDelete(server);
  };

  const confirmDelete = async (): Promise<void> => {
    const pending = pendingDelete;
    if (!pending) {
      return;
    }
    setPendingDelete(null);
    setIsSaving(true);
    setError("");
    setStatus("");

    try {
      const items = isGlobalScope
        ? await window.snow.deleteLspServerConfig(pending.lang)
        : await window.snow.deleteProjectLspServerConfig(
            operationProjectId as string,
            pending.lang
          );
      setServers(items);
      setStatus(
        t("settings.lspDeleteSuccess", {
          defaultValue: "Deleted language server.",
        })
      );
    } catch (deleteError) {
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : t("settings.lspDeleteError", {
              defaultValue: "Failed to delete language server",
            })
      );
    } finally {
      setIsSaving(false);
    }
  };

  const listItems: LspSettingsListItem[] = servers.map((server) => ({
    lang: server.lang,
    command: server.command,
    enabled: server.enabled,
    detail: `${server.command}${server.argsJson && server.argsJson !== "[]" ? " " + server.argsJson : ""}`,
    source: server.source,
    installCommand: server.installCommand ?? undefined,
    // 项目作用域下：id 不带 project: 前缀 = 继承自全局配置（不可在项目页签直接编辑）。
    inherited: !server.id.startsWith("project:") && !isGlobalScope,
  }));
  const enabledCount = listItems.filter((server) => server.enabled).length;
  const listTitle = t("settings.lspServerListTitle", {
    defaultValue: "Language servers",
  });
  const emptyMessage = t("settings.lspNoServers", {
    defaultValue:
      "No language servers configured. Add one to enable lsp-diagnostics / lsp-hover for its language.",
  });

  // 检测结果与 effective 列表对比：可一键启用 = 存在已配置但未启用的 lang；
  // 可一键卸载 = 检测 lang 集合里存在项目覆盖条目。
  const detectedLangs = new Set(
    (stackDetections ?? []).map((detection) => detection.lang)
  );
  const canEnableDetected =
    stackDetections !== null &&
    stackDetections.some((detection) => {
      const existing = servers.find((s) => s.lang === detection.lang);
      return existing !== undefined && !existing.enabled;
    });
  const canRemoveDetected =
    stackDetections !== null &&
    servers.some(
      (server) =>
        server.id.startsWith("project:") && detectedLangs.has(server.lang)
    );

  return (
    <div className="api-settings-page" role="region">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>
            {t("settings.lspTitle", { defaultValue: "LSP settings" })}
          </strong>
          <span className="settings-item-description">
            {t("settings.lspSettingsInfo", {
              defaultValue:
                "Configure external language servers (rust-analyzer, gopls, pyright ...) for lsp-diagnostics / lsp-hover.",
            })}
          </span>
        </div>
        {onClose && (
          <button
            className="icon-btn ghost"
            onClick={onClose}
            type="button"
            aria-label={t("settings.closeLspSettings", {
              defaultValue: "Close LSP settings",
            })}
            title={t("settings.closeLspSettings", {
              defaultValue: "Close LSP settings",
            })}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        )}
      </div>

      <LspSettingsSummary
        totalCount={listItems.length}
        enabledCount={enabledCount}
      />

      <div
        className={`api-settings-actions ${
          !isGlobalScope ? "lsp-settings-actions" : ""
        }`}
      >
        <button
          className="api-settings-action-btn secondary"
          onClick={() => void reprobe()}
          type="button"
          disabled={isBusy || isLoading}
          title={t("settings.lspRecheck", {
            defaultValue: "Re-check installation status",
          })}
        >
          {isProbing ? (
            <Loader2 size={15} className="spin" />
          ) : (
            <RefreshCw size={15} />
          )}
          <span>
            {t("settings.lspRecheck", {
              defaultValue: "Re-check",
            })}
          </span>
        </button>
        <button
          className="api-settings-action-btn secondary"
          onClick={startAdd}
          type="button"
          disabled={isBusy || (!isGlobalScope && !activeDirectory)}
        >
          <Plus size={15} />
          <span>
            {t("settings.lspAddNew", { defaultValue: "Add language" })}
          </span>
        </button>
        {!isGlobalScope && (
          <button
            className="api-settings-action-btn secondary"
            onClick={() => void detectStack()}
            type="button"
            disabled={
              isBusy || !activeDirectory || activeDirectory.kind === "ssh"
            }
            title={
              activeDirectory?.kind === "ssh"
                ? t("settings.lspStackSshUnsupported", {
                    defaultValue:
                      "Stack detection is not supported for remote projects",
                  })
                : t("settings.lspDetectStack", {
                    defaultValue: "Detect stack",
                  })
            }
          >
            {isDetecting ? (
              <Loader2 size={15} className="spin" />
            ) : (
              <ScanSearch size={15} strokeWidth={1.8} />
            )}
            <span>
              {t("settings.lspDetectStack", {
                defaultValue: "Detect stack",
              })}
            </span>
          </button>
        )}
      </div>

      <AutoDismissNotice
        message={error || status}
        tone={error ? "error" : "success"}
        onDismiss={() => {
          setError("");
          setStatus("");
        }}
      />

      <div
        className="skills-settings-tabs"
        role="tablist"
        aria-label={t("settings.lspScopeTabs", { defaultValue: "LSP scope" })}
      >
        <button
          className={`skills-settings-tab ${isGlobalScope ? "active" : ""}`}
          type="button"
          role="tab"
          aria-selected={isGlobalScope}
          onClick={() => setActiveScope("global")}
        >
          <Globe2 size={14} strokeWidth={1.8} />
          <span>{t("settings.lspTabGlobal", { defaultValue: "Global" })}</span>
        </button>
        <button
          className={`skills-settings-tab ${!isGlobalScope ? "active" : ""}`}
          type="button"
          role="tab"
          aria-selected={!isGlobalScope}
          onClick={() => setActiveScope("project")}
          disabled={!activeDirectory}
        >
          <Folder size={14} strokeWidth={1.8} />
          <span>{t("settings.lspTabProject", { defaultValue: "Project" })}</span>
        </button>
      </div>

      {!isGlobalScope &&
        stackDetections !== null &&
        stackDetections.length > 0 && (
          <div className="lsp-stack-detect-panel">
            <div className="lsp-stack-detect-header">
              <strong>
                {t("settings.lspStackDetectTitle", {
                  defaultValue: "Detected project stack",
                })}
              </strong>
              <span className="lsp-stack-detect-count">
                {t("settings.lspStackDetected", {
                  defaultValue: "{{count}} language(s) detected",
                  values: { count: String(stackDetections.length) },
                })}
              </span>
            </div>
            <div className="lsp-stack-detect-list">
              {stackDetections.map((detection) => {
                const existing = servers.find(
                  (s) => s.lang === detection.lang
                );
                const enabled = existing?.enabled === true;
                const statusLabel = enabled
                  ? t("settings.lspStackGlobalEnabled", {
                      defaultValue: "Enabled (global)",
                    })
                  : existing
                    ? t("settings.lspStackDisabled", {
                        defaultValue: "Disabled",
                      })
                    : t("settings.lspStackNotConfigured", {
                        defaultValue: "Not configured",
                      });
                return (
                  <div
                    key={`${detection.path}:${detection.lang}`}
                    className="lsp-stack-detect-row"
                  >
                    <span
                      className="lsp-stack-detect-path"
                      title={detection.path || "/"}
                    >
                      {detection.path || "/"}
                    </span>
                    <span className="lsp-stack-detect-lang">
                      {detection.lang}
                    </span>
                    <span className="lsp-stack-detect-marker">
                      {detection.marker}
                    </span>
                    <span
                      className={`lsp-stack-detect-badge ${
                        enabled ? "enabled" : "muted"
                      }`}
                    >
                      {statusLabel}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="lsp-stack-detect-actions">
              <button
                className="api-settings-action-btn secondary"
                onClick={() => void enableDetected()}
                type="button"
                disabled={isBusy || !canEnableDetected}
                title={t("settings.lspEnableDetected", {
                  defaultValue: "Enable detected",
                })}
              >
                <Power size={15} strokeWidth={1.8} />
                <span>
                  {t("settings.lspEnableDetected", {
                    defaultValue: "Enable detected",
                  })}
                </span>
              </button>
              <button
                className="api-settings-action-btn secondary"
                onClick={() => void removeDetectedOverrides()}
                type="button"
                disabled={isBusy || !canRemoveDetected}
                title={t("settings.lspRemoveDetected", {
                  defaultValue: "Remove overrides",
                })}
              >
                <Undo2 size={15} strokeWidth={1.8} />
                <span>
                  {t("settings.lspRemoveDetected", {
                    defaultValue: "Remove overrides",
                  })}
                </span>
              </button>
            </div>
          </div>
        )}

      <div className="api-settings-manual-form">
        <div className="api-settings-manual-header">
          <strong>{listTitle}</strong>
          <span>
            {isGlobalScope
              ? t("settings.lspGlobalTabInfo", {
                  defaultValue:
                    "Manage language servers shared by all projects.",
                })
              : t("settings.lspProjectTabInfo", {
                  defaultValue:
                    "Manage project-specific language servers for {{name}}. Project configs override the global ones for the same language.",
                  values: { name: activeDirectory?.name ?? "" },
                })}
          </span>
        </div>

        <div className="api-settings-form-body">
          {isLoading ? (
            <div className="main-content-loading" role="status">
              <Loader2 size={22} className="spin" aria-hidden="true" />
              <span>{t("common.loading")}</span>
            </div>
          ) : (
            <LspSettingsList
              servers={listItems}
              isBusy={isBusy}
              listTitle={listTitle}
              emptyMessage={emptyMessage}
              installedByCommand={installedByCommand}
              onToggleEnabled={handleListToggle}
              onEdit={handleListEdit}
              onDelete={handleListDelete}
              onInstall={setPendingInstall}
            />
          )}
        </div>
      </div>

      <Modal
        open={Boolean(draft)}
        title={t("settings.lspEditorTitle", {
          defaultValue: "Language server editor",
        })}
        description={draft?.lang || t("settings.lspAddNew", { defaultValue: "Add language" })}
        closeLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onClose={cancelDraft}
        closeDisabled={isBusy}
        size="large"
        className="lsp-settings-editor-modal"
        footer={
          draft && (
            <LspSettingsEditorActions
              isBusy={isBusy}
              isSaving={isSaving}
              onCancel={cancelDraft}
            />
          )
        }
      >
        {draft && (
          <LspSettingsEditor
            draft={draft}
            isBusy={isBusy}
            isSaving={isSaving}
            onDraftChange={patchDraft}
            onUpdateItem={updateItem}
            onAddItem={addItem}
            onRemoveItem={removeItem}
            onCancel={cancelDraft}
            onSave={() => void saveDraft()}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={t("settings.lspDeleteConfirmTitle", {
          defaultValue: "Delete language server",
        })}
        message={t("settings.lspDeleteConfirm", {
          defaultValue:
            "Delete the language server for {{lang}}? lsp-diagnostics / lsp-hover will no longer work for this language.",
          values: { lang: pendingDelete?.lang ?? "" },
        })}
        confirmLabel={t("settings.delete", { defaultValue: "Delete" })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        variant="danger"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        open={Boolean(pendingInstall)}
        title={t("settings.lspInstallConfirmTitle", {
          defaultValue: "Install language server",
        })}
        message={t("settings.lspInstallConfirm", {
          defaultValue:
            "Run the install command for {{lang}}?\n\n{{command}}\n\nThis may modify your system environment (global install).",
          values: {
            lang: pendingInstall?.lang ?? "",
            command: pendingInstall?.installCommand ?? "",
          },
        })}
        confirmLabel={t("settings.lspInstallServer", {
          defaultValue: "Install",
        })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        variant="warning"
        onConfirm={() => void confirmInstall()}
        onCancel={() => setPendingInstall(null)}
      />
    </div>
  );
}
