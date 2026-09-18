import { BrowserWindow, dialog, ipcMain } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import type {
  ApiModelsConfig,
  NativeBridge,
  ResponsesApiStreamChunk,
} from "../../native/types";
import {
  normalizeApiConfigInput,
  toApiConfigInput,
} from "../../settings/apiConfigs";
import { readSnowCliCodebaseSettings } from "../../settings/codebaseSettings";
import { readSnowCliProxyConfig } from "../../settings/proxyBrowserSettings";
import { readSnowCliProfiles } from "../../snowCli/profiles";
import { safeSend } from "../../utils/safeSend";

/** 同名冲突处理策略：覆盖既有配置 / 另存为新副本。 */
const IMPORT_CONFLICT_STRATEGIES = ["overwrite", "duplicate"] as const;
type ImportConflictStrategy = (typeof IMPORT_CONFLICT_STRATEGIES)[number];

const isImportConflictStrategy = (
  value: unknown,
): value is ImportConflictStrategy =>
  typeof value === "string" &&
  IMPORT_CONFLICT_STRATEGIES.includes(value as ImportConflictStrategy);

/** 校验渲染层传来的待导出配置名列表，去重去空。 */
const normalizeExportProfileNames = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    throw new Error("Profile names must be an array");
  }

  const names = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (names.length === 0) {
    throw new Error("At least one API profile must be selected to export");
  }

  return Array.from(new Set(names));
};

/** 校验渲染层传来的排序名单：非空字符串数组，去重去空。 */
const normalizeOrderedProfileNames = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    throw new Error("Ordered profile names must be an array");
  }

  const names = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  if (names.length === 0) {
    throw new Error("At least one API profile is required for reordering");
  }

  return Array.from(new Set(names));
};

