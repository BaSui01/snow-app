import { tGlobal } from "../../../i18n";
import {
  getBrowserAgentSettings,
  isBrowserAgentUrlAllowed,
  resolveBrowserAgentHost,
} from "./browserAgentSettings";

export type BrowserAgentOrigin = "user" | "agent";

export type BrowserAgentAccess = {
  shared: boolean;
  isolated: boolean;
  origin: BrowserAgentOrigin;
  url: string;
};

export type BrowserAgentShareRequest = {
  instanceId: string;
  url: string;
};

const DEFAULT_SHARE_REQUEST_TIMEOUT_MS = 60_000;

const accessRegistry = new Map<string, BrowserAgentAccess>();
const accessSubscribers = new Set<() => void>();

type PendingShareRequest = {
  resolve: (granted: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};

const pendingShareRequests = new Map<string, PendingShareRequest>();

const notifyAccessSubscribers = (): void => {
  for (const subscriber of accessSubscribers) {
    subscriber();
  }
};

export const subscribeBrowserAgentAccess = (
  subscriber: () => void,
): (() => void) => {
  accessSubscribers.add(subscriber);
  return () => {
    accessSubscribers.delete(subscriber);
  };
};

export const registerBrowserAgentAccess = (
  instanceId: string,
  access: Partial<BrowserAgentAccess>,
): void => {
  const existing = accessRegistry.get(instanceId);
  accessRegistry.set(instanceId, {
    shared: access.shared ?? existing?.shared ?? false,
    isolated: access.isolated ?? existing?.isolated ?? false,
    origin: access.origin ?? existing?.origin ?? "user",
    url: access.url ?? existing?.url ?? "",
  });
  notifyAccessSubscribers();
};

export const unregisterBrowserAgentAccess = (instanceId: string): void => {
  const removed = accessRegistry.delete(instanceId);
  const pending = pendingShareRequests.get(instanceId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingShareRequests.delete(instanceId);
    pending.resolve(false);
  }
  if (removed || pending) {
    notifyAccessSubscribers();
  }
};

export const getBrowserAgentAccess = (
  instanceId: string,
): BrowserAgentAccess | null => accessRegistry.get(instanceId) ?? null;

export const listBrowserAgentAccess = (): Array<
  BrowserAgentAccess & { instanceId: string }
> =>
  [...accessRegistry.entries()].map(([instanceId, access]) => ({
    instanceId,
    ...access,
  }));

export const setBrowserTabShared = (
  instanceId: string,
  shared: boolean,
): void => {
  const access = accessRegistry.get(instanceId);
  if (!access || access.shared === shared) {
    return;
  }
  accessRegistry.set(instanceId, { ...access, shared });
  notifyAccessSubscribers();
};

export const updateBrowserAgentAccessUrl = (
  instanceId: string,
  url: string,
): void => {
  const access = accessRegistry.get(instanceId);
  if (!access || access.url === url) {
    return;
  }
  accessRegistry.set(instanceId, { ...access, url });
  notifyAccessSubscribers();
};

export const getPendingBrowserAgentShareRequest = (
  instanceId: string,
): BrowserAgentShareRequest | null => {
  const pending = pendingShareRequests.get(instanceId);
  const access = accessRegistry.get(instanceId);
  if (!pending || !access) {
    return null;
  }
  return { instanceId, url: access.url };
};

export const hasPendingBrowserAgentShareRequest = (): boolean =>
  pendingShareRequests.size > 0;

export const resolveBrowserAgentShareRequest = (
  instanceId: string,
  granted: boolean,
): void => {
  const pending = pendingShareRequests.get(instanceId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingShareRequests.delete(instanceId);
  if (granted) {
    setBrowserTabShared(instanceId, true);
  } else {
    notifyAccessSubscribers();
  }
  pending.resolve(granted);
};

export const requestBrowserAgentShare = (
  instanceId: string,
  timeoutMs = DEFAULT_SHARE_REQUEST_TIMEOUT_MS,
): Promise<boolean> => {
  const access = accessRegistry.get(instanceId);
  if (!access) {
    return Promise.resolve(false);
  }
  if (access.shared) {
    return Promise.resolve(true);
  }
  if (pendingShareRequests.has(instanceId)) {
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pendingShareRequests.delete(instanceId);
      notifyAccessSubscribers();
      resolve(false);
    }, timeoutMs);
    pendingShareRequests.set(instanceId, { resolve, timer });
    notifyAccessSubscribers();
  });
};

const agentAccessDisabledError = (): Error =>
  new Error(
    tGlobal("browser.agentAccessDisabled", {
      defaultValue:
        "Browser access for the agent is turned off (Settings > Browser > Agent access)",
    }),
  );

export const ensureBrowserAgentEnabled = (): void => {
  if (!getBrowserAgentSettings().enabled) {
    throw agentAccessDisabledError();
  }
};

export const ensureBrowserAgentCreationAllowed = (url?: string): void => {
  const settings = getBrowserAgentSettings();
  if (!settings.enabled) {
    throw agentAccessDisabledError();
  }
  if (url && !isBrowserAgentUrlAllowed(url, settings)) {
    throw new Error(
      tGlobal("browser.agentDomainBlocked", {
        values: { host: resolveBrowserAgentHost(url) || url },
        defaultValue: "The agent is not allowed to open {{host}}",
      }),
    );
  }
};

export const ensureBrowserAgentAccess = (
  instanceId: string,
  targetUrl?: string,
): BrowserAgentAccess => {
  const settings = getBrowserAgentSettings();
  if (!settings.enabled) {
    throw agentAccessDisabledError();
  }
  const access = accessRegistry.get(instanceId);
  if (!access) {
    throw new Error(
      tGlobal("browser.agentInstanceMissing", {
        values: { instanceId },
        defaultValue: "Browser tab was not found: {{instanceId}}",
      }),
    );
  }
  if (!access.shared) {
    throw new Error(
      tGlobal("browser.agentTabNotShared", {
        values: { instanceId },
        defaultValue:
          'Tab {{instanceId}} is not shared with the agent. Ask the user to share it (browser-request_share) or click "Share with agent" on the tab.',
      }),
    );
  }
  const url = targetUrl?.trim() || access.url;
  if (!isBrowserAgentUrlAllowed(url, settings)) {
    throw new Error(
      tGlobal("browser.agentDomainBlocked", {
        values: { host: resolveBrowserAgentHost(url) || url },
        defaultValue: "The agent is not allowed to open {{host}}",
      }),
    );
  }
  return access;
};
