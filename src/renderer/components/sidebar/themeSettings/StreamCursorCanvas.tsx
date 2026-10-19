import { useEffect, useRef, useState } from "react";

/**
 * 运行用户 canvas 脚本的流式光标。
 * 脚本约定：定义 draw(ctx, size, t, dark)；在独立 Worker + OffscreenCanvas 中执行，
 * 无法访问 DOM 与 window.snow。
 */

// 拼接在用户脚本之后；包在 IIFE 里避免与用户顶层变量重名。
const RUNNER_SOURCE = `
;(() => {
  const drawFn = typeof draw === "function" ? draw : self.draw;
  const raf = typeof self.requestAnimationFrame === "function"
    ? self.requestAnimationFrame.bind(self)
    : (cb) => setTimeout(() => cb(performance.now()), 16);
  const caf = typeof self.cancelAnimationFrame === "function"
    ? self.cancelAnimationFrame.bind(self)
    : clearTimeout;
  let canvas = null, ctx = null, size = 14, dpr = 1, dark = false, handle = 0, start = 0;
  const fail = (error) => {
    caf(handle);
    self.postMessage({ type: "error", message: String((error && error.message) || error) });
  };
  const applySize = () => {
    canvas.width = Math.max(1, Math.round(size * dpr));
    canvas.height = Math.max(1, Math.round(size * dpr));
  };
  const frame = (now) => {
    handle = raf(frame);
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawFn(ctx, size, (now - start) / 1000, dark);
    } catch (error) {
      fail(error);
    }
  };
  self.onmessage = (event) => {
    const data = event.data || {};
    if (data.type === "init") {
      if (typeof drawFn !== "function") {
        fail("draw(ctx, size, t, dark) is not defined");
        return;
      }
      canvas = data.canvas;
      ctx = canvas.getContext("2d");
      size = data.size; dpr = data.dpr; dark = data.dark;
      applySize();
      start = performance.now();
      handle = raf(frame);
    } else if (data.type === "resize" && canvas) {
      size = data.size; dpr = data.dpr;
      applySize();
    } else if (data.type === "theme") {
      dark = data.dark;
    }
  };
})();
`;

// 按脚本路径缓存 Blob URL（路径随上传唯一，无需失效）。
const workerUrlCache = new Map<string, Promise<string>>();

const getWorkerUrl = (scriptPath: string): Promise<string> => {
  const cached = workerUrlCache.get(scriptPath);
  if (cached) {
    return cached;
  }
  const pending = window.snow
    .readThemeStreamCursorScript(scriptPath)
    .then((code) =>
      URL.createObjectURL(
        new Blob([code, "\n", RUNNER_SOURCE], { type: "text/javascript" }),
      ),
    );
  workerUrlCache.set(scriptPath, pending);
  pending.catch(() => workerUrlCache.delete(scriptPath));
  return pending;
};

const isDarkTheme = (): boolean =>
  document.documentElement.getAttribute("data-theme") === "dark";

const currentDpr = (): number => Math.min(3, window.devicePixelRatio || 1);

const applyCanvasCssSize = (canvas: HTMLCanvasElement, size: number): void => {
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
};

type StreamCursorCanvasProps = {
  scriptPath: string;
  size: number;
  onError?: (message: string) => void;
};

export function StreamCursorCanvas({
  scriptPath,
  size,
  onError,
}: StreamCursorCanvasProps): React.JSX.Element {
  const hostRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !scriptPath) {
      return;
    }
    let disposed = false;
    let worker: Worker | null = null;
    let observer: MutationObserver | null = null;
    // canvas 命令式创建：transferControlToOffscreen 只能调用一次，避免重挂载报错。
    const canvas = document.createElement("canvas");
    canvas.className = "stream-cursor-canvas-icon";
    applyCanvasCssSize(canvas, sizeRef.current);
    host.appendChild(canvas);
    canvasRef.current = canvas;
    setFailed(false);

    const fail = (message: string): void => {
      if (disposed) {
        return;
      }
      worker?.terminate();
      canvas.remove();
      setFailed(true);
      onErrorRef.current?.(message);
    };

    getWorkerUrl(scriptPath)
      .then((url) => {
        if (disposed) {
          return;
        }
        worker = new Worker(url);
        workerRef.current = worker;
        worker.onerror = (event) => {
          event.preventDefault();
          fail(event.message || "Script error");
        };
        worker.onmessage = (
          event: MessageEvent<{ type?: string; message?: string }>,
        ) => {
          if (event.data?.type === "error") {
            fail(event.data.message ?? "Script error");
          }
        };
        const offscreen = canvas.transferControlToOffscreen();
        worker.postMessage(
          {
            type: "init",
            canvas: offscreen,
            size: sizeRef.current,
            dpr: currentDpr(),
            dark: isDarkTheme(),
          },
          [offscreen],
        );
        observer = new MutationObserver(() => {
          worker?.postMessage({ type: "theme", dark: isDarkTheme() });
        });
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-theme"],
        });
      })
      .catch((error: unknown) => {
        fail(error instanceof Error ? error.message : String(error));
      });

    return () => {
      disposed = true;
      observer?.disconnect();
      worker?.terminate();
      workerRef.current = null;
      canvasRef.current = null;
      canvas.remove();
    };
  }, [scriptPath]);

  useEffect(() => {
    if (canvasRef.current) {
      applyCanvasCssSize(canvasRef.current, size);
    }
    workerRef.current?.postMessage({
      type: "resize",
      size,
      dpr: currentDpr(),
    });
  }, [size]);

  return (
    <span ref={hostRef} className="stream-cursor-canvas-host">
      {failed ? <span className="stream-cursor-dot" /> : null}
    </span>
  );
}
