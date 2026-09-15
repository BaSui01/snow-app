import { RemoteHttpError, unlock } from "./api";
import { $ } from "./dom";
import { t } from "./i18n";
import { showNotice } from "./notice";

/**
 * 令牌填写页：手机未携带有效令牌（未授权 / 令牌被更换 / 连不上）时展示，
 * 提交后由原生服务校验并写入会话 Cookie，成功后立刻重新拉取状态。
 */
let visible = false;
let submitting = false;

const setError = (message: string): void => {
  const el = $("unlockError");
  el.textContent = message;
  el.hidden = !message;
};

const setBusy = (busy: boolean): void => {
  submitting = busy;
  const input = $<HTMLInputElement>("unlockInput");
  const submit = $<HTMLButtonElement>("unlockSubmit");
  input.disabled = busy;
  submit.disabled = busy;
  submit.textContent = t(busy ? "remote.unlock.busy" : "remote.unlock.submit");
};

/** 展示令牌填写页；重复调用只更新错误文案（不打断输入）。 */
export const showUnlock = (message?: string): void => {
  if (message !== undefined) setError(message);
  if (visible) return;
  visible = true;
  $("unlockOverlay").classList.add("open");
  window.setTimeout(() => {
    if (visible && !submitting) $<HTMLInputElement>("unlockInput").focus();
  }, 60);
};

/** 收起令牌填写页（状态恢复时自动调用）。 */
export const hideUnlock = (): void => {
  if (!visible) return;
  visible = false;
  setError("");
  $("unlockOverlay").classList.remove("open");
};

const submit = async (onUnlocked: () => void | Promise<void>): Promise<void> => {
  const input = $<HTMLInputElement>("unlockInput");
  const token = input.value.trim();
  if (!token) {
    setError(t("remote.unlock.empty"));
    return;
  }
  setBusy(true);
  setError("");
  try {
    await unlock(token);
    input.value = "";
    hideUnlock();
    showNotice(t("remote.unlock.success"));
    await onUnlocked();
  } catch (error) {
    const status = error instanceof RemoteHttpError ? error.status : 0;
    if (status === 429) {
      setError(t("remote.unlock.tooMany"));
    } else if (status === 401 || status === 403) {
      setError(t("remote.unlock.failed"));
    } else {
      setError((error as Error).message || t("remote.unlock.failed"));
    }
  } finally {
    setBusy(false);
  }
};

/** 装配令牌页：提交、重新加载，以及离线空态里的「填写令牌」入口。 */
export const initUnlock = (onUnlocked: () => void | Promise<void>): void => {
  setBusy(false);
  $("unlockForm").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!submitting) void submit(onUnlocked);
  });
  $("unlockReload").addEventListener("click", () => window.location.reload());
  $("messages").addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    if (!target?.closest("[data-unlock-open]")) return;
    showUnlock("");
  });
};
