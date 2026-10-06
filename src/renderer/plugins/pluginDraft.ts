import {
  readEditableContent,
  replaceDraftText,
  splitDraftText,
} from "../components/mainContent/chatInput/fileTagUtils";

const revisions = new WeakMap<HTMLElement, number>();
/** Called synchronously for every controller write, even A -> B -> A in one render. */
export const markPluginDraftChanged = (element: HTMLElement | null): void => {
  if (element) revisions.set(element, (revisions.get(element) ?? 0) + 1);
};

type DraftHost = {
  element: HTMLElement;
  projectId: string;
  sessionKey: string;
  conversationId: string | null;
  blocked: boolean;
  restoreContent: (content: string) => void;
};

type DraftToken = {
  pluginId: string;
  host: DraftHost;
  revision: number;
  expected: string;
  original: string;
  expiresAt: number;
  kind: "draft" | "restore";
};

let host: DraftHost | null = null;
let contextRevision = 0;
const contextListeners = new Set<() => void>();
export const getPluginDraftContextRevision = (): number => contextRevision;
export const subscribePluginDraftContext = (
  listener: () => void,
): (() => void) => {
  contextListeners.add(listener);
  return () => {
    contextListeners.delete(listener);
  };
};
const notifyContextChanged = (): void => {
  contextRevision += 1;
  for (const listener of contextListeners) listener();
};
const observers = new WeakMap<DraftHost, MutationObserver>();
const revisionOf = (current: DraftHost): number => {
  // Drain records synchronously so even DOM A -> B -> A within one task is stale.
  if (observers.get(current)?.takeRecords().length) {
    markPluginDraftChanged(current.element);
  }
  return revisions.get(current.element) ?? 0;
};
const tokens = new Map<string, DraftToken>();
const TOKEN_LIMIT = 128;
const TOKEN_TTL_MS = 5 * 60 * 1000;

/** Re-register on project/session/busy state changes; no stale snapshot writes. */
export const registerPluginDraftHost = (next: DraftHost): (() => void) => {
  host = next;
  tokens.clear();
  const observer = new MutationObserver((records) => {
    if (records.length) markPluginDraftChanged(next.element);
  });
  observer.observe(next.element, {
    subtree: true,
    childList: true,
    characterData: true,
    // Layout / placeholder attributes are not draft revisions. Controller
    // writes and text/child mutations cover actual editor content changes.
  });
  observers.set(next, observer);
  notifyContextChanged();
  return () => {
    observer.disconnect();
    observers.delete(next);
    if (host === next) {
      host = null;
      tokens.clear();
      notifyContextChanged();
    }
  };
};

const requireHost = (): DraftHost => {
  if (!host || !host.element.isConnected || !host.element.isContentEditable) {
    throw new Error("Chat input is not mounted or available");
  }
  if (host.blocked)
    throw new Error("Chat input is busy (streaming, stopping or compacting)");
  return host;
};

const issue = (value: Omit<DraftToken, "expiresAt">): string => {
  const now = Date.now();
  for (const [key, token] of tokens) {
    if (token.expiresAt <= now) tokens.delete(key);
  }
  while (tokens.size >= TOKEN_LIMIT) tokens.delete(tokens.keys().next().value!);
  const key = crypto.randomUUID();
  tokens.set(key, { ...value, expiresAt: now + TOKEN_TTL_MS });
  return key;
};

const consume = (
  pluginId: string,
  key: unknown,
  kind: DraftToken["kind"],
): DraftToken => {
  if (typeof key !== "string") throw new Error("A draft token is required");
  const token = tokens.get(key);
  // A different plugin cannot consume another plugin's token.
  if (!token || token.pluginId !== pluginId || token.kind !== kind) {
    throw new Error("Draft token is invalid or expired");
  }
  tokens.delete(key);
  const current = requireHost();
  if (
    token.expiresAt <= Date.now() ||
    token.host !== current ||
    token.revision !== revisionOf(current) ||
    token.expected !== readEditableContent(current.element)
  ) {
    throw new Error(
      "Draft changed or input session switched; capture the draft again",
    );
  }
  return token;
};

export const capturePluginDraft = (
  pluginId: string,
): {
  draftToken: string;
  inputText: string;
  text: string;
  conversationId: string | null;
} => {
  const current = requireHost();
  const inputText = readEditableContent(current.element);
  const draftToken = issue({
    pluginId,
    host: current,
    revision: revisionOf(current),
    expected: inputText,
    original: inputText,
    kind: "draft",
  });
  return {
    draftToken,
    inputText,
    text: splitDraftText(inputText).text,
    conversationId: current.conversationId,
  };
};

export const applyPluginDraft = (
  pluginId: string,
  draftToken: unknown,
  text: unknown,
): { restoreToken: string } => {
  if (typeof text !== "string") throw new Error("text must be a string");
  const token = consume(pluginId, draftToken, "draft");
  const content = replaceDraftText(token.original, text);
  token.host.restoreContent(content);
  const restoreToken = issue({
    pluginId,
    host: token.host,
    revision: revisionOf(token.host),
    expected: readEditableContent(token.host.element),
    original: token.original,
    kind: "restore",
  });
  return { restoreToken };
};

export const restorePluginDraft = (
  pluginId: string,
  restoreToken: unknown,
): { restored: true } => {
  const token = consume(pluginId, restoreToken, "restore");
  token.host.restoreContent(token.original);
  return { restored: true };
};
