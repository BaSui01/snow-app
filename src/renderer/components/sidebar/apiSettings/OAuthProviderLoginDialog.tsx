import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { Modal } from "../../common/Modal";
import { useI18n } from "../../../i18n";
import type {
  OAuthLoginStart,
  OAuthLoginStatus,
  OAuthProviderInfo,
} from "../../../../preload";
import { oauthProviderLabel } from "./oauthProviderText";

const POLL_INTERVAL_MS = 2000;

type OAuthProviderLoginDialogProps = {
  open: boolean;
  provider: OAuthProviderInfo;
  onBack: () => void;
  onClose: () => void;
  onCompleted: (status: OAuthLoginStatus) => void;
};

type Phase = "idle" | "starting" | "waiting" | "success" | "error";

export function OAuthProviderLoginDialog({
  open,
  provider,
  onBack,
  onClose,
  onCompleted,
}: OAuthProviderLoginDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>("idle");
  const [session, setSession] = useState<OAuthLoginStart | null>(null);
  const [status, setStatus] = useState<OAuthLoginStatus | null>(null);
  const [error, setError] = useState("");
  const [callbackInput, setCallbackInput] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const sessionRef = useRef<OAuthLoginStart | null>(null);

  const reset = useCallback(() => {
    sessionRef.current = null;
    setPhase("idle");
    setSession(null);
    setStatus(null);
    setError("");
    setCallbackInput("");
    setIsSubmitting(false);
    setCopied(false);
  }, []);

  useEffect(() => {
    if (open) {
      return;
    }
    const active = sessionRef.current;
    if (active) {
      void window.snow
        .cancelOAuthLogin(active.sessionId)
        .catch(() => undefined);
    }
    reset();
  }, [open, reset]);

  useEffect(() => {
    if (!open || phase !== "waiting" || !session) {
      return;
    }

    let stopped = false;
    const poll = async (): Promise<void> => {
      try {
        const next = await window.snow.getOAuthLoginStatus(session.sessionId);
        if (stopped || !next) {
          return;
        }
        if (next.status === "success") {
          setStatus(next);
          setPhase("success");
          onCompleted(next);
          return;
        }
        if (next.status === "error") {
          setStatus(next);
          setError(next.error ?? "");
          setPhase("error");
          return;
        }
        if (next.status === "cancelled") {
          setStatus(next);
          setError(
            t("settings.oauthCancelled", {
              defaultValue: "The sign-in session was cancelled.",
            }),
          );
          setPhase("error");
        }
      } catch (pollError) {
        if (!stopped) {
          setError(
            pollError instanceof Error ? pollError.message : String(pollError),
          );
        }
      }
    };

    const timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    void poll();
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [open, phase, session, onCompleted, t]);

  const handleStart = useCallback(async () => {
    setPhase("starting");
    setError("");
    try {
      const started = await window.snow.startOAuthLogin(provider.id);
      sessionRef.current = started;
      setSession(started);
      setPhase("waiting");
      window.open(started.authUrl, "_blank", "noopener,noreferrer");
    } catch (startError) {
      setError(
        startError instanceof Error ? startError.message : String(startError),
      );
      setPhase("error");
    }
  }, [provider.id]);

  const handleCopyLink = useCallback(async () => {
    if (!session) {
      return;
    }
    try {
      await navigator.clipboard.writeText(session.authUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }, [session]);

  const handleOpenBrowser = useCallback(() => {
    if (session) {
      window.open(session.authUrl, "_blank", "noopener,noreferrer");
    }
  }, [session]);

  const handleSubmitCallback = useCallback(async () => {
    if (!session || !callbackInput.trim()) {
      return;
    }
    setIsSubmitting(true);
    setError("");
    try {
      const next = await window.snow.submitOAuthCallback(
        session.sessionId,
        callbackInput.trim(),
      );
      setStatus(next);
      if (next.status === "success") {
        setPhase("success");
        onCompleted(next);
      } else if (next.status === "error") {
        setError(next.error ?? "");
        setPhase("error");
      }
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : String(submitError),
      );
      try {
        const snapshot = await window.snow.getOAuthLoginStatus(
          session.sessionId,
        );
        if (snapshot) {
          setStatus(snapshot);
          if (snapshot.status === "error") {
            setPhase("error");
          }
        }
      } catch {
        // 状态快照失败时保留当前错误提示即可
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [session, callbackInput, onCompleted]);

  const exitTo = useCallback(
    (next: () => void) => {
      const active = sessionRef.current;
      if (active && phase !== "success") {
        void window.snow
          .cancelOAuthLogin(active.sessionId)
          .catch(() => undefined);
      }
      reset();
      next();
    },
    [phase, reset],
  );

  const handleClose = useCallback(() => exitTo(onClose), [exitTo, onClose]);
  const handleBack = useCallback(() => exitTo(onBack), [exitTo, onBack]);

  const isBusy = phase === "starting" || isSubmitting;

  const renderBody = (): React.JSX.Element => {
    if (phase === "idle" || phase === "starting") {
      return (
        <div className="oauth-login-body">
          <p className="oauth-login-hint">
            {t("settings.oauthLoginIntro", {
              defaultValue:
                "A browser window will open for the sign-in. The channel is created and activated automatically once it completes.",
            })}
          </p>
          {phase === "starting" ? (
            <div className="oauth-login-status">
              <Loader2 size={14} className="spin" />
              <span>
                {t("settings.oauthStarting", {
                  defaultValue: "Preparing the sign-in session...",
                })}
              </span>
            </div>
          ) : null}
        </div>
      );
    }

    if (phase === "waiting" && session) {
      return (
        <div className="oauth-login-body">
          <div className="oauth-login-status">
            <Loader2 size={14} className="spin" />
            <span>
              {t("settings.oauthWaiting", {
                defaultValue: "Waiting for the browser sign-in to complete...",
              })}
            </span>
          </div>
          <div className="oauth-login-link">
            <input
              type="text"
              value={session.authUrl}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
            />
            <button
              className="api-settings-action-btn secondary"
              type="button"
              onClick={() => void handleCopyLink()}
              title={t("settings.oauthCopyLink", { defaultValue: "Copy link" })}
            >
              <Copy size={14} />
              <span>
                {copied
                  ? t("settings.oauthCopied", { defaultValue: "Copied" })
                  : t("settings.oauthCopyLink", {
                      defaultValue: "Copy link",
                    })}
              </span>
            </button>
            <button
              className="api-settings-action-btn secondary"
              type="button"
              onClick={handleOpenBrowser}
              title={t("settings.oauthOpenBrowser", {
                defaultValue: "Open in browser",
              })}
            >
              <ExternalLink size={14} />
              <span>
                {t("settings.oauthOpenBrowser", {
                  defaultValue: "Open in browser",
                })}
              </span>
            </button>
          </div>
          <p className="oauth-login-hint">
            {session.manualMode
              ? t("settings.oauthManualNotice", {
                  defaultValue:
                    "The local callback port is unavailable. After signing in, copy the address bar URL from the browser and paste it below.",
                })
              : t("settings.oauthWaitingHint", {
                  defaultValue:
                    "The sign-in completes automatically once the browser flow finishes.",
                })}
          </p>
          <div className="oauth-login-field">
            <label htmlFor="oauth-login-callback">
              {t("settings.oauthCallbackLabel", {
                defaultValue: "Callback URL",
              })}
            </label>
            <div className="oauth-login-link">
              <input
                id="oauth-login-callback"
                type="text"
                value={callbackInput}
                placeholder={t("settings.oauthCallbackPlaceholder", {
                  defaultValue:
                    "Paste the callback URL (or authorization code) from the browser",
                })}
                onChange={(event) => setCallbackInput(event.target.value)}
                disabled={isSubmitting}
              />
              <button
                className="api-settings-action-btn secondary"
                type="button"
                onClick={() => void handleSubmitCallback()}
                disabled={isSubmitting || !callbackInput.trim()}
              >
                {isSubmitting ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <CheckCircle2 size={14} />
                )}
                <span>
                  {t("settings.oauthCallbackSubmit", {
                    defaultValue: "Submit",
                  })}
                </span>
              </button>
            </div>
          </div>
          {error ? <p className="oauth-login-error">{error}</p> : null}
        </div>
      );
    }

    if (phase === "success") {
      const name = status?.displayName || status?.profileName || "OAuth";
      return (
        <div className="oauth-login-body">
          <div className="oauth-login-status success">
            <CheckCircle2 size={16} />
            <span>
              {t("settings.oauthSuccess", {
                defaultValue: "Signed in successfully",
              })}
            </span>
          </div>
          <p className="oauth-login-hint">
            {t("settings.oauthSuccessDetail", {
              defaultValue:
                "The channel {name} was created and activated. It is ready to use right away.",
            }).replace("{name}", name)}
          </p>
          {status?.email ? (
            <p className="oauth-login-hint">
              {t("settings.oauthAccount", { defaultValue: "Account" })}:{" "}
              {status.email}
              {status.planType ? ` (${status.planType})` : ""}
            </p>
          ) : null}
        </div>
      );
    }

    return (
      <div className="oauth-login-body">
        <p className="oauth-login-error">
          {error ||
            t("settings.oauthFailed", {
              defaultValue: "Sign-in failed. Please try again.",
            })}
        </p>
        <p className="oauth-login-hint">
          {t("settings.oauthRetryHint", {
            defaultValue:
              "Start a new sign-in session to retry, or close this dialog.",
          })}
        </p>
      </div>
    );
  };

  const renderFooter = (): React.JSX.Element => {
    if (phase === "success") {
      return (
        <button
          className="api-settings-form-btn primary"
          type="button"
          onClick={handleClose}
        >
          <CheckCircle2 size={15} strokeWidth={1.9} />
          <span>{t("settings.oauthDone", { defaultValue: "Done" })}</span>
        </button>
      );
    }

    if (phase === "waiting") {
      return (
        <button
          className="api-settings-form-btn secondary"
          type="button"
          onClick={handleClose}
          disabled={isSubmitting}
        >
          <span>
            {t("settings.oauthCancel", { defaultValue: "Cancel sign-in" })}
          </span>
        </button>
      );
    }

    if (phase === "error") {
      return (
        <>
          <button
            className="api-settings-form-btn secondary"
            type="button"
            onClick={handleBack}
          >
            <ChevronLeft size={15} strokeWidth={1.9} />
            <span>{t("settings.oauthBack", { defaultValue: "Back" })}</span>
          </button>
          <button
            className="api-settings-form-btn primary"
            type="button"
            onClick={() => void handleStart()}
          >
            <RefreshCw size={15} strokeWidth={1.9} />
            <span>
              {t("settings.oauthRetry", { defaultValue: "Try again" })}
            </span>
          </button>
        </>
      );
    }

    return (
      <>
        <button
          className="api-settings-form-btn secondary"
          type="button"
          onClick={handleBack}
          disabled={isBusy}
        >
          <ChevronLeft size={15} strokeWidth={1.9} />
          <span>{t("settings.oauthBack", { defaultValue: "Back" })}</span>
        </button>
        <button
          className="api-settings-form-btn primary"
          type="button"
          onClick={() => void handleStart()}
          disabled={isBusy}
        >
          {phase === "starting" ? (
            <Loader2 size={15} className="spin" />
          ) : (
            <ExternalLink size={15} strokeWidth={1.9} />
          )}
          <span>
            {t("settings.oauthStart", { defaultValue: "Start sign-in" })}
          </span>
        </button>
      </>
    );
  };

  return (
    <Modal
      open={open}
      title={oauthProviderLabel(t, provider)}
      description={t("settings.oauthLoginDescription", {
        defaultValue:
          "Connect a subscription account as a Snow App LLM channel.",
      })}
      closeLabel={t("settings.close", { defaultValue: "Close" })}
      onClose={handleClose}
      closeDisabled={isBusy}
      className="oauth-login-dialog"
      footer={renderFooter()}
    >
      {renderBody()}
    </Modal>
  );
}
