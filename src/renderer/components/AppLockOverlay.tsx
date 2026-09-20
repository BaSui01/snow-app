import { KeyRound, LoaderCircle, LockKeyhole, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAppLock } from "../hooks/useAppLock";
import { useI18n } from "../i18n";
import type { AppLockVerifyResult } from "../../preload";

const PIN_MAX_LENGTH = 8;
const TOTP_CODE_LENGTH = 6;

export function AppLockOverlay(): React.JSX.Element | null {
  const { t } = useI18n();
  const { locked, state, markUnlocked } = useAppLock();
  const [mode, setMode] = useState<"pin" | "totp">("pin");
  const [pin, setPin] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!locked) {
      return;
    }
    setMode("pin");
    setPin("");
    setCode("");
    setError("");
  }, [locked]);

  useEffect(() => {
    if (locked) {
      inputRef.current?.focus();
    }
  }, [locked, mode]);

  const cooldownSeconds = Math.max(
    0,
    Math.ceil((cooldownUntil - nowMs) / 1000),
  );

  useEffect(() => {
    if (cooldownSeconds <= 0) {
      return;
    }
    const timer = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [cooldownSeconds]);

  const applyResult = useCallback(
    (result: AppLockVerifyResult): boolean => {
      if (result.ok) {
        return true;
      }
      if (result.retryAfterMs > 0) {
        setCooldownUntil(Date.now() + result.retryAfterMs);
        setNowMs(Date.now());
        setError("");
        return false;
      }
      setError(
        result.remainingAttempts > 0
          ? t("settings.appLockAttemptsLeft", {
              values: { count: result.remainingAttempts },
              defaultValue: `Incorrect. ${result.remainingAttempts} attempt(s) left`,
            })
          : t("settings.appLockWrongCode", { defaultValue: "Incorrect code" }),
      );
      return false;
    },
    [t],
  );

  const handleUnlock = useCallback(async (): Promise<void> => {
    if (busy || cooldownSeconds > 0) {
      return;
    }
    setBusy(true);
    try {
      const result =
        mode === "pin"
          ? await window.snow.verifyAppLockPin(pin)
          : await window.snow.verifyAppLockTotp(code);
      if (!applyResult(result)) {
        return;
      }
      await window.snow.unlockApp();
      markUnlocked();
    } catch {
      setError(
        t("settings.appLockUnlockFailed", {
          defaultValue: "Unlock failed, please try again",
        }),
      );
    } finally {
      setBusy(false);
    }
  }, [applyResult, busy, code, cooldownSeconds, markUnlocked, mode, pin, t]);

  if (!locked || state === null) {
    return null;
  }

  const isPinMode = mode === "pin";
  const submitDisabled =
    busy ||
    cooldownSeconds > 0 ||
    (isPinMode ? pin.length === 0 : code.length === 0);

  return (
    <div className="app-lock-overlay" role="dialog" aria-modal="true">
      <div className="app-lock-card">
        <span className="app-lock-icon" aria-hidden="true">
          <LockKeyhole size={20} strokeWidth={1.7} />
        </span>
        <strong className="app-lock-title">
          {t("settings.appLockLockedTitle", { defaultValue: "Snow App locked" })}
        </strong>
        <span className="app-lock-subtitle">
          {isPinMode
            ? t("settings.appLockLockedInfo", {
                defaultValue:
                  "Enter your PIN to unlock. Sessions keep running in the background.",
              })
            : t("settings.appLockTotpRecoveryInfo", {
                defaultValue: "Enter the 6-digit code from Google Authenticator.",
              })}
        </span>

        <form
          className="app-lock-form"
          onSubmit={(event) => {
            event.preventDefault();
            void handleUnlock();
          }}
        >
          {isPinMode ? (
            <input
              ref={inputRef}
              className="app-lock-input"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              maxLength={PIN_MAX_LENGTH}
              value={pin}
              onChange={(event) => {
                setPin(event.target.value.replace(/\D/g, ""));
                setError("");
              }}
              placeholder={t("settings.appLockPinPlaceholder", {
                defaultValue: "PIN",
              })}
              disabled={busy}
            />
          ) : (
            <input
              ref={inputRef}
              className="app-lock-input app-lock-input-code"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              maxLength={TOTP_CODE_LENGTH}
              value={code}
              onChange={(event) => {
                setCode(event.target.value.replace(/\D/g, ""));
                setError("");
              }}
              placeholder={t("settings.appLockTotpCodePlaceholder", {
                defaultValue: "6-digit code",
              })}
              disabled={busy}
            />
          )}
          <button
            className="app-lock-submit"
            type="submit"
            disabled={submitDisabled}
          >
            {busy ? (
              <LoaderCircle
                size={14}
                strokeWidth={1.8}
                className="tool-call-icon-spinning"
                aria-hidden="true"
              />
            ) : isPinMode ? (
              <KeyRound size={14} strokeWidth={1.8} aria-hidden="true" />
            ) : (
              <ShieldCheck size={14} strokeWidth={1.8} aria-hidden="true" />
            )}
            <span>
              {isPinMode
                ? t("settings.appLockUnlock", { defaultValue: "Unlock" })
                : t("settings.appLockVerifyTotp", { defaultValue: "Verify" })}
            </span>
          </button>
        </form>

        {cooldownSeconds > 0 ? (
          <span className="app-lock-error">
            {t("settings.appLockCooldown", {
              values: { seconds: cooldownSeconds },
              defaultValue: `Too many attempts. Try again in ${cooldownSeconds}s`,
            })}
          </span>
        ) : error ? (
          <span className="app-lock-error">{error}</span>
        ) : null}

        <button
          className="app-lock-link"
          type="button"
          disabled={busy}
          onClick={() => {
            setMode(isPinMode ? "totp" : "pin");
            setError("");
          }}
        >
          {isPinMode
            ? t("settings.appLockForgotPin", {
                defaultValue: "Forgot the PIN? Use Google Authenticator",
              })
            : t("settings.appLockBackToPin", { defaultValue: "Back to PIN" })}
        </button>

        <span className="app-lock-hint">
          {t("settings.appLockRunningHint", {
            defaultValue:
              "Sessions and enabled features keep running while locked.",
          })}
        </span>
      </div>
    </div>
  );
}
