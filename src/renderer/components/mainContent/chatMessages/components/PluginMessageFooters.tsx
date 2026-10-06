import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { Locale } from "../../../../../shared/locale";
import { useI18n } from "../../../../i18n";
import { loadPluginMessages } from "../../../../plugins/manifest";
import { createPluginApi } from "../../../../plugins/pluginApi";
import {
  scopePluginMessageFooterApi,
  type PluginMessageFooterContext,
  type PluginMessageFooterMount,
} from "../../../../plugins/pluginMessageFooter";
import {
  injectPluginStyles,
  loadLucideIcons,
  loadPluginModule,
} from "../../../../plugins/pluginRuntime";
import { pluginStore, usePluginStore } from "../../../../plugins/pluginStore";
import type {
  PluginMessageFooterDefinition,
  PluginView,
} from "../../../../plugins/types";
import { useChatConversationContext } from "./ChatConversationContext";

const PluginMessageFooter = ({
  plugin,
  footer,
  locale,
  identity,
  identityRef,
  conversationId,
  messageId,
  directoryId,
}: {
  plugin: PluginView;
  footer: PluginMessageFooterDefinition;
  locale: Locale;
  identity: string;
  identityRef: RefObject<string | null>;
  conversationId: string;
  messageId: string;
  directoryId: string | undefined;
}): React.JSX.Element => {
  const hostRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const controller = new AbortController();
    const { signal } = controller;
    const container = document.createElement("div");
    container.dataset.pluginMessageFooter = footer.id;
    let cleanup: (() => void) | undefined;
    let removeStyles: (() => void) | undefined;
    let disposed = false;
    const isCurrent = (): boolean =>
      !disposed &&
      identityRef.current === identity &&
      pluginStore.getById(plugin.pluginId) === plugin &&
      plugin.enabled &&
      plugin.renderMode === "esm" &&
      plugin.messageFooters.includes(footer);
    const check = (): void => {
      if (!isCurrent() || signal.aborted)
        throw new DOMException("Footer context expired", "AbortError");
    };
    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      controller.abort();
      try {
        cleanup?.();
      } catch {
        console.warn("Plugin footer cleanup failed");
      } finally {
        try {
          removeStyles?.();
        } finally {
          container.replaceChildren();
          container.remove();
        }
      }
    };
    // Invalidate immediately on record replacement; do not wait for React effects.
    const unsubscribeStore = pluginStore.subscribe(() => {
      if (!isCurrent()) dispose();
    });
    const context: PluginMessageFooterContext = Object.freeze({
      slot: "message-footer",
      conversationId,
      messageId,
      directoryId,
    });
    void (async () => {
      try {
        check();
        const messages = await loadPluginMessages(plugin, locale, signal);
        check();
        const icons = await loadLucideIcons();
        check();
        const sourceApi = await createPluginApi({
          plugin,
          locale,
          messages,
          icons,
        });
        check();
        const api = scopePluginMessageFooterApi(
          sourceApi,
          context,
          signal,
          isCurrent,
        );
        const module = await loadPluginModule({
          plugin,
          entry: footer.entry,
          api,
          locale,
          signal,
          isCurrent,
        });
        check();
        const styles = await injectPluginStyles(plugin, signal, isCurrent);
        // A late style result is still owned and must be released before throwing.
        removeStyles = styles;
        if (disposed) styles();
        check();
        const mount = module[footer.exportName];
        if (typeof mount !== "function")
          throw new Error("Missing footer mount export");
        host.appendChild(container);
        const result = (mount as PluginMessageFooterMount)(
          container,
          api,
          context,
          signal,
        );
        cleanup =
          typeof result === "function" ? result : result?.unmount?.bind(result);
        // A mount may synchronously change the store and invalidate itself.
        if (disposed) {
          try {
            cleanup?.();
          } finally {
            container.replaceChildren();
            container.remove();
          }
        }
        check();
      } catch {
        if (!signal.aborted && isCurrent())
          console.warn(
            "Plugin message footer failed",
            plugin.pluginId,
            footer.id,
          );
        dispose();
      }
    })();
    return () => {
      unsubscribeStore();
      dispose();
    };
  }, [
    plugin,
    footer,
    locale,
    identity,
    identityRef,
    conversationId,
    messageId,
    directoryId,
  ]);
  return <div ref={hostRef} style={{ display: "contents" }} />;
};

/** A formal, business-neutral slot for the latest completed assistant reply. */
export const PluginMessageFooters = ({
  conversationId,
  messageId,
}: {
  conversationId: string;
  messageId: string;
}): React.JSX.Element | null => {
  const conversation = useChatConversationContext();
  const { locale } = useI18n();
  const { plugins } = usePluginStore();
  const identityRef = useRef<string | null>(null);
  useEffect(() => {
    void pluginStore.ensureLoaded();
  }, []);
  const lastMessage = conversation.messages.findLast(
    (message) => message.role !== "tool",
  );
  const eligible =
    conversation.activeConversationId === conversationId &&
    !conversation.isStreaming &&
    !conversation.isPaused &&
    !conversation.isAborting &&
    lastMessage?.role === "assistant" &&
    lastMessage.id === messageId &&
    lastMessage.status !== "sending";
  const directoryId = conversation.conversationDirectoryId;
  const identity = JSON.stringify([
    conversationId,
    messageId,
    directoryId,
    conversation.streamStartedAt,
    locale,
  ]);
  identityRef.current = eligible ? identity : null;
  if (!eligible) return null;
  const enabled = plugins.filter(
    (plugin) =>
      plugin.enabled &&
      plugin.renderMode === "esm" &&
      plugin.messageFooters.length > 0,
  );
  if (!enabled.length) return null;
  return (
    <>
      {enabled.flatMap((plugin) =>
        plugin.messageFooters.map((footer) => (
          <PluginMessageFooter
            key={`${plugin.pluginId}:${footer.id}`}
            plugin={plugin}
            footer={footer}
            locale={locale}
            identity={identity}
            identityRef={identityRef}
            conversationId={conversationId}
            messageId={messageId}
            directoryId={directoryId}
          />
        )),
      )}
    </>
  );
};
