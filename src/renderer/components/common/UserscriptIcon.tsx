import { FileCode2 } from "lucide-react";
import { useEffect, useState } from "react";

import { resolvePluginIcon } from "../../plugins/manifest";
import {
  resolveLucideIcon,
  type LucideIconComponent,
} from "../../plugins/pluginRuntime";
import { imageProxyUrl } from "../../utils/imageProxyUrl";

type UserscriptIconProps = {
  icon: string;
  size?: number;
  className?: string;
};

type ResolvedIcon =
  { kind: "lucide"; name: string } | { kind: "image"; url: string };

const resolveIcon = (icon: string): ResolvedIcon | null => {
  const resolved = resolvePluginIcon(icon);
  if (resolved?.kind === "lucide") {
    return { kind: "lucide", name: resolved.name };
  }
  const trimmed = icon.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return { kind: "image", url: imageProxyUrl(trimmed) };
  }
  if (/^data:image\//i.test(trimmed)) {
    return { kind: "image", url: trimmed };
  }
  return null;
};

export const UserscriptIcon = ({
  icon,
  size = 18,
  className,
}: UserscriptIconProps): React.JSX.Element => {
  const [lucideIcon, setLucideIcon] = useState<LucideIconComponent | null>(
    null,
  );
  const resolved = resolveIcon(icon);
  const classes = className ? `plugin-icon ${className}` : "plugin-icon";

  useEffect(() => {
    let disposed = false;
    setLucideIcon(null);
    const target = resolveIcon(icon);
    if (target?.kind === "lucide") {
      void resolveLucideIcon(target.name).then((found) => {
        if (!disposed) {
          setLucideIcon(found);
        }
      });
    }
    return () => {
      disposed = true;
    };
  }, [icon]);

  if (resolved?.kind === "image") {
    return (
      <img
        className={classes}
        src={resolved.url}
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
      <FileCode2 size={size} />
    </span>
  );
};
