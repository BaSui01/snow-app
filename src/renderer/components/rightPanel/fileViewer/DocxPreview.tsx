import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { renderAsync } from "docx-preview";

import type { PreviewUnavailableInfo } from "./PreviewUnavailable";

/** 页面左右留白（px）：页面宽于容器时整体缩放到容器宽度。 */
const PAGE_GUTTER = 24;

/**
 * Shadow DOM 内的基础样式：文档样式与应用样式互不影响。
 * 自定义属性可穿透 shadow 边界，背景跟随应用主题，纸面保持文档原色。
 */
const SHADOW_BASE_CSS = `
:host { display: block; }
.docx-wrapper {
  background: var(--bg-secondary, #f3f3f3) !important;
  padding: 16px 12px 4px !important;
}
.docx-wrapper > section.docx {
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18) !important;
  margin-bottom: 16px !important;
}
`;

type DocxPreviewProps = {
  data: Uint8Array;
  onFailure: (info: Omit<PreviewUnavailableInfo, "size">) => void;
};

/** DOCX 预览：docx-preview 渲染到隔离的 Shadow DOM，禁用 altChunk 与链接跳转。 */
export default function DocxPreview({
  data,
  onFailure,
}: DocxPreviewProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [rendering, setRendering] = useState(true);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const baseStyle = document.createElement("style");
    baseStyle.textContent = SHADOW_BASE_CSS;
    const styleContainer = document.createElement("div");
    const bodyContainer = document.createElement("div");
    shadow.replaceChildren(baseStyle, styleContainer, bodyContainer);

    // 文档内超链接一律不跳转：主窗口导航会离开应用，新窗口会打开外部浏览器。
    const blockLinks = (event: Event): void => {
      const target = event.target;
      if (target instanceof Element && target.closest("a")) {
        event.preventDefault();
      }
    };
    shadow.addEventListener("click", blockLinks);
    shadow.addEventListener("auxclick", blockLinks);

    // 页面宽于容器时等比缩小（CSS zoom 同时影响布局尺寸，不产生横向滚动）。
    const fitWidth = (): void => {
      const wrapper = bodyContainer.querySelector<HTMLElement>(".docx-wrapper");
      const page = wrapper?.querySelector<HTMLElement>("section.docx");
      if (!wrapper || !page) return;
      const pageWidth = page.offsetWidth;
      const available = host.clientWidth - PAGE_GUTTER;
      wrapper.style.zoom =
        pageWidth > 0 && available > 0 && pageWidth > available
          ? String(available / pageWidth)
          : "";
    };
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        fitWidth();
      });
    });

    let cancelled = false;
    setRendering(true);
    renderAsync(data, bodyContainer, styleContainer, {
      inWrapper: true,
      breakPages: true,
      ignoreFonts: true,
      useBase64URL: true,
      renderAltChunks: false,
      renderChanges: false,
      renderComments: false,
      experimental: false,
    })
      .then(() => {
        if (cancelled) return;
        setRendering(false);
        fitWidth();
        observer.observe(host);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        onFailure({
          reason: "parse_failed",
          kind: "docx",
          detail: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
      if (frame !== 0) window.cancelAnimationFrame(frame);
      observer.disconnect();
      shadow.removeEventListener("click", blockLinks);
      shadow.removeEventListener("auxclick", blockLinks);
      shadow.replaceChildren();
    };
  }, [data, onFailure]);

  return (
    <div className="file-preview-docx">
      {rendering ? (
        <div className="file-preview-loading file-preview-docx-loading">
          <Loader2 className="spin" size={18} />
        </div>
      ) : null}
      <div className="file-preview-docx-host" ref={hostRef} />
    </div>
  );
}
