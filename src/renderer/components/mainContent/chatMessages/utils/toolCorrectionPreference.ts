/**
 * 「工具失败自动纠错」开关的渲染层同步缓存。
 *
 * 工具执行链路在失败瞬间需要立即判断是否发起纠错请求，不能等待 IPC，
 * 因此设置值在读取/切换时同步写入模块级缓存；持久化仍由 appSettings
 * （system_settings.tool_correction）负责。
 */

let enabled = true;
let loadPromise: Promise<boolean> | null = null;

const readFromBackend = async (): Promise<boolean> => {
  try {
    const value = await window.snow.getToolCorrection();
    enabled = value;
    return value;
  } catch {
    return enabled;
  }
};

/** 首次执行工具失败时按需加载一次持久化开关，之后直接使用缓存。 */
export const ensureToolCorrectionPreference = (): Promise<boolean> => {
  if (!loadPromise) {
    loadPromise = readFromBackend();
  }
  return loadPromise;
};

/** 从后端回读开关并刷新缓存（菜单打开时调用）。 */
export const refreshToolCorrectionPreference = async (): Promise<boolean> => {
  loadPromise = readFromBackend();
  return loadPromise;
};

/** 乐观切换：先更新缓存，写入失败时回读后端真实值。 */
export const setToolCorrectionPreference = async (
  value: boolean,
): Promise<boolean> => {
  enabled = value;
  loadPromise = Promise.resolve(value);
  try {
    await window.snow.setToolCorrection(value);
    return value;
  } catch {
    return refreshToolCorrectionPreference();
  }
};
