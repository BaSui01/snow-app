import { useSyncExternalStore } from "react";

export type RepoWikiTarget = {
  directoryId: string;
  path: string;
  name: string;
};

type RepoWikiTargetsSnapshot = {
  current: RepoWikiTarget | null;
  opened: RepoWikiTarget[];
};

export const OPEN_REPO_WIKI_EVENT = "repo-wiki:open-panel";

let snapshot: RepoWikiTargetsSnapshot = { current: null, opened: [] };
const listeners = new Set<() => void>();

const update = (next: RepoWikiTargetsSnapshot): void => {
  snapshot = next;
  for (const listener of listeners) {
    listener();
  }
};

/** 打开（并切换到）某个项目的 Wiki 页面。 */
export const requestOpenRepoWiki = (target: RepoWikiTarget): void => {
  const opened = snapshot.opened.some((item) => item.path === target.path)
    ? snapshot.opened.map((item) => (item.path === target.path ? target : item))
    : [...snapshot.opened, target];
  update({ current: target, opened });
  window.dispatchEvent(new CustomEvent(OPEN_REPO_WIKI_EVENT));
};

export const selectRepoWikiTarget = (path: string): void => {
  const target = snapshot.opened.find((item) => item.path === path);
  if (target) {
    update({ ...snapshot, current: target });
  }
};

/** 页面无目标时静默加入（如直接以当前项目打开），不触发视图切换。 */
export const ensureRepoWikiTarget = (target: RepoWikiTarget): void => {
  if (snapshot.current) {
    return;
  }
  const opened = snapshot.opened.some((item) => item.path === target.path)
    ? snapshot.opened
    : [...snapshot.opened, target];
  update({ current: target, opened });
};

export const closeRepoWikiTarget = (path: string): void => {
  const opened = snapshot.opened.filter((item) => item.path !== path);
  const current =
    snapshot.current?.path === path ? (opened[0] ?? null) : snapshot.current;
  update({ current, opened });
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useRepoWikiTargets = (): RepoWikiTargetsSnapshot =>
  useSyncExternalStore(subscribe, () => snapshot);
