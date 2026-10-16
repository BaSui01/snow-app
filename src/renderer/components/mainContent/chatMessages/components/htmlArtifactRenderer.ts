const SELECTOR = ".html-artifact-block[data-html-source]";

type ArtifactLabels = {
  code: string;
  preview: string;
  pending: string;
  title: string;
};

/** Removing the browsing context stops scripts; no execution preference is cached. */
export const cleanupHtmlArtifacts = (root: ParentNode): void => {
  root
    .querySelectorAll<HTMLIFrameElement>(".html-artifact-preview iframe")
    .forEach((frame) => frame.remove());
  root.querySelectorAll<HTMLElement>(SELECTOR).forEach((block) => {
    block.dataset.htmlView = "code";
    block
      .querySelector('[data-html-action="code"]')
      ?.setAttribute("aria-pressed", "true");
    block
      .querySelector('[data-html-action="preview"]')
      ?.setAttribute("aria-pressed", "false");
  });
};

/** Prefer completed previews without reloading frames or overriding a user's code view. */
export const syncHtmlArtifacts = (
  root: ParentNode,
  streaming: boolean,
  labels: ArtifactLabels,
  autoPreview = false,
  ready = true,
): void => {
  if (streaming) cleanupHtmlArtifacts(root);
  root.querySelectorAll<HTMLElement>(SELECTOR).forEach((block) => {
    const code = block.querySelector<HTMLButtonElement>(
      '[data-html-action="code"]',
    );
    const preview = block.querySelector<HTMLButtonElement>(
      '[data-html-action="preview"]',
    );
    const pending =
      streaming || !ready || block.dataset.htmlComplete !== "true";
    if (code) code.textContent = labels.code;
    if (preview) {
      preview.textContent = labels.preview;
      preview.disabled = pending;
      preview.title = pending ? labels.pending : labels.title;
    }
    if (autoPreview && !pending && block.dataset.htmlUserView !== "code") {
      setHtmlArtifactView(block, "preview", false, labels.title);
    }
    const frame = block.querySelector<HTMLIFrameElement>(
      ".html-artifact-preview iframe",
    );
    if (frame) frame.title = labels.title;
  });
};

/** Only the isolated carrier receives generated markup, never the host DOM. */
export const setHtmlArtifactView = (
  block: HTMLElement,
  view: "code" | "preview",
  streaming: boolean,
  title: string,
): void => {
  const preview = block.querySelector<HTMLElement>(".html-artifact-preview");
  if (!preview) return;
  if (view === "preview") {
    if (
      streaming ||
      block.dataset.htmlComplete !== "true" ||
      !block.isConnected
    )
      return;
    if (!preview.querySelector("iframe")) {
      let source: string;
      try {
        source = decodeURIComponent(block.dataset.htmlSource ?? "");
      } catch {
        return;
      }
      const frame = document.createElement("iframe");
      frame.className = "html-artifact-frame";
      frame.title = title;
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("referrerpolicy", "no-referrer");
      // A separately loaded document has its own CSP, unlike direct srcdoc/blob.
      frame.src = new URL("./htmlArtifactHost.html", window.location.href).href;
      frame.addEventListener(
        "load",
        () => {
          if (!frame.isConnected) return;
          // The carrier has an opaque sandbox origin: targetOrigin must be '*'.
          // No secrets or host capabilities are sent, and no messages are received.
          frame.contentWindow?.postMessage(
            { type: "snow-html-artifact", source, title },
            "*",
          );
        },
        { once: true },
      );
      preview.appendChild(frame);
    }
  } else {
    preview.replaceChildren();
  }
  block.dataset.htmlView = view;
  block
    .querySelector('[data-html-action="code"]')
    ?.setAttribute("aria-pressed", String(view === "code"));
  block
    .querySelector('[data-html-action="preview"]')
    ?.setAttribute("aria-pressed", String(view === "preview"));
};
