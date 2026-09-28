import { fetchUnlockMethods, RemoteHttpError, unlock } from "./api";
import { $ } from "./dom";
import { t } from "./i18n";
import { showNotice } from "./notice";

const TOTP_CODE_LENGTH = 6;

type UnlockMode = "token" | "totp";

/**
 * 令牌填写页：手机未携带有效令牌（未授权 / 令牌被更换 / 连不上）时展示，
 * 提交后由原生服务校验并写入会话 Cookie，成功后立刻重新拉取状态。
 * 桌面端绑定谷歌身份验证器并允许远控解锁时，还可切换到 6 位动态码，
 * 用动态码代替配对令牌解锁（局域网与公网一致）。
 */
let visible = false;
let submitting = false;
let mode: UnlockMode = "token";
let totpAvailable = false;
let methodsLoaded = false;

const setError = (message: string): void => {
  const el = $("unlockError");
  el.textContent = message;
  el.hidden = !message;
};

const setBusy = (busy: boolean): void => {
  submitting = busy;
  const input = $<HTMLInputElement>("unlockInput");
  const submit = $<HTMLButtonElement>("unlockSubmit");
  const paste = $<HTMLButtonElement>("unlockPaste");
  input.disabled = busy;
  submit.disabled = busy;
  paste.disabled = busy;
  submit.textContent = t(busy ? "remote.unlock.busy" : "remote.unlock.submit");
};

const digitsOnly = (value: string): string =>
  value.replace(/\D/g, "").slice(0, TOTP_CODE_LENGTH);

const supportsTextSecurity = (): boolean =>
  typeof CSS !== "undefined" &&
  typeof CSS.supports === "function" &&
  CSS.supports("-webkit-text-security", "disc");

/** 令牌默认遮挡输入；动态码需要肉眼核对，固定明文显示并由样式放大字距。 */
const applyInputType = (): void => {
  const input = $<HTMLInputElement>("unlockInput");
  if (mode === "totp") {
    input.type = "text";
    return;
  }
  input.type = supportsTextSecurity() ? "text" : "password";
};

/** 同步当前解锁方式：文案、输入约束、粘贴按钮与方式切换器。 */
const applyMode = (): void => {
  const tokenMode = mode === "token";
  const input = $<HTMLInputElement>("unlockInput");
  $("unlockOverlay").classList.toggle("mode-code", !tokenMode);
  $("unlockModes").hidden = !totpAvailable;
  $("unlockModeToken").classList.toggle("is-active", tokenMode);
  $("unlockModeTotp").classList.toggle("is-active", !tokenMode);
  $("unlockModeToken").setAttribute("aria-selected", String(tokenMode));
  $("unlockModeTotp").setAttribute("aria-selected", String(!tokenMode));
  $("unlockLead").textContent = t(
    tokenMode ? "remote.unlock.lead" : "remote.unlock.totpLead",
  );
  $("unlockHint").textContent = t(
    tokenMode ? "remote.unlock.hint" : "remote.unlock.totpHint",
  );
  $("unlockPaste").hidden = !tokenMode;
  input.value = "";
  input.inputMode = tokenMode ? "text" : "numeric";
  input.placeholder = t(
    tokenMode ? "remote.unlock.placeholder" : "remote.unlock.totpPlaceholder",
  );
  input.setAttribute("aria-label", input.placeholder);
  if (tokenMode) {
    input.removeAttribute("maxlength");
  } else {
    input.maxLength = TOTP_CODE_LENGTH;
  }
  applyInputType();
  setError("");
};

const switchMode = (next: UnlockMode): void => {
  if (mode === next) return;
  mode = next;
  applyMode();
  if (visible && !submitting) $<HTMLInputElement>("unlockInput").focus();
};

/** 首次展示时询问服务端可用的解锁方式：动态码需桌面端已绑定身份验证器。 */
const loadMethods = async (): Promise<void> => {
  if (methodsLoaded) return;
  methodsLoaded = true;
  try {
    totpAvailable = (await fetchUnlockMethods()).totp === true;
  } catch {
    totpAvailable = false;
  }
  $("unlockModes").hidden = !totpAvailable;
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
  void loadMethods();
};

/** 收起令牌填写页（状态恢复时自动调用）。 */
export const hideUnlock = (): void => {
  if (!visible) return;
  visible = false;
  setError("");
  $("unlockOverlay").classList.remove("open");
};

const submit = async (
  onUnlocked: () => void | Promise<void>,
): Promise<void> => {
  const input = $<HTMLInputElement>("unlockInput");
  const value = input.value.trim();
  const code = digitsOnly(value);
  const codeMode = mode === "totp";
  if (codeMode ? code.length !== TOTP_CODE_LENGTH : value.length === 0) {
    setError(t(codeMode ? "remote.unlock.totpEmpty" : "remote.unlock.empty"));
    return;
  }
  setBusy(true);
  setError("");
  try {
    await unlock(codeMode ? { code } : { token: value });
    input.value = "";
    hideUnlock();
    showNotice(t("remote.unlock.success"));
    await onUnlocked();
  } catch (error) {
    const status = error instanceof RemoteHttpError ? error.status : 0;
    if (status === 429) {
      setError(t("remote.unlock.tooMany"));
    } else if (status === 401 || status === 403) {
      setError(
        t(codeMode ? "remote.unlock.totpFailed" : "remote.unlock.failed"),
      );
    } else {
      setError((error as Error).message || t("remote.unlock.failed"));
    }
  } finally {
    setBusy(false);
  }
};

const readClipboardText = async (): Promise<string> => {
  const clipboard = navigator.clipboard;
  if (!clipboard?.readText) return "";
  try {
    return await clipboard.readText();
  } catch {
    return "";
  }
};

const legacyPaste = (input: HTMLInputElement): string => {
  const before = input.value;
  input.focus();
  input.setSelectionRange(before.length, before.length);
  try {
    if (!document.execCommand("paste")) return "";
  } catch {
    return "";
  }
  return input.value.length > before.length ? input.value.trim() : "";
};

const pasteToken = async (): Promise<void> => {
  if (submitting) return;
  const input = $<HTMLInputElement>("unlockInput");
  const token = (await readClipboardText()).trim() || legacyPaste(input);
  if (!token) {
    input.focus();
    showNotice(t("remote.unlock.pasteHint"), true);
    return;
  }
  input.value = token;
  setError("");
  input.focus();
  input.setSelectionRange(token.length, token.length);
};

/** 装配令牌页：方式切换、提交、重新加载，以及离线空态里的「填写令牌」入口。 */
export const initUnlock = (onUnlocked: () => void | Promise<void>): void => {
  applyMode();
  setBusy(false);
  $("unlockModeToken").addEventListener("click", () => switchMode("token"));
  $("unlockModeTotp").addEventListener("click", () => switchMode("totp"));
  $("unlockInput").addEventListener("input", () => {
    if (mode !== "totp") return;
    const input = $<HTMLInputElement>("unlockInput");
    const digits = digitsOnly(input.value);
    if (digits !== input.value) input.value = digits;
  });
  $("unlockPaste").addEventListener("click", () => void pasteToken());
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
