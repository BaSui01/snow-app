import { Puzzle } from "lucide-react";
import { useEffect, useState } from "react";

import { resolvePluginIcon } from "../../plugins/manifest";
import {
  resolveLucideIcon,
  type LucideIconComponent,
} from "../../plugins/pluginRuntime";

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
  const [lucideIcon, setLucideIcon] = useState<LucideIconComponent | null>(
    null,
  );

  useEffect(() => {
    const resolved = resolvePluginIcon(icon);
    let disposed = false;
    setLucideIcon(null);
    setAssetUrl(null);

    if (resolved?.kind === "lucide") {
      void resolveLucideIcon(resolved.name).then((found) => {
        if (!disposed) {
          setLucideIcon(found);
        }
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

  const classes = className ? `plugin-icon ${className}` : "plugin-icon";

  if (assetUrl) {
    return (
      <img
        className={classes}
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
      <span className={classes}>
        <Icon size={size} />
      </span>
    );
  }

  return (
    <span className={classes}>
      <Puzzle size={size} />
    </span>
  );
};
