import {
  Download,
  Folder,
  Globe2,
  Loader2,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  McpProjectServerStatus,
  WorkspaceDirectoryRecord,
} from "../../../preload";
import { useI18n } from "../../i18n";
import { AutoDismissNotice } from "../AutoDismissNotice";
import { ConfirmDialog } from "../common/ConfirmDialog";
import { Modal } from "../common/Modal";
import { LITE_MODE_CHANGED_EVENT } from "../mainContent/chatMessages/hooks/useToolAuthorization";
import {
  McpSettingsEditor,
  McpSettingsEditorActions,
} from "./mcpSettings/McpSettingsEditor";
import {
  McpSettingsList,
  type McpSettingsListItem,
} from "./mcpSettings/McpSettingsList";
import { McpSettingsSummary } from "./mcpSettings/McpSettingsSummary";
import { formatMcpError } from "./mcpSettings/mcpErrorMessages";
import { builtinServerDescriptionKey } from "./mcpSettings/builtinServerDescriptions";
import {
  EMPTY_MCP_SERVER_DRAFT,
  createMcpPair,
  createMcpStringItem,
  getMcpServerEndpoint,
  hasDuplicatePairKey,
  toDraft,
  toInput,
  toProjectInput,
} from "./mcpSettings/mcpSettingsUtils";
import type {
  McpServerConfig,
  McpServerConfigLike,
  McpServerDraft,
  McpServerTool,
  ProjectMcpServerConfig,
} from "./mcpSettings/types";

type McpSettingsPanelProps = {
  activeDirectory?: WorkspaceDirectoryRecord | null;
  onClose?: () => void;
};

type McpScope = "global" | "project";

/**
 * 后台补发现项目服务器工具时的并发上限。与 Rust 端全量发现的并发度分开：
 * 这里逐台触发单服务器发现（内部读写进程内缓存），喂满并发即可，
 * 不必把设置面板变成连接风暴。
 */
const PROJECT_TOOL_DISCOVERY_CONCURRENCY = 3;

/**
 * 把服务器列表里已返回的工具合并进本地缓存（工具为空的服务器保留旧值，
 * 避免快速列表 + 后台发现期间列表闪空）。
 */
const mergeServerTools = (
  previous: Record<string, McpServerTool[]>,
  servers: McpProjectServerStatus[],
): Record<string, McpServerTool[]> => {
  const next = { ...previous };
  servers.forEach((server) => {
    if (server.tools.length > 0) {
      next[server.id] = server.tools;
    }
  });
  return next;
};

