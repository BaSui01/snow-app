import { ShieldAlert } from "lucide-react";

import { useI18n } from "../../i18n";
import type { SensitiveScope } from "../../plugins/types";

/** 徽章行最多直接展开的域数量，其余折叠为 +N。 */
const MAX_VISIBLE_SCOPES = 6;

type PluginPrivacyBadgesProps = {
  scopes: readonly SensitiveScope[];
  onOpen: () => void;
};

/** 插件 / 客户端脚本的隐私域徽章：点击任意徽章查看声明详情。 */
export const PluginPrivacyBadges = ({
  scopes,
  onOpen,
}: PluginPrivacyBadgesProps): React.JSX.Element | null => {
  const { t } = useI18n();
  if (scopes.length === 0) {
    return null;
  }

  const scopeLabel = (scope: SensitiveScope): string =>
    t(`plugins.scopes.${scope}`, { defaultValue: scope });
  const hint = t("plugins.privacy.viewHint", {
    defaultValue: "View privacy scopes",
  });
  const visible = scopes.slice(0, MAX_VISIBLE_SCOPES);
  const hidden = scopes.length - visible.length;

  return (
    <div className="plugins-privacy-tags">
      <ShieldAlert size={12} strokeWidth={1.8} />
      {visible.map((scope) => (
        <button
          className="plugins-privacy-tag"
          key={scope}
          title={`${scopeLabel(scope)} · ${hint}`}
          type="button"
          onClick={onOpen}
        >
          {scopeLabel(scope)}
        </button>
      ))}
      {hidden > 0 && (
        <button
          className="plugins-privacy-tag"
          title={hint}
          type="button"
          onClick={onOpen}
        >
          {t("plugins.privacy.more", {
            defaultValue: "+{{count}}",
            values: { count: hidden },
          })}
        </button>
      )}
    </div>
  );
};
