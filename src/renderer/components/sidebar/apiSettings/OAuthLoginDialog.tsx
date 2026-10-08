import { useCallback, useEffect, useState } from "react";
import type { OAuthLoginStatus, OAuthProviderInfo } from "../../../../preload";
import { OAuthProviderLoginDialog } from "./OAuthProviderLoginDialog";
import { OAuthProviderPicker } from "./OAuthProviderPicker";

type OAuthLoginDialogProps = {
  open: boolean;
  onClose: () => void;
  onCompleted: (status: OAuthLoginStatus) => void;
};

export function OAuthLoginDialog({
  open,
  onClose,
  onCompleted,
}: OAuthLoginDialogProps): React.JSX.Element {
  const [providers, setProviders] = useState<OAuthProviderInfo[]>([]);
  const [isLoadingProviders, setIsLoadingProviders] = useState(false);
  const [selectedProvider, setSelectedProvider] =
    useState<OAuthProviderInfo | null>(null);

  useEffect(() => {
    if (!open) {
      setSelectedProvider(null);
      return;
    }
    if (providers.length > 0) {
      return;
    }

    let stopped = false;
    setIsLoadingProviders(true);
    void window.snow
      .listOAuthProviders()
      .then((list) => {
        if (!stopped) {
          setProviders(list);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!stopped) {
          setIsLoadingProviders(false);
        }
      });
    return () => {
      stopped = true;
    };
  }, [open, providers.length]);

  const handleSelect = useCallback((provider: OAuthProviderInfo) => {
    setSelectedProvider(provider);
  }, []);

  const handleBack = useCallback(() => {
    setSelectedProvider(null);
  }, []);

  return (
    <>
      <OAuthProviderPicker
        open={open && !selectedProvider}
        providers={providers}
        isLoading={isLoadingProviders}
        onSelect={handleSelect}
        onClose={onClose}
      />
      {selectedProvider ? (
        <OAuthProviderLoginDialog
          open={open}
          provider={selectedProvider}
          onBack={handleBack}
          onClose={onClose}
          onCompleted={onCompleted}
        />
      ) : null}
    </>
  );
}
