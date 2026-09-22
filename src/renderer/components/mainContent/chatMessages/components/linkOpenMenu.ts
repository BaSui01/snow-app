import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExternalLink, PanelRightOpen } from "lucide-react";
import { rightPanelEvents } from "../../../rightPanel/rightPanelEvents";

const ICON_MARKUP = {
  inApp: renderToStaticMarkup(
    createElement(PanelRightOpen, { size: 13, "aria-hidden": true }),
  ),
  external: renderToStaticMarkup(
    createElement(ExternalLink, { size: 13, "aria-hidden": true }),
  ),
};

export const openInAppBrowser = (url: string): void => {
  rightPanelEvents.emit("open-browser-tab", { url });
};

export const openInSystemBrowser = (url: string): void => {
  window.open(url, "_blank");
};

type LinkOpenMenuLabels = {
  inApp: string;
  external: string;
};

export const openLinkOpenMenu = (
  x: number,
  y: number,
  url: string,
  labels: LinkOpenMenuLabels,
): void => {
  document.querySelectorAll(".link-open-menu").forEach((el) => el.remove());

  const menu = document.createElement("div");
  menu.className = "link-open-menu";

  const items: { label: string; icon: string; onSelect: () => void }[] = [
    {
      label: labels.inApp,
      icon: ICON_MARKUP.inApp,
      onSelect: () => openInAppBrowser(url),
    },
    {
      label: labels.external,
      icon: ICON_MARKUP.external,
      onSelect: () => openInSystemBrowser(url),
    },
  ];

  for (const { label, icon, onSelect } of items) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "link-open-menu-item";
    const iconHost = document.createElement("span");
    iconHost.className = "link-open-menu-item-icon";
    iconHost.innerHTML = icon;
    const text = document.createElement("span");
    text.textContent = label;
    item.append(iconHost, text);
    item.addEventListener("click", () => {
      menu.remove();
      onSelect();
    });
    menu.appendChild(item);
  }

  menu.style.position = "fixed";
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);

  const rect = menu.getBoundingClientRect();
  const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const close = (): void => {
    menu.remove();
    document.removeEventListener("mousedown", dismiss, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const dismiss = (e: MouseEvent): void => {
    if (menu.contains(e.target as Node)) {
      return;
    }
    close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      close();
    }
  };

  setTimeout(() => {
    document.addEventListener("mousedown", dismiss, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
};