export function McpSettingsPanel({
  activeDirectory,
  onClose,
}: McpSettingsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [activeScope, setActiveScope] = useState<McpScope>("global");
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [projectServers, setProjectServers] = useState<
    McpProjectServerStatus[]
  >([]);
  const [projectServerConfigs, setProjectServerConfigs] = useState<
    ProjectMcpServerConfig[]
  >([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{
    server: McpSettingsListItem;
    scope: McpScope;
  } | null>(null);
  const [draft, setDraft] = useState<McpServerDraft | null>(null);
  const [toolsByServerId, setToolsByServerId] = useState<
    Record<string, McpServerTool[]>
  >({});
  const [fetchingToolServerIds, setFetchingToolServerIds] = useState<
    Set<string>
  >(() => new Set());
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const loadGenerationRef = useRef(0);
  // 正在进行后台工具发现的服务器（按 scope 服务器 id 去重），
  // 避免同一台服务器被并发发现两次。
  const discoveringServerIdsRef = useRef<Set<string>>(new Set());

  const isBusy = isLoading || isSaving;

  /**
   * 单台项目服务器的工具发现：调用 Rust 端发现（内部读写进程内缓存），
   * 成功后写入 toolsByServerId。后台补发现与手动「获取工具」共用。
   */
  const fetchProjectServerTools = useCallback(
    async (
      projectId: string,
      scopeServerId: string,
      generation: number,
    ): Promise<McpServerTool[]> => {
      const tools = await window.snow.listMcpProjectServerTools(
        projectId,
        scopeServerId,
      );
      if (loadGenerationRef.current === generation) {
        setToolsByServerId((previous) => ({
          ...previous,
          [scopeServerId]: tools,
        }));
      }
      return tools;
    },
    [],
  );

  /**
   * 后台补发现 `toolsPending` 的服务器：并发上限
   * PROJECT_TOOL_DISCOVERY_CONCURRENCY，逐台显示「发现中」，单台失败静默
   * （工具数保持待获取，用户可手动重试）。整个过程不阻塞列表刷新与保存。
   */
  const discoverPendingProjectServers = useCallback(
    async (
      projectId: string,
      servers: McpProjectServerStatus[],
      generation: number,
    ): Promise<void> => {
      const pendingIds = servers
        .filter((server) => server.toolsPending)
        .map((server) => server.id)
        .filter((serverId) => !discoveringServerIdsRef.current.has(serverId));
      if (pendingIds.length === 0) {
        return;
      }
      pendingIds.forEach((serverId) =>
        discoveringServerIdsRef.current.add(serverId),
      );
      setFetchingToolServerIds(
        (previous) => new Set([...previous, ...pendingIds]),
      );
      // 可变工作队列：多个 worker 共同消费（updater 里用的是上面的快照）。
      const queue = [...pendingIds];

      const worker = async (): Promise<void> => {
        for (;;) {
          const serverId = queue.shift();
          if (!serverId) {
            return;
          }
          try {
            await fetchProjectServerTools(projectId, serverId, generation);
          } catch {
            // 后台发现失败不打扰用户：保留待获取状态，可手动重试。
          } finally {
            discoveringServerIdsRef.current.delete(serverId);
            setFetchingToolServerIds((previous) => {
              const next = new Set(previous);
              next.delete(serverId);
              return next;
            });
          }
        }
      };

      await Promise.all(
        Array.from(
          {
            length: Math.min(PROJECT_TOOL_DISCOVERY_CONCURRENCY, queue.length),
          },
          () => worker(),
        ),
      );
    },
    [fetchProjectServerTools],
  );

  /**
   * 快速刷新项目服务器列表：只读 Rust 端进程内工具缓存（不连接服务器），
   * 待发现的服务器交给后台补发现。保存 / 启停 / 删除配置后的刷新都走它，
   * 保证配置写入立即返回，不被慢服务器的 connect + tools/list 拖住。
   */
  const refreshProjectServers = useCallback(
    async (projectId: string, generation: number): Promise<void> => {
      const nextServers =
        await window.snow.listMcpProjectServersCached(projectId);
      if (loadGenerationRef.current !== generation) {
        return;
      }
      setProjectServers(nextServers);
      setToolsByServerId((previous) => mergeServerTools(previous, nextServers));
      void discoverPendingProjectServers(projectId, nextServers, generation);
    },
    [discoverPendingProjectServers],
  );

  const load = useCallback(async (): Promise<void> => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    setIsLoading(true);
    setError("");

    try {
      const [globalItems, projectItems, projectConfigItems] = await Promise.all(
        [
          window.snow.listMcpServerConfigs(),
          activeDirectory
            ? window.snow.listMcpProjectServersCached(
                activeDirectory.directoryId,
              )
            : Promise.resolve([]),
          activeDirectory
            ? window.snow.listProjectMcpServerConfigs(
                activeDirectory.directoryId,
              )
            : Promise.resolve([]),
        ],
      );
      if (loadGenerationRef.current !== generation) {
        return;
      }

      setServers(globalItems);
      setProjectServers(projectItems);
      setProjectServerConfigs(projectConfigItems);
      setToolsByServerId((previous) =>
        mergeServerTools(previous, projectItems),
      );
      // 列表先渲染，工具在后台逐台发现（列表项显示「发现中」）。
      if (activeDirectory) {
        void discoverPendingProjectServers(
          activeDirectory.directoryId,
          projectItems,
          generation,
        );
      }
    } catch (loadError) {
      if (loadGenerationRef.current === generation) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : t("settings.mcpLoadError", {
                defaultValue: "Failed to load MCP servers",
              }),
        );
      }
    } finally {
      if (loadGenerationRef.current === generation) {
        setIsLoading(false);
      }
    }
  }, [activeDirectory, t, discoverPendingProjectServers]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!activeDirectory && activeScope === "project") {
      setActiveScope("global");
    }
  }, [activeDirectory, activeScope]);

  useEffect(() => {
    setDraft(null);
    setProjectServers([]);
    setProjectServerConfigs([]);
    setToolsByServerId({});
    setFetchingToolServerIds(new Set());
    setStatus("");
    setError("");
  }, [activeDirectory?.directoryId]);

  const handleImport = async () => {
    setIsLoading(true);
    setError("");
    setStatus("");

    try {
      await window.snow.importSnowCliMcpConfig();
      await load();
      setDraft(null);
      setStatus(
        t("settings.mcpImportSuccess", {
          defaultValue: "Synced MCP servers from Snow CLI.",
        }),
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.mcpImportError", {
              defaultValue: "Failed to sync Snow CLI MCP settings",
            }),
      );
    } finally {
      setIsLoading(false);
    }
  };

  const startAdd = () => {
    const scopedServers =
      activeScope === "global" ? servers : projectServerConfigs;
    const maxSortOrder = scopedServers.reduce(
      (max, server) => Math.max(max, server.sortOrder),
      -1,
    );
    setDraft({
      ...EMPTY_MCP_SERVER_DRAFT,
      sortOrder: maxSortOrder + 1,
      source: activeScope === "global" ? "manual" : "project",
    });
    setError("");
    setStatus("");
  };

  const startEdit = (server: McpServerConfigLike) => {
    setDraft(toDraft(server));
    setError("");
    setStatus("");
  };

  const cancelDraft = () => {
    setDraft(null);
    setError("");
  };

  const patchDraft = (patch: Partial<McpServerDraft>) => {
    setDraft((previous) => (previous ? { ...previous, ...patch } : null));
  };

  const updatePair = (
    group: "env" | "headers",
    pairId: string,
    field: "key" | "value",
    value: string,
  ) => {
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            [group]: previous[group].map((pair) =>
              pair.id === pairId ? { ...pair, [field]: value } : pair,
            ),
          }
        : null,
    );
  };

  const addPair = (group: "env" | "headers") => {
    setDraft((previous) =>
      previous
        ? { ...previous, [group]: [...previous[group], createMcpPair()] }
        : null,
    );
  };

  const removePair = (group: "env" | "headers", pairId: string) => {
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            [group]: previous[group].filter((pair) => pair.id !== pairId),
          }
        : null,
    );
  };

  const updateArg = (argId: string, value: string) => {
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            args: previous.args.map((arg) =>
              arg.id === argId ? { ...arg, value } : arg,
            ),
          }
        : null,
    );
  };

  const addArg = () => {
    setDraft((previous) =>
      previous
        ? { ...previous, args: [...previous.args, createMcpStringItem()] }
        : null,
    );
  };

  const removeArg = (argId: string) => {
    setDraft((previous) =>
      previous
        ? { ...previous, args: previous.args.filter((arg) => arg.id !== argId) }
        : null,
    );
  };

  const saveDraft = async () => {
    if (!draft) return;

    if (!draft.name.trim()) {
      setError(
        t("settings.mcpNameRequired", {
          defaultValue: "MCP server name is required.",
        }),
      );
      setStatus("");
      return;
    }

    if (draft.transportType === "http" && !draft.url.trim()) {
      setError(
        t("settings.mcpUrlRequired", { defaultValue: "URL is required." }),
      );
      setStatus("");
      return;
    }

    if (draft.transportType === "stdio" && !draft.command.trim()) {
      setError(
        t("settings.mcpCommandRequired", {
          defaultValue: "Command is required.",
        }),
      );
      setStatus("");
      return;
    }

    if (hasDuplicatePairKey(draft.env) || hasDuplicatePairKey(draft.headers)) {
      setError(
        t("settings.mcpDuplicateKey", {
          defaultValue: "Environment and header names must be unique.",
        }),
      );
      setStatus("");
      return;
    }

    const timeoutMs = draft.timeoutMs.trim() ? Number(draft.timeoutMs) : null;
    if (
      timeoutMs !== null &&
      (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    ) {
      setError(
        t("settings.mcpTimeoutInvalid", {
          defaultValue: "Timeout must be a positive integer.",
        }),
      );
      setStatus("");
      return;
    }

    const operationScope = activeScope;
    const operationProjectId = activeDirectory?.directoryId;
    const generation = loadGenerationRef.current;
    if (operationScope === "project" && !operationProjectId) {
      setError(
        t("settings.mcpProjectRequired", {
          defaultValue: "Select a project before saving a project MCP server.",
        }),
      );
      return;
    }
    setIsSaving(true);
    setError("");
    setStatus("");

    try {
      if (operationScope === "global") {
        const maxSortOrder = servers.reduce(
          (max, server) => Math.max(max, server.sortOrder),
          -1,
        );
        const items = await window.snow.upsertMcpServerConfig(
          toInput(draft, maxSortOrder + 1),
        );
        setServers(items);
      } else if (operationProjectId) {
        const maxSortOrder = projectServerConfigs.reduce(
          (max, server) => Math.max(max, server.sortOrder),
          -1,
        );
        const items = await window.snow.upsertProjectMcpServerConfig(
          operationProjectId,
          toProjectInput(draft, maxSortOrder + 1),
        );
        if (loadGenerationRef.current !== generation) {
          return;
        }
        setProjectServerConfigs(items);
        // 快速刷新（只读缓存）+ 后台补发现：保存本身不被工具发现阻塞。
        await refreshProjectServers(operationProjectId, generation);
      }

      setDraft(null);
      setStatus(
        draft.serverId
          ? t("settings.mcpSaveSuccess", {
              defaultValue: "Saved MCP server.",
            })
          : t("settings.mcpAddSuccess", {
              defaultValue: "Added MCP server.",
            }),
      );
    } catch (e) {
      if (
        operationScope === "global" ||
        loadGenerationRef.current === generation
      ) {
        setError(
          e instanceof Error
            ? e.message
            : t("settings.mcpSaveError", {
                defaultValue: "Failed to save MCP server",
              }),
        );
      }
    } finally {
      if (
        operationScope === "global" ||
        loadGenerationRef.current === generation
      ) {
        setIsSaving(false);
      }
    }
  };

  const toggleEnabled = async (server: McpServerConfig) => {
    setError("");
    setStatus("");

    try {
      const items = await window.snow.upsertMcpServerConfig({
        serverId: server.serverId,
        name: server.name,
        transportType: server.transportType,
        url: server.url,
        command: server.command,
        argsJson: server.argsJson,
        envJson: server.envJson,
        headersJson: server.headersJson,
        enabled: !server.enabled,
        ...(server.timeoutMs ? { timeoutMs: server.timeoutMs } : {}),
        sortOrder: server.sortOrder,
        source: server.source,
      });
      setServers(items);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.mcpSaveError", {
              defaultValue: "Failed to update MCP server",
            }),
      );
    }
  };

  const handleFetchTools = async (server: McpServerConfig) => {
    setFetchingToolServerIds((previous) => {
      const next = new Set(previous);
      next.add(server.serverId);
      return next;
    });
    setError("");
    setStatus("");

    try {
      const tools = await window.snow.listMcpServerTools(server.serverId);
      setToolsByServerId((previous) => ({
        ...previous,
        [server.serverId]: tools,
      }));
      setStatus(
        t("settings.mcpFetchToolsSuccess", {
          defaultValue: "Fetched {{count}} tool(s) from {{name}}.",
          values: { count: tools.length, name: server.name },
        }),
      );
    } catch (e) {
      setError(formatMcpError(e, t));
    } finally {
      setFetchingToolServerIds((previous) => {
        const next = new Set(previous);
        next.delete(server.serverId);
        return next;
      });
    }
  };

  const handleToggleTool = async (
    server: McpSettingsListItem,
    tool: McpServerTool,
    enabled: boolean,
  ): Promise<void> => {
    if (isBusy || !server.globalEnabled || !server.enabled) {
      return;
    }
    if (activeScope === "project" && !activeDirectory) {
      return;
    }
    setError("");
    setStatus("");

    const updateToolState = (nextEnabled: boolean): void => {
      setToolsByServerId((previous) => {
        const current = previous[server.serverId];
        if (!current) {
          return previous;
        }
        return {
          ...previous,
          [server.serverId]: current.map((item) =>
            item.name === tool.name ? { ...item, enabled: nextEnabled } : item,
          ),
        };
      });
    };

    updateToolState(enabled);
    try {
      if (activeScope === "global") {
        await window.snow.setMcpToolEnabled(tool.name, enabled);
      } else if (activeDirectory) {
        await window.snow.setMcpProjectToolEnabled(
          activeDirectory.directoryId,
          tool.name,
          enabled,
        );
      }
    } catch (e) {
      updateToolState(!enabled);
      setError(
        e instanceof Error
          ? formatMcpError(e, t)
          : t("settings.mcpToolToggleError", {
              defaultValue: "Failed to update MCP tool",
            }),
      );
    }
  };

  const handleToggleAllTools = async (
    server: McpSettingsListItem,
    enabled: boolean,
  ): Promise<void> => {
    if (isBusy || !server.globalEnabled || !server.enabled) {
      return;
    }
    if (activeScope === "project" && !activeDirectory) {
      return;
    }
    const tools = toolsByServerId[server.serverId];
    if (!tools || tools.length === 0) {
      return;
    }
    const toolNames = tools.map((tool) => tool.name);
    setError("");
    setStatus("");

    const updateAllToolsState = (nextEnabled: boolean): void => {
      setToolsByServerId((previous) => {
        const current = previous[server.serverId];
        if (!current) {
          return previous;
        }
        return {
          ...previous,
          [server.serverId]: current.map((item) => ({
            ...item,
            enabled: nextEnabled,
          })),
        };
      });
    };

    updateAllToolsState(enabled);
    try {
      if (activeScope === "global") {
        await window.snow.setMcpToolsEnabled(toolNames, enabled);
      } else if (activeDirectory) {
        await window.snow.setMcpProjectToolsEnabled(
          activeDirectory.directoryId,
          toolNames,
          enabled,
        );
      }
    } catch (e) {
      updateAllToolsState(!enabled);
      setError(
        e instanceof Error
          ? formatMcpError(e, t)
          : t("settings.mcpToolToggleError", {
              defaultValue: "Failed to update MCP tool",
            }),
      );
    }
  };

  const handleDelete = async (server: McpServerConfig) => {
    setError("");
    setStatus("");

    try {
      const items = await window.snow.deleteMcpServerConfig(server.serverId);
      setServers(items);
      setToolsByServerId((previous) => {
        const next = { ...previous };
        delete next[server.serverId];
        return next;
      });
      setStatus(
        t("settings.mcpDeleteSuccess", {
          defaultValue: "Deleted MCP server.",
        }),
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("settings.mcpDeleteError", {
              defaultValue: "Failed to delete MCP server",
            }),
      );
    }
  };

  const globalListItems: McpSettingsListItem[] = servers.map((server) => ({
    serverId: server.serverId,
    name: server.name,
    enabled: server.enabled,
    globalEnabled: true,
    detail: `${server.transportType} · ${getMcpServerEndpoint(server) || "-"}`,
    canManage: true,
  }));
  const projectListItems: McpSettingsListItem[] = projectServers.map(
    (server) => {
      const configServerId = server.id.replace(/^external:/, "");
      const projectConfig = projectServerConfigs.find(
        (item) => item.serverId === configServerId,
      );
      // 内置服务说明：内置服务固定不变，文案来自 i18n
      const descriptionKey = builtinServerDescriptionKey(server.id);
      const builtinDescription = descriptionKey ? t(descriptionKey) : "";
      const sourceDetail =
        server.source === "system"
          ? t("settings.mcpProjectSystemServer", {
              defaultValue: "Built-in system MCP server",
            })
          : server.source === "project"
            ? `${t("settings.mcpProjectOwnedServer", {
                defaultValue: "Project MCP server",
              })} · ${
                projectConfig
                  ? `${projectConfig.transportType} · ${
                      getMcpServerEndpoint(projectConfig) || "-"
                    }`
                  : "-"
              }`
            : t("settings.mcpProjectExternalServer", {
                defaultValue: "Global external MCP server",
              });
      return {
        serverId: server.id,
        name: server.name,
        enabled: server.enabled,
        globalEnabled: server.globalEnabled,
        detail: builtinDescription
          ? `${sourceDetail} · ${builtinDescription}`
          : sourceDetail,
        canManage: server.source === "project",
      };
    },
  );
  const isGlobalScope = activeScope === "global";
  const activeServers = isGlobalScope ? globalListItems : projectListItems;
  const enabledCount = activeServers.filter(
    (server) => server.enabled && server.globalEnabled,
  ).length;
  const listTitle = isGlobalScope
    ? t("settings.mcpGlobalListTitle", { defaultValue: "Global MCP servers" })
    : t("settings.mcpProjectListTitle", {
        defaultValue: "Project MCP servers",
      });
  const emptyMessage = isGlobalScope
    ? t("settings.mcpNoServers", {
        defaultValue:
          "No MCP servers yet. Sync from Snow CLI settings.json or add one manually.",
      })
    : t("settings.mcpProjectNoServers", {
        defaultValue: "No MCP servers are available for this project.",
      });

  const handleProjectToggle = async (
    server: McpSettingsListItem,
  ): Promise<void> => {
    if (!activeDirectory || !server.globalEnabled || isBusy) {
      return;
    }

    const operationProjectId = activeDirectory.directoryId;
    const generation = loadGenerationRef.current;
    const configServerId = server.serverId.replace(/^external:/, "");
    const projectConfig = projectServerConfigs.find(
      (item) => item.serverId === configServerId,
    );
    setIsSaving(true);
    setError("");
    setStatus("");
    try {
      if (projectConfig) {
        await window.snow.upsertProjectMcpServerConfig(operationProjectId, {
          serverId: projectConfig.serverId,
          name: projectConfig.name,
          transportType: projectConfig.transportType,
          url: projectConfig.url,
          command: projectConfig.command,
          argsJson: projectConfig.argsJson,
          envJson: projectConfig.envJson,
          headersJson: projectConfig.headersJson,
          enabled: !projectConfig.enabled,
          ...(projectConfig.timeoutMs
            ? { timeoutMs: projectConfig.timeoutMs }
            : {}),
          sortOrder: projectConfig.sortOrder,
          source: "project",
        });
      } else {
        await window.snow.setMcpProjectServerEnabled(
          operationProjectId,
          server.serverId,
          !server.enabled,
        );
        // 手动启用被精简模式禁用的内置服务器（browser / app-control /
        // terminal / computer-use）时，Rust 侧会自动关闭精简模式；派发事件
        // 让会话层重新读取状态。
        if (
          !server.enabled &&
          (server.serverId === "builtin:browser" ||
            server.serverId === "builtin:app-control" ||
            server.serverId === "builtin:terminal" ||
            server.serverId === "builtin:computer-use")
        ) {
          window.dispatchEvent(new CustomEvent(LITE_MODE_CHANGED_EVENT));
        }
      }
      if (loadGenerationRef.current !== generation) {
        return;
      }

      const nextProjectConfigs =
        await window.snow.listProjectMcpServerConfigs(operationProjectId);
      if (loadGenerationRef.current !== generation) {
        return;
      }
      setProjectServerConfigs(nextProjectConfigs);
      // 启停本身很快：列表刷新走快速路径，工具由后台补发现。
      await refreshProjectServers(operationProjectId, generation);
    } catch (updateError) {
      if (loadGenerationRef.current === generation) {
        setError(
          updateError instanceof Error
            ? updateError.message
            : t("settings.mcpSaveError", {
                defaultValue: "Failed to update MCP server",
              }),
        );
      }
    } finally {
      if (loadGenerationRef.current === generation) {
        setIsSaving(false);
      }
    }
  };

  const handleProjectFetchTools = async (
    server: McpSettingsListItem,
  ): Promise<void> => {
    if (!activeDirectory) {
      return;
    }

    const operationProjectId = activeDirectory.directoryId;
    const generation = loadGenerationRef.current;
    setFetchingToolServerIds((previous) =>
      new Set(previous).add(server.serverId),
    );
    setError("");
    setStatus("");
    try {
      const tools = await fetchProjectServerTools(
        operationProjectId,
        server.serverId,
        generation,
      );
      if (loadGenerationRef.current !== generation) {
        return;
      }
      setStatus(
        t("settings.mcpFetchToolsSuccess", {
          defaultValue: "Fetched {{count}} tool(s) from {{name}}.",
          values: { count: tools.length, name: server.name },
        }),
      );
    } catch (fetchError) {
      if (loadGenerationRef.current === generation) {
        setError(formatMcpError(fetchError, t));
      }
    } finally {
      setFetchingToolServerIds((previous) => {
        const next = new Set(previous);
        next.delete(server.serverId);
        return next;
      });
    }
  };

  const findGlobalServer = (serverId: string): McpServerConfig | undefined =>
    servers.find((server) => server.serverId === serverId);
  const findProjectServer = (
    scopeServerId: string,
  ): ProjectMcpServerConfig | undefined => {
    const serverId = scopeServerId.replace(/^external:/, "");
    return projectServerConfigs.find((server) => server.serverId === serverId);
  };

  const handleProjectDelete = async (
    server: ProjectMcpServerConfig,
  ): Promise<void> => {
    if (!activeDirectory) {
      return;
    }
    const operationProjectId = activeDirectory.directoryId;
    const generation = loadGenerationRef.current;
    setIsSaving(true);
    setError("");
    setStatus("");
    try {
      const items = await window.snow.deleteProjectMcpServerConfig(
        operationProjectId,
        server.serverId,
      );
      if (loadGenerationRef.current !== generation) {
        return;
      }
      setProjectServerConfigs(items);
      setToolsByServerId((previous) => {
        const next = { ...previous };
        delete next[`external:${server.serverId}`];
        return next;
      });
      // 删除后同样走快速刷新：被删服务器已不在列表，其他服务器缓存不受
      // 影响（Rust 侧只失效被删服务器的缓存），无需重新连接。
      await refreshProjectServers(operationProjectId, generation);
      setStatus(
        t("settings.mcpDeleteSuccess", {
          defaultValue: "Deleted MCP server.",
        }),
      );
    } catch (deleteError) {
      if (loadGenerationRef.current === generation) {
        setError(
          deleteError instanceof Error
            ? deleteError.message
            : t("settings.mcpDeleteError", {
                defaultValue: "Failed to delete MCP server",
              }),
        );
      }
    } finally {
      if (loadGenerationRef.current === generation) {
        setIsSaving(false);
      }
    }
  };

  const handleListToggle = (server: McpSettingsListItem): void => {
    if (isGlobalScope) {
      const globalServer = findGlobalServer(server.serverId);
      if (globalServer) {
        void toggleEnabled(globalServer);
      }
      return;
    }
    void handleProjectToggle(server);
  };

  const handleListFetchTools = (server: McpSettingsListItem): void => {
    if (isGlobalScope) {
      const globalServer = findGlobalServer(server.serverId);
      if (globalServer) {
        void handleFetchTools(globalServer);
      }
      return;
    }
    void handleProjectFetchTools(server);
  };

  const handleListToggleTool = (
    server: McpSettingsListItem,
    tool: McpServerTool,
    enabled: boolean,
  ): void => {
    void handleToggleTool(server, tool, enabled);
  };

  const handleListToggleAllTools = (
    server: McpSettingsListItem,
    enabled: boolean,
  ): void => {
    void handleToggleAllTools(server, enabled);
  };

  const handleListEdit = (server: McpSettingsListItem): void => {
    if (isGlobalScope) {
      const globalServer = findGlobalServer(server.serverId);
      if (globalServer) {
        startEdit(globalServer);
      }
      return;
    }
    const projectServer = findProjectServer(server.serverId);
    if (projectServer) {
      startEdit(projectServer);
    }
  };

  const handleListDelete = (server: McpSettingsListItem): void => {
    setPendingDelete({ server, scope: activeScope });
  };

  const confirmDelete = async (): Promise<void> => {
    const pending = pendingDelete;
    if (!pending) {
      return;
    }
    setPendingDelete(null);

    if (pending.scope === "global") {
      const globalServer = findGlobalServer(pending.server.serverId);
      if (globalServer) {
        await handleDelete(globalServer);
      }
      return;
    }

    const projectServer = findProjectServer(pending.server.serverId);
    if (projectServer) {
      await handleProjectDelete(projectServer);
    }
  };

  const pendingDeleteIsSnowCli = pendingDelete
    ? pendingDelete.scope === "global"
      ? findGlobalServer(pendingDelete.server.serverId)?.source === "snow-cli"
      : findProjectServer(pendingDelete.server.serverId)?.source === "snow-cli"
    : false;

  return (
    <div className="api-settings-page" role="region">
      <div className="api-settings-page-header">
        <div className="api-settings-title-group">
          <strong>
            {t("settings.mcpTitle", { defaultValue: "MCP settings" })}
          </strong>
          <span className="settings-item-description">
            {t("settings.mcpSettingsInfo", {
              defaultValue: "Configure MCP servers and tools.",
            })}
          </span>
        </div>
        {onClose && (
          <button
            className="icon-btn ghost"
            onClick={onClose}
            type="button"
            aria-label={t("settings.closeMcpSettings", {
              defaultValue: "Close MCP settings",
            })}
            title={t("settings.closeMcpSettings", {
              defaultValue: "Close MCP settings",
            })}
          >
            <X size={15} strokeWidth={1.8} />
          </button>
        )}
      </div>

      <McpSettingsSummary
        totalCount={activeServers.length}
        enabledCount={enabledCount}
      />

      <div className="api-settings-actions">
        {isGlobalScope ? (
          <>
            <button
              className="api-settings-action-btn primary"
              onClick={() => void handleImport()}
              type="button"
              disabled={isBusy}
            >
              {isLoading ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <Download size={15} />
              )}
              <span>
                {t("settings.syncSnowCliMcp", {
                  defaultValue: "Sync Snow CLI MCP settings",
                })}
              </span>
            </button>
            <button
              className="api-settings-action-btn secondary"
              onClick={startAdd}
              type="button"
              disabled={isBusy}
            >
              <Plus size={15} />
              <span>
                {t("settings.mcpAddNew", { defaultValue: "Add server" })}
              </span>
            </button>
          </>
        ) : (
          <>
            <button
              className="api-settings-action-btn secondary"
              onClick={() => void load()}
              type="button"
              disabled={isBusy || fetchingToolServerIds.size > 0}
            >
              <RefreshCw size={15} className={isLoading ? "spin" : ""} />
              <span>
                {t("settings.mcpProjectRefresh", {
                  defaultValue: "Refresh project MCP",
                })}
              </span>
            </button>
            <button
              className="api-settings-action-btn secondary"
              onClick={startAdd}
              type="button"
              disabled={isBusy || !activeDirectory}
            >
              <Plus size={15} />
              <span>
                {t("settings.mcpAddProjectServer", {
                  defaultValue: "Add project server",
                })}
              </span>
            </button>
          </>
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
        aria-label={t("settings.mcpScopeTabs", {
          defaultValue: "MCP scope",
        })}
      >
        <button
          className={`skills-settings-tab ${isGlobalScope ? "active" : ""}`}
          type="button"
          role="tab"
          aria-selected={isGlobalScope}
          onClick={() => setActiveScope("global")}
        >
          <Globe2 size={14} strokeWidth={1.8} />
          <span>{t("settings.mcpTabGlobal", { defaultValue: "Global" })}</span>
          <small>{globalListItems.length}</small>
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
          <span>
            {t("settings.mcpTabProject", { defaultValue: "Project" })}
          </span>
          <small>{projectListItems.length}</small>
        </button>
      </div>

      <div className="api-settings-manual-form">
        <div className="api-settings-manual-header">
          <strong>{listTitle}</strong>
          <span>
            {isGlobalScope
              ? t("settings.mcpGlobalTabInfo", {
                  defaultValue:
                    "Manage external MCP servers shared by all projects.",
                })
              : t("settings.mcpProjectTabInfo", {
                  defaultValue:
                    "Manage project MCP servers for {{name}} and control inherited system or global servers.",
                  values: { name: activeDirectory?.name ?? "" },
                })}
          </span>
        </div>

        <div className="api-settings-form-body">
          <McpSettingsList
            servers={activeServers}
            isBusy={isBusy}
            listTitle={listTitle}
            emptyMessage={emptyMessage}
            toolsByServerId={toolsByServerId}
            fetchingToolServerIds={fetchingToolServerIds}
            onToggleEnabled={handleListToggle}
            onFetchTools={handleListFetchTools}
            onToggleTool={handleListToggleTool}
            onToggleAllTools={handleListToggleAllTools}
            onEdit={handleListEdit}
            onDelete={handleListDelete}
          />
        </div>
      </div>

      <Modal
        open={Boolean(draft)}
        title={t("settings.mcpEditorTitle", {
          defaultValue: "MCP server editor",
        })}
        description={
          draft?.name || t("settings.mcpAddNew", { defaultValue: "Add server" })
        }
        closeLabel={t("settings.cancel", { defaultValue: "Cancel" })}
        onClose={cancelDraft}
        closeDisabled={isBusy}
        size="large"
        className="mcp-settings-editor-modal"
        footer={
          draft && (
            <McpSettingsEditorActions
              isBusy={isBusy}
              isSaving={isSaving}
              onCancel={cancelDraft}
            />
          )
        }
      >
        {draft && (
          <McpSettingsEditor
            draft={draft}
            isBusy={isBusy}
            isSaving={isSaving}
            tools={
              draft.serverId
                ? toolsByServerId[
                    isGlobalScope
                      ? draft.serverId
                      : `external:${draft.serverId}`
                  ]
                : undefined
            }
            isFetchingTools={
              Boolean(draft.serverId) &&
              fetchingToolServerIds.has(
                isGlobalScope ? draft.serverId : `external:${draft.serverId}`,
              )
            }
            onFetchTools={() => {
              if (isGlobalScope) {
                const server = servers.find(
                  (item) => item.serverId === draft.serverId,
                );
                if (server) {
                  void handleFetchTools(server);
                }
                return;
              }
              const server = projectListItems.find(
                (item) => item.serverId === `external:${draft.serverId}`,
              );
              if (server) {
                void handleProjectFetchTools(server);
              }
            }}
            onDraftChange={patchDraft}
            onUpdatePair={updatePair}
            onAddPair={addPair}
            onRemovePair={removePair}
            onUpdateArg={updateArg}
            onAddArg={addArg}
            onRemoveArg={removeArg}
            onCancel={cancelDraft}
            onSave={() => void saveDraft()}
          />
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={t("settings.mcpDeleteConfirmTitle", {
          defaultValue: "Delete MCP server",
        })}
        message={
          pendingDeleteIsSnowCli
            ? t("settings.mcpDeleteSnowCliConfirm", {
                defaultValue:
                  "Delete {{name}} from Snow App and its Snow CLI settings file? This prevents it from returning after the next sync.",
                values: { name: pendingDelete?.server.name ?? "" },
              })
            : t("settings.mcpDeleteConfirm", {
                defaultValue: "Delete the MCP server {{name}}?",
                values: { name: pendingDelete?.server.name ?? "" },
              })
        }
        confirmLabel={t("settings.delete", { defaultValue: "Delete" })}
        cancelLabel={t("common.cancel", { defaultValue: "Cancel" })}
        variant="danger"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
