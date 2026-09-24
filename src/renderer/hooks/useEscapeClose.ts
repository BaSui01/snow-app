import { useEffect, useRef } from "react";

import { useKeyboardShortcutsSettings } from "../components/KeyboardShortcutsProvider";

export const useEscapeClose = (onEscape: () => void, enabled = true): void => {
  const { registerScopedHandler } = useKeyboardShortcutsSettings();
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useEffect(() => {
    if (!enabled) return undefined;
    return registerScopedHandler(
      "cancelSession",
      () => onEscapeRef.current(),
      () => true,
    );
  }, [enabled, registerScopedHandler]);
};
