import { useEffect, useState } from "react";
import type { MainContentView } from "../mainContent/types";

export const SETTINGS_SEARCH_TARGET_EVENT = "snow:settings-search-target";

export type SettingsSearchTarget = {
  view: MainContentView;
  /** 逐层进入的 tab 按钮文案（外层 → 内层）。 */
  trail: string[];
  /** 需要定位并高亮的条目文案。 */
  label: string;
};

const FLASH_CLASS = "settings-search-flash";
const FLASH_DURATION_MS = 1600;
const POLL_INTERVAL_MS = 100;
const SETTLE_DELAY_MS = 160;
const POLL_TIMEOUT_MS = 3600;
const TAB_SELECTOR = '[role="tab"]';
const TEXT_SELECTOR =
  "span, strong, small, label, div, p, b, em, h3, h4, h5, button, a, li, td, th, legend, code";

export const requestSettingsSearchTarget = (
  target: SettingsSearchTarget,
): void => {
  window.dispatchEvent(
    new CustomEvent<SettingsSearchTarget>(SETTINGS_SEARCH_TARGET_EVENT, {
      detail: target,
    }),
  );
};

const normalize = (value: string): string =>
  value.replace(/\s+/g, " ").trim().toLowerCase();

/** 截掉括号/占位符附加说明，得到用于匹配的文案主干。 */
const coreLabel = (label: string): string => {
  const cutIndex = label.search(/[(（{]/);
  return normalize(cutIndex > 0 ? label.slice(0, cutIndex) : label);
};

const isVisible = (element: HTMLElement): boolean =>
  element.getClientRects().length > 0;

const isTextLeaf = (element: HTMLElement): boolean => {
  for (const child of Array.from(element.children)) {
    if ((child.textContent ?? "").trim()) {
      return false;
    }
  }
  return true;
};

const isPrefixOf = (text: string, core: string): boolean =>
  text.startsWith(`${core} `) ||
  text.startsWith(`${core}(`) ||
  text.startsWith(`${core}（`) ||
  text.startsWith(`${core}:`) ||
  text.startsWith(`${core}：`);

/** tab 按钮常带计数徽标（如「Global 3」），逐个子节点取文案才能精确命中。 */
const textCandidates = (element: HTMLElement): string[] => {
  const candidates = [normalize(element.textContent ?? "")];

  for (const child of Array.from(element.querySelectorAll<HTMLElement>("*"))) {
    if (!isTextLeaf(child)) {
      continue;
    }

    const text = normalize(child.textContent ?? "");

    if (text) {
      candidates.push(text);
    }
  }

  return candidates;
};

const pick = (
  elements: HTMLElement[],
  readTexts: (element: HTMLElement) => string[],
  core: string,
): HTMLElement | null => {
  const hasText = (element: HTMLElement, test: (text: string) => boolean) =>
    readTexts(element).some((text) => test(text));

  return (
    elements.find((element) => hasText(element, (text) => text === core)) ??
    elements.find((element) =>
      hasText(element, (text) => isPrefixOf(text, core)),
    ) ??
    null
  );
};

const findTab = (root: HTMLElement, core: string): HTMLElement | null =>
  pick(
    Array.from(root.querySelectorAll<HTMLElement>(TAB_SELECTOR)).filter(
      isVisible,
    ),
    textCandidates,
    core,
  );

const findText = (root: HTMLElement, core: string): HTMLElement | null =>
  pick(
    Array.from(root.querySelectorAll<HTMLElement>(TEXT_SELECTOR)).filter(
      (element) => isVisible(element) && isTextLeaf(element),
    ),
    (element) => [normalize(element.textContent ?? "")],
    core,
  );

const activateTab = (element: HTMLElement): void => {
  if (element.getAttribute("aria-selected") === "true") {
    return;
  }
  element.click();
};

const highlight = (element: HTMLElement): void => {
  element.scrollIntoView({ block: "center", inline: "nearest" });
  element.classList.add(FLASH_CLASS);
  window.setTimeout(
    () => element.classList.remove(FLASH_CLASS),
    FLASH_DURATION_MS,
  );
};

export const useSettingsSearchTarget = (activeView: MainContentView): void => {
  const [target, setTarget] = useState<SettingsSearchTarget | null>(null);

  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<SettingsSearchTarget>).detail;
      if (detail?.view) {
        setTarget(detail);
      }
    };

    window.addEventListener(SETTINGS_SEARCH_TARGET_EVENT, handler);
    return () =>
      window.removeEventListener(SETTINGS_SEARCH_TARGET_EVENT, handler);
  }, []);

  useEffect(() => {
    if (!target || target.view !== activeView) {
      return undefined;
    }

    const root = document.querySelector<HTMLElement>(".main-content");
    const trail = target.trail.map(coreLabel).filter(Boolean);
    const label = coreLabel(target.label);

    if (!root || (trail.length === 0 && !label)) {
      setTarget(null);
      return undefined;
    }

    let cursor = 0;
    let readyAt = 0;
    let isDone = false;
    let timer = 0;
    const startedAt = Date.now();

    const finish = (): void => {
      isDone = true;
      window.clearInterval(timer);
      setTarget(null);
    };

    const step = (): void => {
      if (cursor < trail.length) {
        const tab = findTab(root, trail[cursor]);

        if (!tab) {
          return;
        }

        activateTab(tab);
        cursor += 1;
        readyAt = Date.now() + SETTLE_DELAY_MS;
        return;
      }

      if (!label) {
        finish();
        return;
      }

      const tab = findTab(root, label);

      if (tab) {
        activateTab(tab);
        highlight(tab);
        finish();
        return;
      }

      const text = findText(root, label);

      if (!text) {
        return;
      }

      highlight(text);
      finish();
    };

    timer = window.setInterval(() => {
      if (isDone || Date.now() < readyAt) {
        return;
      }

      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        finish();
        return;
      }

      step();
    }, POLL_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [target, activeView]);
};
