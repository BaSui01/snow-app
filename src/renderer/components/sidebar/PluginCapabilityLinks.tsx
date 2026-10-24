import { Database, ShieldAlert } from "lucide-react";
import { useMemo } from "react";

import { useI18n } from "../../i18n";
import { describeMetadataDomains } from "../../plugins/metadata";
import type { PluginView } from "../../plugins/types";
import { describeWriteDomains } from "../../plugins/writes";

type PluginCapabilityLinksProps = {
  plugin: PluginView;
  onOpen: () => void;
};

/**
 * 插件行上的「可读元数据 n/N」「可写能力 n/N」入口：面板插件与脚本插件共用，
 * 两者走同一套元数据域 / 写动作引擎，计数口径一致。
 */
export const PluginCapabilityLinks = ({
  plugin,
  onOpen,
}: PluginCapabilityLinksProps): React.JSX.Element => {
  const { t, locale } = useI18n();

  const counts = useMemo(() => {
    const metadata = describeMetadataDomains(plugin);
    const writeDomains = describeWriteDomains(plugin, locale);
    let writable = 0;
    let writeTotal = 0;
    for (const domain of writeDomains) {
      writeTotal += domain.actions.length;
      writable += domain.actions.filter((action) => action.granted).length;
    }
    return {
      readable: metadata.filter((domain) => domain.granted).length,
      readTotal: metadata.length,
      writable,
      writeTotal,
    };
  }, [locale, plugin]);

  return (
    <>
      <button
        className="plugins-metadata-link"
        type="button"
        title={t("plugins.metadata.openHint", {
          defaultValue: "Open the metadata catalog to compare every domain",
        })}
        onClick={onOpen}
      >
        <Database size={12} strokeWidth={1.8} />
        <span>
          {t("plugins.metadata.pluginEntry", {
            values: { granted: counts.readable, total: counts.readTotal },
            defaultValue: "Metadata {{granted}}/{{total}}",
          })}
        </span>
      </button>

      <button
        className="plugins-metadata-link"
        type="button"
        title={t("plugins.write.openHint", {
          defaultValue:
            "Open the metadata catalog to compare every write action",
        })}
        onClick={onOpen}
      >
        <ShieldAlert size={12} strokeWidth={1.8} />
        <span>
          {t("plugins.write.entry", {
            values: { granted: counts.writable, total: counts.writeTotal },
            defaultValue: "Write {{granted}}/{{total}}",
          })}
        </span>
      </button>
    </>
  );
};
