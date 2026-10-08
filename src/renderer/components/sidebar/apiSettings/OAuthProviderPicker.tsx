import { Loader2 } from "lucide-react";
import { Modal } from "../../common/Modal";
import { useI18n } from "../../../i18n";
import type { OAuthProviderInfo } from "../../../../preload";
import { OAuthProviderIcon } from "./OAuthProviderIcon";
import {
  oauthProviderDescription,
  oauthProviderLabel,
} from "./oauthProviderText";

type OAuthProviderPickerProps = {
  open: boolean;
  providers: OAuthProviderInfo[];
  isLoading: boolean;
  onSelect: (provider: OAuthProviderInfo) => void;
  onClose: () => void;
};

export function OAuthProviderPicker({
  open,
  providers,
  isLoading,
  onSelect,
  onClose,
}: OAuthProviderPickerProps): React.JSX.Element {
  const { t } = useI18n();

  return (
    <Modal
      open={open}
      title={t("settings.oauthPickTitle", {
        defaultValue: "Choose sign-in type",
      })}
      description={t("settings.oauthPickDescription", {
        defaultValue:
          "Pick the subscription service to connect, then complete the authorization in your browser.",
      })}
      closeLabel={t("settings.close", { defaultValue: "Close" })}
      onClose={onClose}
      className="oauth-provider-picker"
      footer={
        <button
          className="api-settings-form-btn secondary"
          type="button"
          onClick={onClose}
        >
          <span>{t("settings.close", { defaultValue: "Close" })}</span>
        </button>
      }
    >
      {isLoading ? (
        <div className="oauth-login-status">
          <Loader2 size={14} className="spin" />
          <span>
            {t("settings.oauthLoadingProviders", {
              defaultValue: "Loading available providers...",
            })}
          </span>
        </div>
      ) : providers.length === 0 ? (
        <p className="oauth-login-hint">
          {t("settings.oauthProviderMissing", {
            defaultValue: "No OAuth provider is available.",
          })}
        </p>
      ) : (
        <div className="oauth-provider-list">
          {providers.map((provider) => (
            <button
              className="oauth-provider-card"
              key={provider.id}
              type="button"
              onClick={() => onSelect(provider)}
            >
              <span className="oauth-provider-card-head">
                <span className="oauth-provider-icon">
                  <OAuthProviderIcon providerId={provider.id} size={22} />
                </span>
                <strong>{oauthProviderLabel(t, provider)}</strong>
              </span>
              <span className="oauth-provider-card-desc">
                {oauthProviderDescription(t, provider)}
              </span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
