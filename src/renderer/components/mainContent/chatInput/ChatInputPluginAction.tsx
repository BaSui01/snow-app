import { Copy, Loader2, Settings, Undo2, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useI18n } from "../../../i18n";
import {
  loadPluginMessages,
  resolveLocalized,
} from "../../../plugins/manifest";
import { createPluginApi } from "../../../plugins/pluginApi";
import {
  assertPluginActionActive,
  scopePluginActionApi,
  type PluginChatInputActionResult,
} from "../../../plugins/pluginChatInputAction";
import {
  getPluginDraftContextRevision,
  subscribePluginDraftContext,
} from "../../../plugins/pluginDraft";
import {
  loadLucideIcons,
  loadPluginModule,
  resolvePluginChatInputAction,
} from "../../../plugins/pluginRuntime";
import { pluginStore } from "../../../plugins/pluginStore";
import type { PluginPanelDefinition, PluginView } from "../../../plugins/types";
import { Modal } from "../../common/Modal";
import { PluginIcon } from "../../common/PluginIcon";
import { Tooltip } from "../../common/Tooltip";
import { rightPanelEvents } from "../../rightPanel/rightPanelEvents";

// Local labels deliberately avoid changing the user's in-flight i18n files.
const LABELS = {
  en: {
    cancel: "Cancel action",
    configure: "Configure",
    undo: "Undo",
    apply: "Apply",
    preview: "Preview",
    copy: "Copy",
    copied: "Copied",
    confirm: "Confirm",
    close: "Close",
    running: "Running…",
    cancelled: "Cancelled",
    failed: "Action failed",
  },
  "zh-CN": {
    cancel: "取消本次操作",
    configure: "配置",
    undo: "还原",
    apply: "应用",
    preview: "预览",
    copy: "复制",
    copied: "已复制",
    confirm: "确认",
    close: "关闭",
    running: "执行中…",
    cancelled: "已取消",
    failed: "操作失败",
  },
  "zh-TW": {
    cancel: "取消本次操作",
    configure: "設定",
    undo: "還原",
    apply: "套用",
    preview: "預覽",
    copy: "複製",
    copied: "已複製",
    confirm: "確認",
    close: "關閉",
    running: "執行中…",
    cancelled: "已取消",
    failed: "操作失敗",
  },
};

type ActionRun = {
  controller: AbortController;
  current: () => boolean;
  executing: boolean;
};
type Confirmation = { message: string; resolve: (accepted: boolean) => void };

