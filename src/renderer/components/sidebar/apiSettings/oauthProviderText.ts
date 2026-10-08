import type { OAuthProviderInfo } from "../../../../preload";

type OAuthTranslator = (
  key: string,
  options?: { defaultValue?: string; values?: Record<string, string | number> },
) => string;

export function oauthProviderLabel(
  t: OAuthTranslator,
  provider: OAuthProviderInfo | null,
): string {
  if (!provider) {
    return t("settings.oauthLoginTitle", { defaultValue: "OAuth sign-in" });
  }
  return t(`settings.oauthProvider.${provider.id}`, {
    defaultValue: provider.displayName,
  });
}

export function oauthProviderDescription(
  t: OAuthTranslator,
  provider: OAuthProviderInfo,
): string {
  return t(`settings.oauthProviderDesc.${provider.id}`, {
    defaultValue: t("settings.oauthProviderDescFallback", {
      defaultValue:
        "Sign in to {{name}} through the OAuth flow. The credential file is fetched and saved automatically.",
      values: { name: provider.displayName },
    }),
  });
}