/** 读取导入文件文本；失败时抛出带上下文的错误。 */
const readImportFileContent = async (filePath: string): Promise<string> => {
  try {
    return await readFile(filePath, "utf-8");
  } catch (error) {
    throw new Error(
      `Failed to read API config import file: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

export const registerApiConfigHandlers = (native: NativeBridge): void => {
  ipcMain.handle("api-configs:list", () => native.listApiConfigs());
  ipcMain.handle("api-configs:upsert", async (_event, config: unknown) => {
    await native.upsertApiConfig(normalizeApiConfigInput(config));
    return native.listApiConfigs();
  });
  ipcMain.handle("api-configs:delete", async (_event, profileName: unknown) => {
    if (typeof profileName !== "string" || !profileName.trim()) {
      throw new Error("Profile name is required");
    }

    await native.deleteApiConfig(profileName.trim());
    return native.listApiConfigs();
  });
  ipcMain.handle(
    "api-configs:reorder",
    async (_event, orderedNames: unknown) => {
      await native.reorderApiConfigs(
        normalizeOrderedProfileNames(orderedNames),
      );
      return native.listApiConfigs();
    },
  );
  ipcMain.handle("api-configs:import-snow-cli", async () => {
    const profiles = readSnowCliProfiles();
    const existingConfigs = await native.listApiConfigs();
    const isFirstSync = !existingConfigs.some(
      (config) => config.source === "snow-cli",
    );

    if (isFirstSync) {
      // 首次同步：沿用 Snow CLI 的激活状态
      for (const profile of profiles) {
        await native.upsertApiConfig(toApiConfigInput(profile));
      }
    } else {
      // 增量同步：仅同步配置数据，保留应用内当前激活的 profile
      const activeProfileName =
        existingConfigs.find((config) => config.isActive)?.profileName ?? null;

      for (const profile of profiles) {
        const input = toApiConfigInput(profile);
        await native.upsertApiConfig({
          ...input,
          isActive: profile.name === activeProfileName,
        });
      }
    }

    return {
      importedCount: profiles.length,
      configs: await native.listApiConfigs(),
    };
  });

  // ===== 配置批量迁移（导出 / 导入）=====
  // Rust 负责迁移文档的构造、解析与落库；主进程只负责文件对话框与文件读写。
  ipcMain.handle(
    "api-configs:export-file",
    async (event, profileNames: unknown) => {
      const names = normalizeExportProfileNames(profileNames);
      const { content, exportedCount } = await native.exportApiConfigs(names);

      const options: Electron.SaveDialogOptions = {
        title: "Export API profiles",
        defaultPath: `snow-api-configs-${new Date()
          .toISOString()
          .slice(0, 10)}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      };
      const browserWindow = BrowserWindow.fromWebContents(event.sender);
      const result = browserWindow
        ? await dialog.showSaveDialog(browserWindow, options)
        : await dialog.showSaveDialog(options);

      if (result.canceled || !result.filePath) {
        return { canceled: true, filePath: "", exportedCount: 0 };
      }

      await writeFile(result.filePath, content, "utf-8");
      return { canceled: false, filePath: result.filePath, exportedCount };
    },
  );

  ipcMain.handle("api-configs:pick-import-file", async (event) => {
    const options: Electron.OpenDialogOptions = {
      title: "Import API profiles",
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }],
    };
    const browserWindow = BrowserWindow.fromWebContents(event.sender);
    const result = browserWindow
      ? await dialog.showOpenDialog(browserWindow, options)
      : await dialog.showOpenDialog(options);

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, filePath: "", preview: null };
    }

    const filePath = result.filePaths[0];
    const preview = await native.inspectApiConfigImport(
      await readImportFileContent(filePath),
    );
    return { canceled: false, filePath, preview };
  });

  ipcMain.handle(
    "api-configs:import-file",
    async (_event, filePath: unknown, conflictStrategy: unknown) => {
      if (typeof filePath !== "string" || !filePath.trim()) {
        throw new Error("Import file path is required");
      }
      if (!isImportConflictStrategy(conflictStrategy)) {
        throw new Error(
          `Unsupported API config import strategy: ${String(conflictStrategy)}`,
        );
      }

      const outcome = await native.importApiConfigs(
        await readImportFileContent(filePath.trim()),
        conflictStrategy,
      );

      return { outcome, configs: await native.listApiConfigs() };
    },
  );

  ipcMain.handle("api-models:fetch", async () => {
    try {
      const models = await native.fetchAvailableModels();
      return models;
    } catch (error) {
      throw error;
    }
  });
  ipcMain.handle(
    "api-models:fetch-for-config",
    async (_event, config: unknown) => {
      if (
        typeof config !== "object" ||
        config === null ||
        Array.isArray(config)
      ) {
        throw new Error("API model config is required");
      }

      const source = config as Partial<Record<keyof ApiModelsConfig, unknown>>;
      const normalizedConfig: ApiModelsConfig = {
        baseUrl: typeof source.baseUrl === "string" ? source.baseUrl : "",
        baseUrlMode:
          typeof source.baseUrlMode === "string" ? source.baseUrlMode : "auto",
        apiKey: typeof source.apiKey === "string" ? source.apiKey : "",
        requestMethod:
          typeof source.requestMethod === "string"
            ? source.requestMethod
            : "chat",
        customHeaderSchemeId:
          typeof source.customHeaderSchemeId === "string"
            ? source.customHeaderSchemeId
            : "",
      };

      return native.fetchAvailableModelsForConfig(normalizedConfig);
    },
  );

  ipcMain.handle("proxy-browser-settings:import-snow-cli", () =>
    readSnowCliProxyConfig(native),
  );

  ipcMain.handle("codebase-settings:import-snow-cli", () =>
    readSnowCliCodebaseSettings(native),
  );

  // ===== AI theme palette generation =====
  ipcMain.handle(
    "theme:generate-palette",
    async (
      event,
      imagePath: unknown,
      profileName: unknown,
      streamId: unknown,
    ) => {
      if (typeof imagePath !== "string" || !imagePath.trim()) {
        throw new Error("Image path is required");
      }
      if (typeof streamId !== "string" || !streamId.trim()) {
        throw new Error("Stream ID is required");
      }

      const normalizedStreamId = streamId.trim();
      const normalizedProfileName =
        typeof profileName === "string" ? profileName.trim() : "";

      return await native.generateThemePalette(
        imagePath.trim(),
        normalizedProfileName,
        (chunk: ResponsesApiStreamChunk) => {
          safeSend(event.sender, "theme:generate-palette:chunk", {
            streamId: normalizedStreamId,
            chunk,
          });
        },
        normalizedStreamId,
      );
    },
  );
};
