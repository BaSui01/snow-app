import { useCallback, useEffect, useState } from "react";
import {
  CUSTOM_COMMANDS_CHANGED_EVENT,
  selectEffectiveCustomCommands,
  type EffectiveCustomCommand,
} from "./customCommands";

export const useCustomCommands = (
  projectId?: string,
): EffectiveCustomCommand[] => {
  const [commands, setCommands] = useState<EffectiveCustomCommand[]>([]);

  const load = useCallback(async (): Promise<void> => {
    try {
      const records = await window.snow.listCustomCommands(projectId);
      setCommands(selectEffectiveCustomCommands(records));
    } catch {
      setCommands([]);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const handleChanged = (): void => {
      void load();
    };
    window.addEventListener(CUSTOM_COMMANDS_CHANGED_EVENT, handleChanged);
    return () => {
      window.removeEventListener(CUSTOM_COMMANDS_CHANGED_EVENT, handleChanged);
    };
  }, [load]);

  return commands;
};