export const ChatInputPluginAction = ({
  plugin,
  panel,
  disabled,
  parametersKey,
  apiConfigIdentity,
}: {
  plugin: PluginView;
  panel: PluginPanelDefinition;
  disabled: boolean;
  parametersKey: string;
  apiConfigIdentity: unknown;
}): React.JSX.Element => {
  const { locale } = useI18n();
  const labels = LABELS[locale];
  const title =
    resolveLocalized(panel.chatInputTitle ?? {}, locale) ||
    resolveLocalized(panel.title, locale) ||
    panel.id;
  const panelTitle = resolveLocalized(panel.title, locale) || panel.id;
  const { storageRevision = 0 } = useSyncExternalStore(
    pluginStore.subscribe,
    pluginStore.getState,
    pluginStore.getState,
  );
  const [settingsVisibility, setSettingsVisibility] = useState<{
    plugin: PluginView;
    panel: PluginPanelDefinition;
    visible: boolean;
  } | null>(null);
  const showSettings =
    settingsVisibility?.plugin === plugin && settingsVisibility.panel === panel
      ? settingsVisibility.visible
      : (panel.chatInputSettings?.defaultVisible ?? true);
  useEffect(() => {
    let alive = true;
    const contribution = panel.chatInputSettings;
    if (!contribution) return;
    void window.snow
      .getPluginValues(plugin.pluginId)
      .then((values) => {
        let visible = contribution.defaultVisible;
        const raw = values.find(
          (item) => item.key === contribution.storageKey,
        )?.value;
        if (raw !== undefined) {
          try {
            const value: unknown = JSON.parse(raw);
            if (typeof value === "boolean") visible = value;
          } catch {
            /* Invalid private preference falls back to the manifest. */
          }
        }
        if (alive) setSettingsVisibility({ plugin, panel, visible });
      })
      .catch(() => {
        if (alive)
          setSettingsVisibility({
            plugin,
            panel,
            visible: contribution.defaultVisible,
          });
      });
    return () => {
      alive = false;
    };
  }, [plugin, panel, storageRevision]);
  const contextRevision = useSyncExternalStore(
    subscribePluginDraftContext,
    getPluginDraftContextRevision,
    getPluginDraftContextRevision,
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [result, setResult] = useState<PluginChatInputActionResult | null>(
    null,
  );
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const runRef = useRef<ActionRun | null>(null);
  const busyRef = useRef(false);
  const confirmationRef = useRef<Confirmation | null>(null);
  const mountedRef = useRef(false);
  // Render-time identity guards close the gap before effect cleanup runs.
  const identityRef = useRef({
    plugin,
    panel,
    parametersKey,
    apiConfigIdentity,
    disabled,
    locale,
  });
  identityRef.current = {
    plugin,
    panel,
    parametersKey,
    apiConfigIdentity,
    disabled,
    locale,
  };

  const settleConfirmation = useCallback((accepted: boolean): void => {
    const pending = confirmationRef.current;
    confirmationRef.current = null;
    pending?.resolve(accepted);
    if (mountedRef.current) setConfirmation(null);
  }, []);
  const invalidate = useCallback((): void => {
    const previous = runRef.current;
    runRef.current = null;
    previous?.controller.abort();
    busyRef.current = false;
    settleConfirmation(false);
  }, [settleConfirmation]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      invalidate();
    };
  }, [invalidate]);
  useLayoutEffect(() => {
    const hadRun = runRef.current !== null;
    invalidate();
    setBusy(false);
    setResult((previous) =>
      previous
        ? { message: previous.message, preview: previous.preview }
        : null,
    );
    // Context changes keep only the copy-only preview; the toolbar stays free of
    // status sentences, so no stale notice is left behind.
    if (hadRun) setStatus("");
  }, [
    plugin,
    panel,
    parametersKey,
    apiConfigIdentity,
    disabled,
    locale,
    contextRevision,
    invalidate,
  ]);

  const cancel = (): void => {
    invalidate();
    setBusy(false);
    setResult((previous) =>
      previous
        ? { message: previous.message, preview: previous.preview }
        : null,
    );
    setStatus(labels.cancelled);
  };
  const openConfiguration = (): void => {
    rightPanelEvents.emit("open-plugin-panel", {
      pluginId: plugin.pluginId,
      panelId: panel.id,
      title: panelTitle,
    });
  };
  const check = (run: ActionRun): void => {
    assertPluginActionActive(run.controller.signal);
    if (!run.current())
      throw new DOMException("Action context changed", "AbortError");
  };
  const onStatus = (run: ActionRun, message: string): void => {
    if (busyRef.current && run.current() && typeof message === "string")
      setStatus(message);
  };
  const confirm = async (run: ActionRun, message: string): Promise<boolean> => {
    check(run);
    if (!busyRef.current)
      throw new DOMException("Action already finished", "AbortError");
    if (typeof message !== "string")
      throw new Error("Confirmation message must be a string");
    settleConfirmation(false);
    const accepted = await new Promise<boolean>((resolve) => {
      const pending = { message, resolve };
      confirmationRef.current = pending;
      setConfirmation(pending);
    });
    check(run);
    return accepted;
  };
  const finish = (
    run: ActionRun,
    next: PluginChatInputActionResult | null,
  ): void => {
    check(run);
    if (
      next !== null &&
      (!next || typeof next !== "object" || Array.isArray(next))
    ) {
      throw new Error("Plugin action returned an invalid result");
    }
    if (next) {
      if (
        (next.message !== undefined && typeof next.message !== "string") ||
        (next.preview !== undefined && typeof next.preview !== "string") ||
        (next.apply !== undefined && typeof next.apply !== "function") ||
        (next.undo !== undefined && typeof next.undo !== "function")
      ) {
        throw new Error("Plugin action result fields are invalid");
      }
    }
    setResult(next);
    setStatus(next?.message ?? "");
  };
  const perform = async (
    run: ActionRun,
    operation: () => Promise<PluginChatInputActionResult | null>,
    activate = true,
  ): Promise<void> => {
    run.executing = activate;
    busyRef.current = true;
    setBusy(true);
    try {
      check(run);
      finish(run, await operation());
    } catch (error) {
      if (run.current()) {
        setStatus(error instanceof Error ? error.message : labels.failed);
        setResult((previous) =>
          previous
            ? { message: previous.message, preview: previous.preview }
            : null,
        );
      }
    } finally {
      run.executing = false;
      if (runRef.current === run && mountedRef.current) {
        busyRef.current = false;
        setBusy(false);
        settleConfirmation(false);
      }
    }
  };
  const start = (): void => {
    if (busyRef.current) {
      cancel();
      return;
    }
    if (disabled || plugin.renderMode !== "esm" || !panel.chatInputAction)
      return;
    invalidate();
    const capturedIdentity = identityRef.current;
    const capturedContext = getPluginDraftContextRevision();
    const controller = new AbortController();
    const run: ActionRun = {
      controller,
      executing: false,
      current: () =>
        mountedRef.current &&
        runRef.current === run &&
        !controller.signal.aborted &&
        getPluginDraftContextRevision() === capturedContext &&
        identityRef.current.plugin === capturedIdentity.plugin &&
        identityRef.current.panel === capturedIdentity.panel &&
        identityRef.current.parametersKey === capturedIdentity.parametersKey &&
        identityRef.current.apiConfigIdentity ===
          capturedIdentity.apiConfigIdentity &&
        identityRef.current.locale === capturedIdentity.locale &&
        !identityRef.current.disabled &&
        pluginStore.getById(plugin.pluginId) === plugin &&
        plugin.enabled,
    };
    runRef.current = run;
    setResult(null);
    setStatus(labels.running);
    void perform(
      run,
      async () => {
        check(run);
        const messages = await loadPluginMessages(
          plugin,
          locale,
          controller.signal,
        );
        check(run);
        const icons = await loadLucideIcons();
        check(run);
        // Fresh per-click API reads current storage preferences; never reuse panel API.
        const freshApi = await createPluginApi({
          plugin,
          locale,
          messages,
          icons,
          requireFreshStorage: true,
        });
        check(run);
        const api = scopePluginActionApi(
          freshApi,
          controller.signal,
          () => run.executing && run.current() && busyRef.current,
        );
        const module = await loadPluginModule({
          plugin,
          entry: panel.entry || plugin.entry,
          api,
          locale,
          signal: controller.signal,
        });
        check(run);
        const action = resolvePluginChatInputAction(
          module,
          panel.chatInputAction!,
        );
        // Arm the scoped AI/write API only after import and export resolution.
        run.executing = true;
        return action({
          api,
          signal: controller.signal,
          onStatus: (message) => onStatus(run, message),
          confirm: (message) => confirm(run, message),
        });
      },
      false,
    );
  };
  const useResult = (kind: "apply" | "undo"): void => {
    const run = runRef.current;
    const operation = result?.[kind];
    if (!run || !operation || busyRef.current || !run.current()) return;
    void perform(run, async () => {
      check(run);
      if (kind === "apply")
        return await (
          operation as NonNullable<PluginChatInputActionResult["apply"]>
        )();
      await (operation as NonNullable<PluginChatInputActionResult["undo"]>)();
      return { message: labels.undo };
    });
  };
  const copyPreview = async (): Promise<void> => {
    const preview = result?.preview;
    if (typeof preview !== "string") return;
    const capturedIdentity = identityRef.current;
    const capturedContext = getPluginDraftContextRevision();
    const capturedRun = runRef.current;
    const stillCurrent = (): boolean =>
      mountedRef.current &&
      identityRef.current.plugin === capturedIdentity.plugin &&
      identityRef.current.parametersKey === capturedIdentity.parametersKey &&
      getPluginDraftContextRevision() === capturedContext &&
      runRef.current === capturedRun;
    try {
      await navigator.clipboard.writeText(preview);
      if (stillCurrent()) setStatus(labels.copied);
    } catch {
      if (stillCurrent()) setStatus(labels.failed);
    }
  };

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        position: "relative",
      }}
    >
      <Tooltip content={busy ? labels.cancel : title}>
        <button
          className="toolbar-btn"
          type="button"
          aria-label={busy ? labels.cancel : title}
          title={busy ? labels.cancel : title}
          disabled={!busy && disabled}
          onClick={start}
        >
          {busy ? (
            <Loader2 size={15} className="spin" />
          ) : (
            <PluginIcon
              pluginId={plugin.pluginId}
              icon={panel.icon || plugin.icon}
              size={15}
            />
          )}
        </button>
      </Tooltip>
      {showSettings && (
        <Tooltip content={`${labels.configure}: ${panelTitle}`}>
          <button
            className="toolbar-btn"
            type="button"
            aria-label={`${labels.configure}: ${panelTitle}`}
            onClick={openConfiguration}
          >
            <Settings size={13} />
          </button>
        </Tooltip>
      )}
      {status && (
        <span
          role="status"
          aria-live="polite"
          title={status}
          style={
            busy
              ? {
                  // While running, the spinner already conveys progress; the
                  // text stays in the accessibility tree only.
                  position: "absolute",
                  width: 1,
                  height: 1,
                  padding: 0,
                  margin: -1,
                  overflow: "hidden",
                  clipPath: "inset(50%)",
                  whiteSpace: "nowrap",
                  border: 0,
                }
              : {
                  maxWidth: 160,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: 12,
                }
          }
        >
          {status}
        </span>
      )}
      {result?.undo && (
        <button
          className="toolbar-btn"
          type="button"
          disabled={busy || disabled}
          onClick={() => useResult("undo")}
          title={labels.undo}
          style={{ whiteSpace: "nowrap", flex: "0 0 auto" }}
        >
          <Undo2 size={14} />
          {labels.undo}
        </button>
      )}
      {typeof result?.preview === "string" && (
        <details>
          <summary style={{ cursor: "pointer", fontSize: 12 }}>
            {labels.preview}
          </summary>
          <div
            style={{
              position: "absolute",
              bottom: "100%",
              right: 0,
              width: "min(420px, 80vw)",
              padding: 12,
              border: "1px solid currentColor",
              borderRadius: 8,
              background: "var(--bg-secondary, Canvas)",
              color: "var(--text-primary, CanvasText)",
              zIndex: 30,
            }}
          >
            <pre
              style={{
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                maxHeight: 260,
                overflow: "auto",
                fontFamily: "inherit",
              }}
            >
              {result.preview}
            </pre>
            <button
              className="toolbar-btn"
              type="button"
              onClick={() => {
                void copyPreview();
              }}
            >
              <Copy size={14} />
              {labels.copy}
            </button>
            {result.apply && (
              <button
                className="toolbar-btn"
                type="button"
                disabled={busy || disabled}
                onClick={() => useResult("apply")}
              >
                {labels.apply}
              </button>
            )}
          </div>
        </details>
      )}
      {result?.apply && result.preview === undefined && (
        <button
          className="toolbar-btn"
          type="button"
          disabled={busy || disabled}
          onClick={() => useResult("apply")}
        >
          {labels.apply}
        </button>
      )}
      <Modal
        open={confirmation !== null}
        title={title}
        closeLabel={labels.close}
        onClose={() => settleConfirmation(false)}
        closeOnEscape
        footer={
          <>
            <button type="button" className="toolbar-btn" onClick={cancel}>
              <X size={14} />
              {labels.cancel}
            </button>
            <button
              type="button"
              className="toolbar-btn"
              onClick={() => settleConfirmation(true)}
            >
              {labels.confirm}
            </button>
          </>
        }
      >
        <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {confirmation?.message}
        </p>
      </Modal>
    </div>
  );
};
