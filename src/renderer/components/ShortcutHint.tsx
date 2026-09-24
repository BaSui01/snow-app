import { Fragment } from "react";

import type { KeyboardShortcutAction } from "../../preload";
import { keyToDisplay } from "../utils/shortcutUtils";
import { useKeyboardShortcutsSettings } from "./KeyboardShortcutsProvider";

export const useShortcutHintKeys = (
  actions: KeyboardShortcutAction[],
): string[][] => {
  const { settings } = useKeyboardShortcutsSettings();
  const groups: string[][] = [];
  for (const action of actions) {
    const config = settings[action];
    if (!config?.enabled || !config.key) continue;
    groups.push(keyToDisplay(config.key).split(" + "));
  }
  return groups;
};

type ShortcutHintProps = {
  action?: KeyboardShortcutAction;
  actions?: KeyboardShortcutAction[];
  className?: string;
};

export function ShortcutHint({
  action,
  actions,
  className,
}: ShortcutHintProps): React.JSX.Element | null {
  const list = actions ?? (action ? [action] : []);
  const groups = useShortcutHintKeys(list);
  if (groups.length === 0) return null;
  return (
    <span
      aria-hidden="true"
      className={className ? `shortcut-hint ${className}` : "shortcut-hint"}
    >
      {groups.map((keys, groupIndex) => (
        <Fragment key={groupIndex}>
          {groupIndex > 0 && <span className="shortcut-hint-sep">/</span>}
          <span className="shortcut-hint-group">
            {keys.map((key) => (
              <kbd className="shortcut-hint-key" key={key}>
                {key}
              </kbd>
            ))}
          </span>
        </Fragment>
      ))}
    </span>
  );
}
