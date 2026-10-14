import { ChevronDown, Loader2, Settings, Undo2, X } from "lucide-react";
import { PromptContextReview } from "./PromptContextReview";
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
import {
  getSessionActionTask,
  subscribeSessionActionTask,
  setSessionActionTask,
  abortSessionActionTask,
} from "../../../plugins/pluginChatInputActionStore";
import type { PluginPanelDefinition, PluginView } from "../../../plugins/types";
import { ContextMenu, type ContextMenuItem } from "../../common/ContextMenu";
import { Modal } from "../../common/Modal";
import { PluginIcon } from "../../common/PluginIcon";
import { Tooltip } from "../../common/Tooltip";
import { rightPanelEvents } from "../../rightPanel/rightPanelEvents";

// Local labels deliberately avoid changing the user's in-flight i18n files.
const LABELS = {
  en: {
    cancel: "Cancel action",
    configure: "Configure",
    openConfiguration: "Open configuration",
    more: "More actions",
    undo: "Undo",
    confirm: "Confirm",
    close: "Close",
    failed: "Action failed",
  },
  "zh-CN": {
    cancel: "取消本次操作",
    configure: "配置",
    openConfiguration: "打开配置",
    more: "更多操作",
    undo: "还原",
    confirm: "确认",
    close: "关闭",
    failed: "操作失败",
  },
  "zh-TW": {
    cancel: "取消本次操作",
    configure: "設定",
    openConfiguration: "開啟設定",
    more: "更多操作",
    undo: "還原",
    confirm: "確認",
    close: "關閉",
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
  sessionKey = "",
  conversationId = null,
  plugin,
  panel,
  disabled,
  parametersKey,
  apiConfigIdentity,
}: {
  sessionKey?: string;
  conversationId?: string | null;
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
  const initialTask = sessionKey ? getSessionActionTask(sessionKey) : undefined;
  const [busy, setBusy] = useState(initialTask?.busy ?? false);
  const [status, setStatus] = useState(initialTask?.status ?? "");
  const [result, setResult] = useState<PluginChatInputActionResult | null>(
    initialTask?.result ?? null,
  );

  useEffect(() => {
    if (!sessionKey) return;
    const sync = () => {
      const task = getSessionActionTask(sessionKey);
      if (task) {
        setBusy((prev) => (prev !== task.busy ? task.busy : prev));
        busyRef.current = task.busy;
        setStatus((prev) => (prev !== task.status ? task.status : prev));
        setResult((prev) => (prev !== task.result ? task.result : prev));
      }
    };
    sync();
    return subscribeSessionActionTask(sessionKey, sync);
  }, [sessionKey]);
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

  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    trigger: HTMLButtonElement;
    identity: typeof identityRef.current;
    contextRevision: number;
  } | null>(null);
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const menuIsCurrent = (): boolean => {
    const current = identityRef.current;
    return (
      !!menu &&
      menuRef.current === menu &&
      mountedRef.current &&
      current.plugin === menu.identity.plugin &&
      current.panel === menu.identity.panel &&
      current.parametersKey === menu.identity.parametersKey &&
      current.apiConfigIdentity === menu.identity.apiConfigIdentity &&
      current.disabled === menu.identity.disabled &&
      current.locale === menu.identity.locale &&
      getPluginDraftContextRevision() === menu.contextRevision &&
      pluginStore.getById(plugin.pluginId) === plugin &&
      plugin.enabled
    );
  };
  const closeMenu = (): void => {
    menuRef.current = null;
    setMenu(null);
  };
  useLayoutEffect(() => {
    menuRef.current = null;
    setMenu(null);
  }, [
    plugin,
    panel,
    parametersKey,
    apiConfigIdentity,
    disabled,
    locale,
    contextRevision,
  ]);
  const openMenu = (
    trigger: HTMLButtonElement,
    x?: number,
    y?: number,
  ): void => {
    if (
      !mountedRef.current ||
      identityRef.current.plugin !== plugin ||
      identityRef.current.panel !== panel ||
      !plugin.enabled ||
      pluginStore.getById(plugin.pluginId) !== plugin
    )
      return;
    const rect = trigger.getBoundingClientRect();
    const next = {
      x: x ?? rect.left,
      y: y ?? rect.bottom,
      trigger,
      identity: identityRef.current,
      contextRevision: getPluginDraftContextRevision(),
    };
    menuRef.current = next;
    setMenu(next);
  };
  const onMenuKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
  ): void => {
    if (
      event.key === "ContextMenu" ||
      (event.shiftKey && event.key === "F10") ||
      (event.altKey && event.key === "ArrowDown")
    ) {
      event.preventDefault();
      event.stopPropagation();
      openMenu(event.currentTarget);
    }
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
      settleConfirmation(false);
    };
  }, [settleConfirmation]);
  useLayoutEffect(() => {
    const hadRun = runRef.current !== null;
    if (hadRun) {
      invalidate();
      setBusy(false);
      setResult((previous) =>
        previous
          ? {
              message: previous.message,
              preview: previous.preview,
              details: previous.details,
            }
          : null,
      );
      setStatus("");
    }
  }, [
    plugin,
    panel,
    parametersKey,
    apiConfigIdentity,
    disabled,
    locale,
    invalidate,
  ]);

  const cancel = (): void => {
    if (sessionKey) {
      abortSessionActionTask(sessionKey);
    }
    invalidate();
    setBusy(false);
    setResult((previous) =>
      previous
        ? {
            message: previous.message,
            preview: previous.preview,
            details: previous.details,
          }
        : null,
    );
    // Cancelling also stays silent: the spinner simply stops.
    setStatus("");
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
    if (sessionKey) {
      setSessionActionTask(sessionKey, { status: message });
    }
    if (
      busyRef.current &&
      run.current() &&
      typeof message === "string" &&
      mountedRef.current
    )
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
    if (next?.details) {
      const details = next.details;
      if (
        typeof details.originalText !== "string" ||
        details.originalText.length > 100000 ||
        (details.warnings !== undefined &&
          (!Array.isArray(details.warnings) ||
            details.warnings.length > 64 ||
            details.warnings.some(
              (w) => typeof w !== "string" || w.length > 2048,
            )))
      )
        throw new Error("Invalid action details");
      const report = details.contextReport;
      if (
        report &&
        (!Array.isArray(report.sources) ||
          report.sources.length > 64 ||
          report.sources.some(
            (source) =>
              !source ||
              typeof source.id !== "string" ||
              typeof source.path !== "string" ||
              source.path.length > 1024 ||
              !Number.isInteger(source.startLine) ||
              source.startLine < 1 ||
              !Number.isInteger(source.endLine) ||
              source.endLine < source.startLine ||
              !["exact", "semantic", "mixed"].includes(source.matchKind) ||
              !["fresh", "unknown"].includes(source.freshness) ||
              !Number.isFinite(source.characters) ||
              source.characters < 0 ||
              typeof source.selected !== "boolean",
          ) ||
          !Array.isArray(report.warnings) ||
          report.warnings.length > 64 ||
          report.warnings.some(
            (w) => typeof w !== "string" || w.length > 2048,
          ) ||
          typeof report.reason !== "string" ||
          report.reason.length > 200 ||
          !["used", "skipped", "degraded", "review_required"].includes(
            report.outcome,
          ) ||
          !["fresh", "stale", "indexing", "unknown", "unavailable"].includes(
            report.indexState,
          ) ||
          !["exact", "semantic", "mixed", "none"].includes(report.queryKind) ||
          !Number.isFinite(report.characters) ||
          report.characters < 0 ||
          !Number.isFinite(report.elapsedMs) ||
          report.elapsedMs < 0 ||
          typeof report.cacheHit !== "boolean" ||
          typeof report.truncated !== "boolean")
      )
        throw new Error("Invalid action context report");
    }
    if (next?.sourceSelection) {
      const selection = next.sourceSelection;
      if (
        !Array.isArray(selection.sources) ||
        selection.sources.length > 64 ||
        !Array.isArray(selection.defaultSelectedIds) ||
        selection.defaultSelectedIds.length > 16 ||
        typeof selection.contextHandle !== "string" ||
        !/^[a-zA-Z0-9_.:-]{1,200}$/.test(selection.contextHandle) ||
        typeof selection.apply !== "function" ||
        selection.sources.some(
          (source) =>
            !source ||
            typeof source.id !== "string" ||
            !/^[a-zA-Z0-9_.:-]{1,200}$/.test(source.id) ||
            typeof source.path !== "string" ||
            source.path.length > 1024 ||
            !Number.isInteger(source.startLine) ||
            source.startLine < 1 ||
            !Number.isInteger(source.endLine) ||
            source.endLine < source.startLine ||
            !["exact", "semantic", "mixed"].includes(source.matchKind) ||
            !["fresh", "unknown"].includes(source.freshness) ||
            !Number.isFinite(source.characters) ||
            source.characters < 0 ||
            typeof source.selected !== "boolean",
        ) ||
        selection.defaultSelectedIds.some(
          (id) =>
            typeof id !== "string" ||
            !selection.sources.some((source) => source.id === id),
        ) ||
        new Set(selection.sources.map((source) => source.id)).size !==
          selection.sources.length
      )
        throw new Error("Invalid action source selection");
    }
    if (sessionKey) {
      setSessionActionTask(sessionKey, {
        busy: false,
        status: next?.message ?? "",
        result: next,
      });
    }
    if (mountedRef.current) {
      setResult(next);
      setStatus(next?.message ?? "");
    }
  };
  const perform = async (
    run: ActionRun,
    operation: () => Promise<PluginChatInputActionResult | null>,
    activate = true,
  ): Promise<void> => {
    run.executing = activate;
    busyRef.current = true;
    if (mountedRef.current) setBusy(true);
    if (sessionKey) {
      setSessionActionTask(sessionKey, { busy: true });
    }
    try {
      check(run);
      finish(run, await operation());
    } catch (error) {
      if (run.current()) {
        const errorMsg = error instanceof Error ? error.message : labels.failed;
        if (sessionKey) {
          setSessionActionTask(sessionKey, {
            busy: false,
            status: errorMsg,
          });
        }
        if (mountedRef.current) {
          setStatus(errorMsg);
          setResult((previous) =>
            previous
              ? {
                  message: previous.message,
                  preview: previous.preview,
                  details: previous.details,
                }
              : null,
          );
        }
      }
    } finally {
      run.executing = false;
      busyRef.current = false;
      if (sessionKey) {
        setSessionActionTask(sessionKey, { busy: false });
      }
      if (mountedRef.current) {
        setBusy(false);
        settleConfirmation(false);
      }
    }
  };
  const start = (menuActionId?: string, fromMenu = false): void => {
    // Menu selections never cancel or preempt an in-flight run.
    if (busyRef.current) {
      if (!fromMenu) cancel();
      return;
    }
    const actionName =
      menuActionId === undefined
        ? panel.chatInputAction
        : panel.chatInputMenuActions?.find((item) => item.id === menuActionId)
            ?.action;
    // Only this parent's normalized declarations can select an export.
    if (
      !mountedRef.current ||
      identityRef.current.plugin !== plugin ||
      identityRef.current.panel !== panel ||
      disabled ||
      !plugin.enabled ||
      pluginStore.getById(plugin.pluginId) !== plugin ||
      plugin.renderMode !== "esm" ||
      !panel.chatInput ||
      !panel.chatInputAction ||
      !actionName
    )
      return;
    invalidate();
    const capturedIdentity = identityRef.current;
    const controller = new AbortController();
    const task = sessionKey
      ? setSessionActionTask(sessionKey, {
          conversationId,
          pluginId: plugin.pluginId,
          panelId: panel.id,
          actionName,
          controller,
          busy: true,
          status: "",
          result: null,
          isAborted: false,
        })
      : null;

    const run: ActionRun = {
      controller,
      executing: false,
      current: () =>
        !controller.signal.aborted &&
        !task?.isAborted &&
        identityRef.current.plugin === capturedIdentity.plugin &&
        identityRef.current.panel === capturedIdentity.panel &&
        pluginStore.getById(plugin.pluginId) === plugin &&
        plugin.enabled,
    };
    runRef.current = run;
    setResult(null);
    // Start silent: the spinner conveys progress. The plugin clears it again on
    // its first `onStatus`, and a slow plugin no longer flashes a truncated label.
    setStatus("");
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
          (message) => confirm(run, message),
          (phase) => {
            const phases: Record<string, readonly [string, string, string]> = {
              planning: [
                "Planning project context",
                "正在规划项目上下文",
                "正在規劃專案上下文",
              ],
              searching: [
                "Searching project sources",
                "正在检索项目来源",
                "正在檢索專案來源",
              ],
              checking: [
                "Checking source freshness",
                "正在核对来源时效",
                "正在核對來源時效",
              ],
              optimizing: [
                "Optimizing prompt",
                "正在优化提示词",
                "正在優化提示詞",
              ],
            };
            const message =
              phases[phase]?.[locale === "en" ? 0 : locale === "zh-CN" ? 1 : 2];
            if (message) onStatus(run, message);
          },
        );
        const module = await loadPluginModule({
          plugin,
          entry: panel.entry || plugin.entry,
          api,
          locale,
          signal: controller.signal,
        });
        check(run);
        const action = resolvePluginChatInputAction(module, actionName);
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
  const restoreDraft = (): void => {
    const task = sessionKey ? getSessionActionTask(sessionKey) : undefined;
    const activeResult = result ?? task?.result ?? null;
    const operation = activeResult?.undo;
    if (!operation || busyRef.current) return;
    let run = runRef.current;
    if (!run) {
      const controller = new AbortController();
      run = {
        controller,
        executing: true,
        current: () => true,
      };
      runRef.current = run;
    }
    void perform(run, async () => {
      check(run);
      await operation();
      // A successful restore drops the single-use result entirely: the menu
      // entry disappears and the toolbar stays silent (no status text).
      if (sessionKey) {
        setSessionActionTask(sessionKey, { result: null, status: "" });
      }
      return null;
    });
  };
  const chooseMenuItem = (operation: () => void, executes = false): void => {
    if (
      !menuIsCurrent() ||
      (executes && (busyRef.current || identityRef.current.disabled))
    )
      return;
    const trigger = menu?.trigger;
    closeMenu();
    // Restore synchronously BEFORE the operation; never after it opens a Modal/panel.
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    operation();
  };
  const menuOpen = menuIsCurrent();
  // The previous diff/preview popovers crowded the input toolbar, so only the
  // dropdown keeps those affordances: restore appears here as a menu item and
  // runs the plugin's undo closure directly.
  const restoreAvailable = !busy && !!result?.undo;
  const menuItems: ContextMenuItem[] = [
    {
      id: "host:default",
      label: title,
      disabled: busy || disabled,
      onClick: () => chooseMenuItem(() => start(undefined, true), true),
    },
    ...(panel.chatInputMenuActions ?? []).map((item): ContextMenuItem => ({
      id: `action:${item.id}`,
      label: resolveLocalized(item.title, locale),
      icon: item.icon ? (
        <PluginIcon pluginId={plugin.pluginId} icon={item.icon} size={14} />
      ) : undefined,
      disabled: busy || disabled,
      onClick: () => chooseMenuItem(() => start(item.id, true), true),
    })),
    ...(restoreAvailable
      ? [
          {
            id: "host:restore",
            label: labels.undo,
            icon: <Undo2 size={14} />,
            separator: true,
            onClick: () => chooseMenuItem(restoreDraft, true),
          } satisfies ContextMenuItem,
        ]
      : []),
    {
      id: "host:configure",
      label: labels.openConfiguration,
      icon: <Settings size={14} />,
      separator: !restoreAvailable,
      onClick: () => chooseMenuItem(openConfiguration),
    },
  ];

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
          aria-disabled={!busy && disabled}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          style={!busy && disabled ? { opacity: 0.5 } : undefined}
          onClick={() => {
            closeMenu();
            start();
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openMenu(event.currentTarget, event.clientX, event.clientY);
          }}
          onKeyDown={onMenuKeyDown}
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
      <Tooltip content={`${labels.more}: ${title}`}>
        <button
          className="toolbar-btn"
          type="button"
          aria-label={`${labels.more}: ${title}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(event) => openMenu(event.currentTarget)}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openMenu(event.currentTarget, event.clientX, event.clientY);
          }}
          onKeyDown={onMenuKeyDown}
        >
          <ChevronDown size={11} />
        </button>
      </Tooltip>
      {menuOpen && menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={closeMenu}
          keyboardNavigation
          returnFocusTo={menu.trigger}
          ariaLabel={`${labels.more}: ${title}`}
        />
      )}
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
      {!busy && result?.sourceSelection && (
        <PromptContextReview
          result={result}
          locale={locale}
          disabled={busy || disabled || !runRef.current?.current()}
          isCurrent={() => !!runRef.current?.current()}
          apply={(ids) => {
            const run = runRef.current;
            const selection = result.sourceSelection;
            if (run && selection && !busyRef.current && run.current())
              void perform(run, async () => {
                check(run);
                return selection.apply(ids);
              });
          }}
        />
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
