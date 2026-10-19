const SELECTOR = ".html-artifact-block[data-html-source]";
const ZOOM_SLOT = ".html-artifact-zoom-slot";
/** Only the carrier may apply a scale: a frame's own document owns its layout viewport. */
const ZOOM_MESSAGE = "snowapp-html-artifact-zoom";
const ZOOM_STATE_MESSAGE = "snowapp-html-artifact-zoom-state";
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const DEFAULT_MODE: ZoomMode = "page";
const DEFAULT_FACTOR = 1;
const ZOOM_ACTIONS = ["width", "page", "out", "reset", "in"] as const;

export type ArtifactLabels = {
  code: string;
  preview: string;
  pending: string;
  title: string;
  fitWidth: string;
  fitPage: string;
  zoomIn: string;
  zoomOut: string;
  zoomReset: string;
};

type ZoomMode = "width" | "page" | "manual";
type ZoomAction = (typeof ZOOM_ACTIONS)[number];

/** Localized tooltips are needed by the click handler, so the latest set is remembered. */
const zoomLabels = new WeakMap<HTMLElement, ArtifactLabels>();

const zoomMode = (block: HTMLElement): ZoomMode => {
  const value = block.dataset.htmlZoomMode;
  return value === "width" || value === "manual" ? value : DEFAULT_MODE;
};

const zoomFactor = (block: HTMLElement): number => {
  const value = Number(block.dataset.htmlZoomFactor);
  return Number.isFinite(value) && value >= ZOOM_MIN ? value : DEFAULT_FACTOR;
};

const zoomFrame = (block: HTMLElement): HTMLIFrameElement | null =>
  block.querySelector<HTMLIFrameElement>(".html-artifact-preview iframe");

// A single listener uses weak browsing-context keys, so removed previews need no
// additional lifecycle subscription and cannot retain detached file-card DOM.
const zoomFrames = new WeakMap<Window, HTMLIFrameElement>();
let zoomStateListening = false;

const postZoom = (block: HTMLElement, action?: "in" | "out"): void => {
  zoomFrame(block)?.contentWindow?.postMessage(
    action
      ? { type: ZOOM_MESSAGE, action }
      : {
          type: ZOOM_MESSAGE,
          mode: zoomMode(block),
          factor: zoomFactor(block),
        },
    "*",
  );
};

/** The readout tracks the effective scale; activating it always resets to 100%. */
const renderZoom = (block: HTMLElement, labels: ArtifactLabels): void => {
  const slot = block.querySelector<HTMLElement>(ZOOM_SLOT);
  if (!slot) return;
  const mode = zoomMode(block);
  const factor = zoomFactor(block);
  const states: Record<ZoomAction, [string, string, boolean]> = {
    width: [labels.fitWidth, labels.fitWidth, mode === "width"],
    page: [labels.fitPage, labels.fitPage, mode === "page"],
    out: ["\u2212", labels.zoomOut, false],
    reset: [`${Math.round(factor * 100)}%`, labels.zoomReset, false],
    in: ["+", labels.zoomIn, false],
  };
  const atMin = factor <= ZOOM_MIN;
  const atMax = factor >= ZOOM_MAX;
  for (const action of ZOOM_ACTIONS) {
    const button = slot.querySelector<HTMLButtonElement>(
      `[data-html-zoom-action="${action}"]`,
    );
    if (!button) continue;
    const [text, title, pressed] = states[action];
    button.textContent = text;
    button.title = title;
    button.setAttribute("aria-pressed", String(pressed));
    button.disabled = (action === "out" && atMin) || (action === "in" && atMax);
  }
};

const handleZoomState = (event: MessageEvent<unknown>): void => {
  const frame = event.source && zoomFrames.get(event.source as Window);
  if (!frame?.isConnected) return;
  const block = frame.closest<HTMLElement>(SELECTOR);
  if (!block || zoomFrame(block) !== frame) return;
  const data = event.data;
  if (!data || typeof data !== "object") return;
  const { type, mode, factor } = data as Record<string, unknown>;
  if (
    type !== ZOOM_STATE_MESSAGE ||
    (mode !== "width" && mode !== "page" && mode !== "manual") ||
    typeof factor !== "number" ||
    !Number.isFinite(factor) ||
    factor < ZOOM_MIN ||
    factor > ZOOM_MAX
  )
    return;
  block.dataset.htmlZoomMode = mode;
  block.dataset.htmlZoomFactor = String(factor);
  const labels = zoomLabels.get(block);
  if (labels) renderZoom(block, labels);
};

const handleZoomClick = (event: Event): void => {
  const button = event.currentTarget as HTMLButtonElement;
  const action = button.dataset.htmlZoomAction as ZoomAction | undefined;
  const block = button.closest<HTMLElement>(SELECTOR);
  if (!action || !block) return;
  if (action === "in" || action === "out") {
    postZoom(block, action);
    return;
  }
  if (action === "width" || action === "page") {
    block.dataset.htmlZoomMode = action;
  } else if (action === "reset") {
    block.dataset.htmlZoomMode = "manual";
    block.dataset.htmlZoomFactor = String(DEFAULT_FACTOR);
  } else return;
  const labels = zoomLabels.get(block);
  if (labels) renderZoom(block, labels);
  postZoom(block);
};

/** Builds the zoom controls once per block; later calls only refresh text and state. */
export const syncHtmlArtifactZoom = (
  block: HTMLElement,
  labels: ArtifactLabels,
): void => {
  zoomLabels.set(block, labels);
  const slot = block.querySelector<HTMLElement>(ZOOM_SLOT);
  if (!slot) return;
  if (slot.dataset.htmlZoomReady !== "true") {
    for (const action of ZOOM_ACTIONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.htmlZoomAction = action;
      button.addEventListener("click", handleZoomClick);
      slot.appendChild(button);
    }
    slot.dataset.htmlZoomReady = "true";
  }
  renderZoom(block, labels);
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
    syncHtmlArtifactZoom(block, labels);
    if (preview) {
      preview.textContent = labels.preview;
      preview.disabled = pending;
      preview.title = pending ? labels.pending : labels.title;
    }
    if (autoPreview && !pending && block.dataset.htmlUserView !== "code") {
      setHtmlArtifactView(block, "preview", false, labels);
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
  labels: ArtifactLabels,
): void => {
  const preview = block.querySelector<HTMLElement>(".html-artifact-preview");
  if (!preview) return;
  const title = labels.title;
  syncHtmlArtifactZoom(block, labels);
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
          // No secrets or host capabilities are sent. The only reply accepted by
          // handleZoomState is bounded numeric state from this exact live iframe.
          frame.contentWindow?.postMessage(
            { type: "snow-html-artifact", source, title },
            "*",
          );
          postZoom(block);
        },
        { once: true },
      );
      preview.appendChild(frame);
      if (frame.contentWindow) {
        zoomFrames.set(frame.contentWindow, frame);
        if (!zoomStateListening) {
          window.addEventListener("message", handleZoomState);
          zoomStateListening = true;
        }
      }
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
