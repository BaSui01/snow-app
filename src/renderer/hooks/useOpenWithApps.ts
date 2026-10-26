import { useCallback, useRef, useState } from "react";

import type { IdeInfo } from "../../preload";
import { useI18n } from "../i18n";
import { isMacOS } from "../utils/shortcutUtils";

/**
 * 系统文件管理器菜单项文案 key：macOS 访达 / Windows 资源管理器 / 其他平台文件管理器。
 * 侧边栏目录菜单与正文文件路径右键菜单共用同一套文案。
 */
export const getFileManagerLabelKey = (): string =>
  isMacOS()
    ? "sidebar.openWithFinder"
    : navigator.userAgent.includes("Windows")
      ? "sidebar.openWithExplorer"
      : "sidebar.openWithFileManager";

export type OpenWithApps = {
  /** 已安装的 IDE（探测完成后填充）。 */
  ides: IdeInfo[];
  isLoadingIdes: boolean;
  /** 最近一次「打开方式」错误（探测失败或打开失败），由调用方按需设置。 */
  error: string | null;
  setError: (message: string | null) => void;
  /** 首次调用时探测已安装 IDE；同一菜单实例只探测一次。 */
  ensureIdesLoaded: () => void;
};

/**
 * 「打开方式」的共用数据源：已安装 IDE 列表与错误通道。
 *
 * 侧边栏目录菜单（WorkspaceDirectoryMenu）与聊天区文件路径右键菜单
 * （FilePathOpenMenu）共用这份探测逻辑；具体的打开动作（系统文件管理器 /
 * 系统默认应用 / IDE）由各菜单自行发起，便于保留各自的错误展示方式。
 */
export const useOpenWithApps = (): OpenWithApps => {
  const { t } = useI18n();
  const [ides, setIdes] = useState<IdeInfo[]>([]);
  const [isLoadingIdes, setIsLoadingIdes] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const ensureIdesLoaded = useCallback((): void => {
    if (loadedRef.current) {
      return;
    }
    loadedRef.current = true;
    setIsLoadingIdes(true);
    setError(null);
    window.snow
      .listInstalledIdes()
      .then((installed) => setIdes(installed))
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error
            ? cause.message
            : t("sidebar.openWithError", {
                defaultValue: "Failed to detect installed IDEs",
              }),
        );
      })
      .finally(() => setIsLoadingIdes(false));
  }, [t]);

  return { ides, isLoadingIdes, error, setError, ensureIdesLoaded };
};
