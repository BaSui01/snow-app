import { useEffect } from "react";
import { useI18n } from "../../../i18n";
import { resolveLocalized } from "../../../plugins/manifest";
import { pluginStore, usePluginStore } from "../../../plugins/pluginStore";
import { PluginIcon } from "../../common/PluginIcon";
import { Tooltip } from "../../common/Tooltip";
import { ChatInputPluginAction } from "./ChatInputPluginAction";
import { rightPanelEvents } from "../../rightPanel/rightPanelEvents";

/** Declarative panel launcher only: does not send a message or invoke AI. */
export const ChatInputPluginButtons = ({
  disabled,
  parametersKey,
  apiConfigIdentity,
}: {
  disabled: boolean;
  parametersKey: string;
  apiConfigIdentity: unknown;
}): React.JSX.Element => {
  const { locale } = useI18n();
  const { plugins } = usePluginStore();
  useEffect(() => {
    void pluginStore.ensureLoaded();
  }, []);
  return (
    <>
      {plugins
        .filter((plugin) => plugin.enabled)
        .flatMap((plugin) =>
          plugin.panels
            .filter((panel) => panel.chatInput === true)
            .map((panel) => {
              const title =
                resolveLocalized(panel.chatInputTitle ?? {}, locale) ||
                resolveLocalized(panel.title, locale) ||
                panel.id;
              if (plugin.renderMode === "esm" && panel.chatInputAction) {
                return (
                  <ChatInputPluginAction
                    key={`${plugin.pluginId}:${panel.id}`}
                    plugin={plugin}
                    panel={panel}
                    disabled={disabled}
                    parametersKey={parametersKey}
                    apiConfigIdentity={apiConfigIdentity}
                  />
                );
              }
              return (
                <Tooltip key={`${plugin.pluginId}:${panel.id}`} content={title}>
                  <button
                    type="button"
                    className="toolbar-btn"
                    disabled={disabled}
                    aria-label={title}
                    title={title}
                    onClick={() => {
                      const current = pluginStore.getById(plugin.pluginId);
                      if (
                        disabled ||
                        !current?.enabled ||
                        !current.panels.some(
                          (item) =>
                            item.id === panel.id && item.chatInput === true,
                        )
                      )
                        return;
                      rightPanelEvents.emit("open-plugin-panel", {
                        pluginId: plugin.pluginId,
                        panelId: panel.id,
                        title:
                          resolveLocalized(panel.title, locale) || panel.id,
                      });
                    }}
                  >
                    <PluginIcon
                      pluginId={plugin.pluginId}
                      icon={panel.icon || plugin.icon}
                      size={15}
                    />
                  </button>
                </Tooltip>
              );
            }),
        )}
    </>
  );
};
