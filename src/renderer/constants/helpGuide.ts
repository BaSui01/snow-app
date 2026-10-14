import { useEffect, useSyncExternalStore } from "react";

/** 「使用指南」提示的持久化状态（system_settings，重启后仍生效）。 */
export const HELP_GUIDE_USED_SETTING_CODE = "help_guide_used";
export const HELP_GUIDE_HINT_DISMISSED_SETTING_CODE =
  "help_guide_hint_dismissed";

const HELP_GUIDE_USED_SETTING_NAME = "使用指南已使用";
const HELP_GUIDE_HINT_DISMISSED_SETTING_NAME = "使用指南提示已关闭";

type HelpGuideSnapshot = {
  ready: boolean;
  used: boolean;
  hintDismissed: boolean;
};

let snapshot: HelpGuideSnapshot = {
  ready: false,
  used: false,
  hintDismissed: false,
};
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

const publish = (next: HelpGuideSnapshot): void => {
  snapshot = next;
  listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const getSnapshot = (): HelpGuideSnapshot => snapshot;

const load = (): Promise<void> => {
  if (!loading) {
    loading = (async () => {
      try {
        const [used, dismissed] = await Promise.all([
          window.snow.getSystemSettingValue(HELP_GUIDE_USED_SETTING_CODE),
          window.snow.getSystemSettingValue(
            HELP_GUIDE_HINT_DISMISSED_SETTING_CODE,
          ),
        ]);
        publish({
          ready: true,
          used: snapshot.used || used === "1",
          hintDismissed: snapshot.hintDismissed || dismissed === "1",
        });
      } catch {
        // 读取失败时保持隐藏，下次挂载再重试
        loading = null;
      }
    })();
  }
  return loading;
};

const persist = (name: string, code: string): void => {
  void window.snow.setSystemSetting(name, code, "1").catch(() => undefined);
};

/** 用户通过任一「使用指南」入口发起提问后，空状态提示收起。 */
export const markHelpGuideUsed = (): void => {
  if (snapshot.used) {
    return;
  }
  publish({ ...snapshot, used: true });
  persist(HELP_GUIDE_USED_SETTING_NAME, HELP_GUIDE_USED_SETTING_CODE);
};

/** 「不再提示」：空状态提示永久收起。 */
export const dismissHelpGuideHint = (): void => {
  if (snapshot.hintDismissed) {
    return;
  }
  publish({ ...snapshot, hintDismissed: true });
  persist(
    HELP_GUIDE_HINT_DISMISSED_SETTING_NAME,
    HELP_GUIDE_HINT_DISMISSED_SETTING_CODE,
  );
};

const HELP_SKILL_NAME = "snow-app-docs";

/** snow-app-docs 技能被明确关闭时为 true；未找到或查询失败时视为可用。 */
export const isHelpSkillDisabled = async (
  directoryId?: string,
): Promise<boolean> => {
  try {
    const skills = await window.snow.listAvailableSkills(
      directoryId || undefined,
    );
    const skill = skills.find((item) => item.name === HELP_SKILL_NAME);
    return skill !== undefined && !skill.enabled;
  } catch {
    return false;
  }
};

/** 空状态提示是否展示：配置已加载、未使用过且未关闭。 */
export const useHelpGuideHint = (): boolean => {
  const state = useSyncExternalStore(subscribe, getSnapshot);
  useEffect(() => {
    void load();
  }, []);
  return state.ready && !state.used && !state.hintDismissed;
};
