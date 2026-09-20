import { ipcRenderer } from "electron";
import type { PluginRecord, PluginStorageValue } from "../types/plugins";

export const pluginsApi = {
  /** 列出全部已安装插件。 */
  listPlugins: (): Promise<PluginRecord[]> => ipcRenderer.invoke("plugins:list"),
  /** 插件根目录绝对路径（~/.snowapp/plugins）。 */
  getPluginsDirectory: (): Promise<string> =>
    ipcRenderer.invoke("plugins:get-directory"),
  /** 弹出系统目录选择框（安装插件用）。取消时返回 null。 */
  pickPluginDirectory: (dialogTitle?: string): Promise<string | null> =>
    ipcRenderer.invoke("plugins:pick-directory", dialogTitle),
  /** 从本地目录安装（或更新）插件：自动扫描 plugin.json 并复制到插件目录。 */
  installPlugin: (sourceDir: string): Promise<PluginRecord> =>
    ipcRenderer.invoke("plugins:install", sourceDir),
  /** 重新读取插件目录中的 plugin.json 并刷新元数据。 */
  rescanPlugin: (pluginId: string): Promise<PluginRecord> =>
    ipcRenderer.invoke("plugins:rescan", pluginId),
  /** 启用 / 禁用插件。 */
  setPluginEnabled: (pluginId: string, enabled: boolean): Promise<void> =>
    ipcRenderer.invoke("plugins:set-enabled", pluginId, enabled),
  /** 卸载插件；deleteFiles 为 true 时同时删除插件目录。 */
  deletePlugin: (pluginId: string, deleteFiles: boolean): Promise<void> =>
    ipcRenderer.invoke("plugins:delete", pluginId, deleteFiles),
  /** 读取插件目录内的文本文件（入口代码 / 样式 / 语言包）。 */
  readPluginFile: (pluginId: string, relativePath: string): Promise<string> =>
    ipcRenderer.invoke("plugins:read-file", pluginId, relativePath),
  /** 读取插件目录内的二进制资源，返回 data URL（失败返回 null）。 */
  readPluginAsset: (
    pluginId: string,
    relativePath: string,
  ): Promise<string | null> =>
    ipcRenderer.invoke("plugins:read-asset", pluginId, relativePath),
  /** 读取插件的持久化 KV 数据。 */
  getPluginValues: (pluginId: string): Promise<PluginStorageValue[]> =>
    ipcRenderer.invoke("plugins:get-values", pluginId),
  /** 写入插件的持久化 KV 数据。 */
  setPluginValue: (
    pluginId: string,
    key: string,
    value: string,
  ): Promise<void> =>
    ipcRenderer.invoke("plugins:set-value", pluginId, key, value),
  /** 删除插件的持久化 KV 数据。 */
  deletePluginValue: (pluginId: string, key: string): Promise<void> =>
    ipcRenderer.invoke("plugins:delete-value", pluginId, key),
};
