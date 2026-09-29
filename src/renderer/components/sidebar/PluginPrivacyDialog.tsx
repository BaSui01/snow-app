import { Database, Pencil, ShieldAlert } from "lucide-react";
import { useMemo } from "react";

import { useI18n } from "../../i18n";
import { describePrivacyScopes } from "../../plugins/privacy";
import type { SensitiveScope } from "../../plugins/types";
import { Modal } from "../common/Modal";

/** 隐私域详情的目标：面板插件（plugin.json）或客户端脚本（@snow-privacy）。 */
export type PluginPrivacyTarget = {
  name: string;
  source: "plugin" | "script";
  scopes: SensitiveScope[];
  note: string;
};

type PluginPrivacyDialogProps = {
  target: PluginPrivacyTarget | null;
  onClose: () => void;
};

/** 统一的隐私域声明详情弹窗：面板插件与脚本插件共用。 */
export const PluginPrivacyDialog = ({
  target,
  onClose,
}: PluginPrivacyDialogProps): React.JSX.Element => {
  const { t, locale } = useI18n();
  const scopes = target?.scopes ?? [];
  const entries = useMemo(
    () => describePrivacyScopes(scopes, locale),
    [locale, scopes],
  );
  const name = target?.name ?? "";

  const scopeLabel = (scope: SensitiveScope): string =>
    t(`plugins.scopes.${scope}`, { defaultValue: scope });

  return (
    <Modal
      className="plugin-privacy-dialog"
      closeLabel={t("plugins.privacy.close", {
        defaultValue: "Close privacy scopes",
      })}
      closeOnEscape
      description={name}
      open={target !== null}
      size="medium"
      title={t("plugins.privacy.title", {
        defaultValue: "Privacy scopes",
      })}
      onClose={onClose}
    >
      <div className="plugin-privacy-caption">
        {t("plugins.privacy.caption", {
          values: { name, count: scopes.length },
          defaultValue:
            "“{{name}}” declares {{count}} sensitive scopes. Reading app metadata (api.metadata) and running write actions (api.write) are allowed only inside these declarations; undeclared sensitive scopes are denied.",
        })}
      </div>

      {entries.length === 0 ? (
        <div className="plugin-privacy-empty">
          <ShieldAlert size={20} strokeWidth={1.6} />
          <span>
            {t("plugins.privacy.empty", {
              defaultValue: "No privacy scope declared",
            })}
          </span>
          <span className="plugin-privacy-empty-hint">
            {t("plugins.privacy.emptyHint", {
              defaultValue:
                "Sensitive reads and writes are all denied; public domains are unaffected.",
            })}
          </span>
        </div>
      ) : (
        <div className="plugin-privacy-list">
          {entries.map((entry) => (
            <div className="plugin-privacy-item" key={entry.scope}>
              <div className="plugin-privacy-item-head">
                <ShieldAlert size={13} strokeWidth={1.8} />
                <span className="plugin-privacy-name">
                  {scopeLabel(entry.scope)}
                </span>
                <code className="plugin-privacy-scope">{entry.scope}</code>
                <div className="plugin-privacy-counts">
                  {entry.metadata.length > 0 && (
                    <span className="plugin-privacy-count">
                      {t("plugins.privacy.readCount", {
                        values: { count: entry.metadata.length },
                        defaultValue: "{{count}} readable",
                      })}
                    </span>
                  )}
                  {entry.writeCount > 0 && (
                    <span className="plugin-privacy-count">
                      {t("plugins.privacy.writeCount", {
                        values: { count: entry.writeCount },
                        defaultValue: "{{count}} writable",
                      })}
                    </span>
                  )}
                </div>
              </div>

              <div className="plugin-privacy-desc">
                {t(`plugins.scopes.desc.${entry.scope}`, { defaultValue: "" })}
              </div>

              {entry.metadata.length > 0 && (
                <div className="plugin-privacy-section">
                  <span className="plugin-privacy-section-label">
                    <Database size={11} strokeWidth={1.8} />
                    {t("plugins.privacy.readTitle", {
                      defaultValue: "Readable metadata",
                    })}
                  </span>
                  <div className="plugin-privacy-chips">
                    {entry.metadata.map((item) => (
                      <span
                        className="plugin-privacy-chip"
                        key={item.id}
                        title={item.summary}
                      >
                        <code>{item.id}</code>
                        {item.fields.length > 0 && (
                          <em>
                            {t("plugins.privacy.fieldLevel", {
                              values: { fields: item.fields.join(" / ") },
                              defaultValue: "fields: {{fields}}",
                            })}
                          </em>
                        )}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {entry.writeDomains.length > 0 && (
                <div className="plugin-privacy-section">
                  <span className="plugin-privacy-section-label">
                    <Pencil size={11} strokeWidth={1.8} />
                    {t("plugins.privacy.writeTitle", {
                      defaultValue: "Writable actions",
                    })}
                  </span>
                  <div className="plugin-privacy-chips">
                    {entry.writeDomains.map((item) => (
                      <span className="plugin-privacy-chip" key={item.domain}>
                        <code>{item.domain}</code>
                        <em>×{item.count}</em>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {target?.note ? (
        <div className="plugins-privacy-note">{target.note}</div>
      ) : null}

      <div className="plugin-privacy-source">
        {target?.source === "script"
          ? t("plugins.privacy.sourceScript", {
              defaultValue:
                "Declared in the script metadata header (@snow-privacy).",
            })
          : t("plugins.privacy.sourcePlugin", {
              defaultValue: "Declared in plugin.json (privacy).",
            })}
      </div>
      <div className="plugin-privacy-doc">{t("plugins.privacy.docHint")}</div>
    </Modal>
  );
};
