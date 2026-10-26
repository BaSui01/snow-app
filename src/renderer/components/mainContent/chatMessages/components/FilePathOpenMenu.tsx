import { CircleAlert, ExternalLink, Loader2 } from "lucide-react";
import { useEffect } from "react";

import { useI18n } from "../../../../i18n";
import {
  getFileManagerLabelKey,
  useOpenWithApps,
} from "../../../../hooks/useOpenWithApps";
import { ContextMenu, type ContextMenuItem } from "../../../common/ContextMenu";
import { FileManagerIcon } from "../../../icons/fileManagerIcons";
import { IdeIcon } from "../../../icons/ideIcons";
import type { PathMenuTarget } from "../hooks/usePathClickOpen";

type FilePathOpenMenuProps = {
  /** 右键命中的路径（已解析为磁盘上的真实条目）。 */
  target: PathMenuTarget;
  onClose: () => void;
};

/**
 * 正文文件路径（markdownWorker 标记的 md-file-path）的右键菜单：
 * 「在系统文件管理器中显示」+「打开方式」（系统默认应用 / 已安装 IDE），
 * 与侧边栏目录菜单的打开方式同一套能力（IDE 探测见 useOpenWithApps）。
 *
 * 打开成功才收起菜单；失败保留菜单并把原因显示在菜单里，避免错误一闪而过。
 */
export const FilePathOpenMenu = ({
  target,
  onClose,
}: FilePathOpenMenuProps): React.JSX.Element => {
  const { t } = useI18n();
  const { ides, isLoadingIdes, error, setError, ensureIdesLoaded } =
    useOpenWithApps();

  // 菜单打开即探测已安装 IDE（同一菜单实例只探测一次）。
  useEffect(() => {
    ensureIdesLoaded();
  }, [ensureIdesLoaded]);

  const handleRevealInFileManager = (): void => {
    setError(null);
    void window.snow
      .showItemInFolder(target.path)
      .then(() => onClose())
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error
            ? cause.message
            : t("sidebar.openInFileManagerError", {
                defaultValue: "Failed to open in file manager",
              }),
        );
      });
  };

  // 主进程以返回值而非异常上报失败原因（null 表示已打开）。
  const handleOpenWithSystemApp = (): void => {
    setError(null);
    void window.snow
      .openPathWithSystemApp(target.path)
      .then((message) => {
        if (message) {
          setError(message);
          return;
        }
        onClose();
      })
      .catch(() => {
        setError(
          t("sidebar.openWithSystemAppError", {
            defaultValue: "Failed to open with the system default app",
          }),
        );
      });
  };

  const handleOpenInIde = (ideId: string): void => {
    setError(null);
    void window.snow
      .openInIde(ideId, target.path)
      .then(() => onClose())
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error
            ? cause.message
            : t("sidebar.openInIdeError", {
                defaultValue: "Failed to open project in IDE",
              }),
        );
      });
  };

  // 打开方式分组：系统默认应用只面向文件（目录已由「在文件管理器中显示」覆盖）。
  const openWithItems: ContextMenuItem[] = [];
  if (!target.isDirectory) {
    openWithItems.push({
      id: "system-app",
      label: t("sidebar.explorerOpenWithSystemApp", {
        defaultValue: "Open with System Default App",
      }),
      icon: <ExternalLink size={13} />,
      onClick: handleOpenWithSystemApp,
    });
  }
  if (isLoadingIdes) {
    openWithItems.push({
      id: "ides-loading",
      label: t("sidebar.openWithLoading", {
        defaultValue: "Detecting installed IDEs...",
      }),
      icon: <Loader2 className="spin" size={13} />,
      onClick: () => {},
      disabled: true,
    });
  } else if (ides.length === 0) {
    openWithItems.push({
      id: "ides-empty",
      label: t("sidebar.openWithEmpty", {
        defaultValue: "No installed IDEs detected",
      }),
      onClick: () => {},
      disabled: true,
    });
  } else {
    openWithItems.push(
      ...ides.map((ide): ContextMenuItem => ({
        id: `ide-${ide.id}`,
        label: ide.name,
        icon: <IdeIcon ideId={ide.id} size={13} />,
        onClick: () => handleOpenInIde(ide.id),
      })),
    );
  }

  // 分组标题「打开方式」由该组第一项的分隔线承载。
  const items: ContextMenuItem[] = [
    {
      id: "reveal",
      label: t(getFileManagerLabelKey(), { defaultValue: "Open in Explorer" }),
      icon: <FileManagerIcon size={13} />,
      onClick: handleRevealInFileManager,
    },
    ...openWithItems.map((item, index) =>
      index === 0
        ? {
            ...item,
            separator: true,
            separatorLabel: t("sidebar.openWith", {
              defaultValue: "Open with",
            }),
          }
        : item,
    ),
  ];
  if (error) {
    items.push({
      id: "open-with-error",
      label: error,
      icon: <CircleAlert size={13} />,
      onClick: () => {},
      disabled: true,
      danger: true,
    });
  }

  // 不开键盘导航：右键打开菜单不应把焦点从输入框抢走（Esc / 点击外部仍可关闭）。
  return (
    <ContextMenu
      x={target.x}
      y={target.y}
      items={items}
      onClose={onClose}
      ariaLabel={t("sidebar.openWith", { defaultValue: "Open with" })}
    />
  );
};
