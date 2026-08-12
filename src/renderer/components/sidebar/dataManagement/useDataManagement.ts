import { useCallback, useEffect, useState } from "react";
import type {
  DataManagementProgress,
  DataManagementSettings,
  DataManagementSettingsPatch,
  DataManagementState,
} from "../../../../preload";

export type UseDataManagementResult = {
  state: DataManagementState | null;
  settings: DataManagementSettings | null;
  progress: DataManagementProgress | null;
  isLoading: boolean;
  isSaving: boolean;
  error: string;
  refresh: () => Promise<void>;
  updateSettings: (patch: DataManagementSettingsPatch) => Promise<void>;
};

export const useDataManagement = (): UseDataManagementResult => {
  const [state, setState] = useState<DataManagementState | null>(null);
  const [settings, setSettings] = useState<DataManagementSettings | null>(null);
  const [progress, setProgress] = useState<DataManagementProgress | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    try {
      const [nextState, nextSettings] = await Promise.all([
        window.snow.getDataManagementState(),
        window.snow.getDataManagementSettings(),
      ]);
      setState(nextState);
      setSettings(nextSettings);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return window.snow.onDataManagementProgress((nextProgress) => {
      setProgress(nextProgress);
      if (nextProgress.status === "failed" && nextProgress.error) {
        setError(nextProgress.error);
      }
    });
  }, [refresh]);

  const updateSettings = useCallback(
    async (patch: DataManagementSettingsPatch): Promise<void> => {
      setIsSaving(true);
      try {
        const nextSettings = await window.snow.setDataManagementSettings(patch);
        setSettings(nextSettings);
        setState((current) =>
          current
            ? { ...current, deviceName: nextSettings.deviceName }
            : current
        );
        setError("");
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        throw cause;
      } finally {
        setIsSaving(false);
      }
    },
    []
  );

  return {
    state,
    settings,
    progress,
    isLoading,
    isSaving,
    error,
    refresh,
    updateSettings,
  };
};
