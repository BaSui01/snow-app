import { Search, ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";

import { useI18n } from "../../i18n";
import { resolveLocalized } from "../../plugins/manifest";
import {
  METADATA_DOMAINS,
  describeMetadataDomains,
} from "../../plugins/metadata";
import {
  METADATA_DOMAIN_GROUP_IDS,
  resolveMetadataDomainEntry,
  type MetadataDomainGroupId,
} from "../../plugins/metadata/catalog";
import type { PluginView, SensitiveScope } from "../../plugins/types";
import { Modal } from "../common/Modal";

type PluginMetadataModalProps = {
  open: boolean;
  onClose: () => void;
  plugin: PluginView | null;
};

type MetadataDomainRow = {
  id: string;
  group: MetadataDomainGroupId;
  summary: string;
  params: string[];
  scope: SensitiveScope | null;
  sensitiveFields: string[];
  live: boolean;
  granted: boolean | null;
};

export const PluginMetadataModal = ({
  open,
  onClose,
  plugin,
}: PluginMetadataModalProps): React.JSX.Element => {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState("");

  const scopeLabel = (scope: SensitiveScope): string =>
    t(`plugins.scopes.${scope}`, { defaultValue: scope });

  const rows = useMemo<MetadataDomainRow[]>(() => {
    const grantedById = plugin
      ? new Map(
          describeMetadataDomains(plugin).map((item) => [
            item.id,
            item.granted,
          ]),
        )
      : null;
    return METADATA_DOMAINS.map((definition) => {
      const entry = resolveMetadataDomainEntry(definition.id);
      return {
        id: definition.id,
        group: entry.group,
        summary: entry.summary[locale],
        params: entry.params,
        scope: definition.scope ?? null,
        sensitiveFields: Object.keys(definition.sensitiveFields ?? {}),
        live: Boolean(definition.live),
        granted: grantedById ? (grantedById.get(definition.id) ?? null) : null,
      };
    });
  }, [locale, plugin]);

  const grantedCount = rows.filter((row) => row.granted).length;

  const keyword = query.trim().toLowerCase();
  const matched = keyword
    ? rows.filter((row) =>
        [
          row.id,
          row.summary,
          row.scope ? scopeLabel(row.scope) : "",
          ...row.params,
          ...row.sensitiveFields,
        ].some((value) => value.toLowerCase().includes(keyword)),
      )
    : rows;

  const sections = METADATA_DOMAIN_GROUP_IDS.map((group) => ({
    group,
    items: matched.filter((row) => row.group === group),
  })).filter((section) => section.items.length > 0);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("plugins.metadata.title", {
        defaultValue: "App metadata available to plugins",
      })}
      description={t("plugins.metadata.description", {
        defaultValue:
          "Metadata domains a plugin can read through api.metadata (read-only).",
      })}
      closeLabel={t("common.close", { defaultValue: "Close" })}
      size="large"
      className="plugin-metadata-modal"
      closeOnEscape
    >
      <div className="plugin-metadata-body">
        <div className="plugin-metadata-toolbar">
          <div className="plugin-metadata-search">
            <Search size={14} strokeWidth={1.8} />
            <input
              aria-label={t("plugins.metadata.searchPlaceholder", {
                defaultValue: "Search domains, fields or parameters",
              })}
              className="plugin-metadata-search-input"
              type="text"
              value={query}
              placeholder={t("plugins.metadata.searchPlaceholder", {
                defaultValue: "Search domains, fields or parameters",
              })}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <span className="plugin-metadata-count">
            {t("plugins.metadata.count", {
              values: { matched: matched.length, total: rows.length },
              defaultValue: "{{matched}} / {{total}} domains",
            })}
          </span>
        </div>

        {plugin && (
          <div className="plugin-metadata-context">
            <ShieldAlert size={13} strokeWidth={1.8} />
            <span>
              {t("plugins.metadata.pluginContext", {
                values: {
                  name:
                    resolveLocalized(plugin.name, locale) || plugin.pluginId,
                  granted: grantedCount,
                  total: rows.length,
                },
                defaultValue:
                  "{{name}}: {{granted}} / {{total}} domains readable",
              })}
            </span>
          </div>
        )}

        <div className="plugin-metadata-list">
          {sections.map((section) => (
            <div className="plugin-metadata-group" key={section.group}>
              <div className="plugin-metadata-group-title">
                {t(`plugins.metadata.groups.${section.group}`, {
                  defaultValue: section.group,
                })}
              </div>
              {section.items.map((row) => (
                <div className="plugin-metadata-item" key={row.id}>
                  <div className="plugin-metadata-item-head">
                    <code className="plugin-metadata-id">{row.id}</code>
                    <div className="plugin-metadata-badges">
                      {row.scope ? (
                        <span
                          className="plugin-metadata-badge scope"
                          title={t("plugins.metadata.scopeHint", {
                            values: { scope: scopeLabel(row.scope) },
                            defaultValue:
                              "Reading this domain requires declaring the “{{scope}}” privacy scope in plugin.json",
                          })}
                        >
                          {scopeLabel(row.scope)}
                        </span>
                      ) : row.sensitiveFields.length > 0 ? (
                        <span
                          className="plugin-metadata-badge field"
                          title={row.sensitiveFields.join(", ")}
                        >
                          {t("plugins.metadata.fieldLevel", {
                            defaultValue: "Field-level",
                          })}
                        </span>
                      ) : (
                        <span className="plugin-metadata-badge public">
                          {t("plugins.metadata.public", {
                            defaultValue: "Public",
                          })}
                        </span>
                      )}
                      <span
                        className={`plugin-metadata-badge${
                          row.live ? " live" : " polled"
                        }`}
                      >
                        {row.live
                          ? t("plugins.metadata.live", { defaultValue: "Live" })
                          : t("plugins.metadata.polled", {
                              defaultValue: "Polled",
                            })}
                      </span>
                      {row.granted !== null && (
                        <span
                          className={`plugin-metadata-badge${
                            row.granted ? " granted" : " denied"
                          }`}
                        >
                          {row.granted
                            ? t("plugins.metadata.granted", {
                                defaultValue: "Readable",
                              })
                            : t("plugins.metadata.denied", {
                                defaultValue: "Not declared",
                              })}
                        </span>
                      )}
                    </div>
                  </div>

                  {row.summary && (
                    <div className="plugin-metadata-summary">{row.summary}</div>
                  )}

                  {row.params.length > 0 && (
                    <div className="plugin-metadata-params">
                      <span className="plugin-metadata-params-label">
                        {t("plugins.metadata.params", {
                          defaultValue: "Parameters",
                        })}
                      </span>
                      {row.params.map((param) => (
                        <code className="plugin-metadata-param" key={param}>
                          {param}
                        </code>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}

          {sections.length === 0 && (
            <div className="plugin-metadata-empty">
              {t("plugins.metadata.empty", {
                defaultValue: "No matching metadata domain",
              })}
            </div>
          )}
        </div>

        <div className="plugin-metadata-hint">
          {t("plugins.metadata.docHint", {
            defaultValue:
              "Full fields and examples: the built-in plugin metadata domain reference.",
          })}
        </div>
      </div>
    </Modal>
  );
};
