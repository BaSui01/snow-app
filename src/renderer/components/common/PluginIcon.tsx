import { Puzzle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { resolvePluginIcon } from "../../plugins/manifest";
import { loadLucideIcons } from "../../plugins/pluginRuntime";

type PluginIconProps = {
  icon: string;
  pluginId: string;
  size?: number;
  className?: string;
};

/** 插件图标：lucide:Name / 插件内相对路径资源 / 缺失时占位图标。 */
export const PluginIcon = ({
  icon,
  pluginId,
  size = 14,
  className,
}: PluginIconProps): React.JSX.Element => {
  const [assetUrl, setAssetUrl] = useState<string | null>(null);
  const [lucideIcon, setLucideIcon] = useState<
    ((props: { size: number }) => ReactNode) | null
  >(null);

  useEffect(() => {
    const resolved = resolvePluginIcon(icon);
    let disposed = false;
    setLucideIcon(null);
    setAssetUrl(null);

    if (resolved?.kind === "lucide") {
      void loadLucideIcons().then((icons) => {
        if (disposed) {
          return;
        }
        const found = icons[resolved.name];
        setLucideIcon(
          typeof found === "function"
            ? (found as (props: { size: number }) => ReactNode)
            : null,
        );
      });
    } else if (resolved?.kind === "asset") {
      void window.snow
        .readPluginAsset(pluginId, resolved.path)
        .then((url) => {
          if (!disposed) {
            setAssetUrl(url);
          }
        })
        .catch(() => undefined);
    }

    return () => {
      disposed = true;
    };
  }, [icon, pluginId]);

  if (assetUrl) {
    return (
      <img
        className={className}
        src={assetUrl}
        width={size}
        height={size}
        alt=""
      />
    );
  }

  if (lucideIcon) {
    const Icon = lucideIcon;
    return (
      <span className={className}>
        <Icon size={size} />
      </span>
    );
  }

  return (
    <span className={className}>
      <Puzzle size={size} />
    </span>
  );
};
