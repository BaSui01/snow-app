import type { WebContents } from "electron";
import {
  redactBrowserText,
  redactBrowserUrl,
} from "../../shared/browserRedaction";

type PendingDialog = {
  type: string;
  message: string;
  url: string;
  defaultPrompt: string;
  openedAt: string;
  timer: ReturnType<typeof setTimeout>;
  responding: boolean;
};
const pendingDialogs = new Map<number, PendingDialog>();
const DIALOG_TIMEOUT_MS = 60_000;

export const clearBrowserDialogs = (webContentsId: number): void => {
  const pending = pendingDialogs.get(webContentsId);
  if (pending) clearTimeout(pending.timer);
  pendingDialogs.delete(webContentsId);
};

// Called by the existing shared debugger listener, never attach another session.
export const handleBrowserDialogMessage = (
  contents: WebContents,
  method: string,
  params: unknown,
): void => {
  if (method === "Page.javascriptDialogClosed") {
    clearBrowserDialogs(contents.id);
    return;
  }
  if (method !== "Page.javascriptDialogOpening") return;
  const raw = (params ?? {}) as Record<string, unknown>;
  clearBrowserDialogs(contents.id);
  const pending: PendingDialog = {
    type: typeof raw.type === "string" ? raw.type : "unknown",
    message:
      typeof raw.message === "string" ? redactBrowserText(raw.message) : "",
    url: typeof raw.url === "string" ? redactBrowserUrl(raw.url) : "",
    defaultPrompt:
      typeof raw.defaultPrompt === "string"
        ? redactBrowserText(raw.defaultPrompt)
        : "",
    openedAt: new Date().toISOString(),
    responding: false,
    // Keep a bounded response window; abandoned dialogs must not freeze the tab forever.
    timer: setTimeout(() => {
      if (pendingDialogs.get(contents.id) !== pending) return;
      clearBrowserDialogs(contents.id);
      if (!contents.isDestroyed() && contents.debugger.isAttached()) {
        void contents.debugger
          .sendCommand("Page.handleJavaScriptDialog", { accept: false })
          .catch(() => {});
      }
    }, DIALOG_TIMEOUT_MS),
  };
  pendingDialogs.set(contents.id, pending);
};

export const listBrowserDialogs = (
  webContentsId: number,
): Record<string, unknown>[] => {
  const pending = pendingDialogs.get(webContentsId);
  if (!pending) return [];
  const { timer: _timer, responding: _responding, ...dialog } = pending;
  return [{ ...dialog, expiresAfterMs: DIALOG_TIMEOUT_MS }];
};

export const respondBrowserDialog = async (
  contents: WebContents,
  accept: boolean,
  promptText?: string,
): Promise<{ responded: boolean; remaining: number; error?: string }> => {
  const pending = pendingDialogs.get(contents.id);
  if (!pending)
    return {
      responded: false,
      remaining: 0,
      error: "No pending JavaScript dialog",
    };
  if (pending.responding)
    throw new Error("JavaScript dialog response is already in progress");
  pending.responding = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      contents.debugger.sendCommand("Page.handleJavaScriptDialog", {
        accept,
        ...(promptText !== undefined ? { promptText } : {}),
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("JavaScript dialog response timed out")),
          5_000,
        );
      }),
    ]);
    if (pendingDialogs.get(contents.id) === pending)
      clearBrowserDialogs(contents.id);
    return {
      responded: true,
      remaining: pendingDialogs.has(contents.id) ? 1 : 0,
    };
  } finally {
    if (timer) clearTimeout(timer);
    pending.responding = false;
  }
};
