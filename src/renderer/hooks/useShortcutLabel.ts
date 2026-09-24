import { useKeyboardShortcutsSettings } from "../components/KeyboardShortcutsProvider";
import { keyToDisplay } from "../utils/shortcutUtils";

/**
 * 读取当前快捷键设置中的组合键并转为平台显示文本。
 * 组件就近提示（按钮 title / placeholder）使用。
 */
export const useShortcutLabel = (
  action: Parameters<
    ReturnType<typeof useKeyboardShortcutsSettings>["getHandler"]
  >[0],
): string => {
  const { settings } = useKeyboardShortcutsSettings();
  const config = settings[action];
  return config ? keyToDisplay(config.key) : "";
};
