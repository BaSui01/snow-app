import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ensureWebContentsDebugger,
  getBrowserWebContents,
} from "../ipc/handlers/browserNetworkRecorder";

export type BrowserScreenshotFormat = "png" | "jpeg" | "webp";

export type BrowserScreenshotRequest = {
  format: BrowserScreenshotFormat;
  quality?: number;
  fullPage: boolean;
  clip?: {
    x: number;
    y: number;
    width: number;
    height: number;
    scale?: number;
  };
  filePath?: string;
  /** 后台 tab 临时切入渲染态后，先等页面真正产帧再截图。 */
  waitForFrame?: boolean;
};

export type BrowserScreenshotResult = {
  mimeType: string;
  bytes: number;
  savedTo: string | null;
  data?: string;
};

const MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024;

const MIME_TYPES: Record<BrowserScreenshotFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

// 页面不产帧（webview 被隐藏、窗口被遮挡等）时 Page.captureScreenshot 会一直挂起。
// 视口截图单次超时先等 1.5s 就重试，避免整次截图卡住十几秒；整页/元素裁剪
// 需要 rasterize 整片内容，给足首轮时间，避免把正常的慢截图判成挂起。
const CROP_TIMEOUT_STEPS_MS = [4_000, 8_000];
const VIEWPORT_TIMEOUT_STEPS_MS = [1_500, 2_500];
const CAPTURE_RETRY_DELAY_MS = 150;
// 后台 tab 切回渲染态后合成器要过一会儿才产帧：用页面 rAF 作为产帧就绪信号，
// 就绪即截图，不再盲等固定时长。
const FRAME_PROBE_TIMEOUT_MS = 1_200;
const FRAME_PROBE_EXPRESSION =
  "new Promise((resolve) => requestAnimationFrame(() => resolve(true)))";

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const isTimeoutError = (error: unknown): boolean =>
  error instanceof Error && error.message.includes("timed out");

/** 页面能跑 rAF 说明合成器已在产帧；超时返回 false，交给截图重试兜底。 */
const waitForPageFrame = async (
  contents: Electron.WebContents,
  timeoutMs: number,
): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const probe = contents.debugger
    .sendCommand("Runtime.evaluate", {
      expression: FRAME_PROBE_EXPRESSION,
      awaitPromise: true,
      returnByValue: true,
    })
    .then(() => true)
    .catch(() => false);
  try {
    return await Promise.race([
      probe,
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const captureOnce = async (
  contents: Electron.WebContents,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ data?: unknown }> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return (await Promise.race([
      contents.debugger.sendCommand("Page.captureScreenshot", params),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `Browser screenshot timed out after ${timeoutMs}ms: the page produced no frame (the tab may not be rendering)`,
            ),
          );
        }, timeoutMs);
      }),
    ])) as { data?: unknown };
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
};

/** 超时视为「暂未产帧」重试；其他错误立即抛出。 */
const captureWithRetry = async (
  contents: Electron.WebContents,
  params: Record<string, unknown>,
  timeouts: readonly number[],
): Promise<{ data?: unknown }> => {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < timeouts.length; attempt += 1) {
    try {
      return await captureOnce(contents, params, timeouts[attempt]);
    } catch (error) {
      lastError = error;
      if (!isTimeoutError(error) || attempt === timeouts.length - 1) {
        break;
      }
      // 已超时：确认页面是否恢复产帧；完全不产帧就别再耗后续长超时。
      if (!(await waitForPageFrame(contents, FRAME_PROBE_TIMEOUT_MS))) {
        throw new Error(
          "Browser screenshot timed out: the tab produced no frame (the window may be hidden, minimized or occluded) - bring it to the front and retry",
        );
      }
      await delay(CAPTURE_RETRY_DELAY_MS);
    }
  }
  if (!isTimeoutError(lastError)) {
    throw lastError instanceof Error
      ? lastError
      : new Error("Browser screenshot failed");
  }
  const message =
    lastError instanceof Error && lastError.message
      ? lastError.message
      : "Browser screenshot failed";
  throw new Error(
    `${message}; the window may be hidden, minimized or occluded - bring it to the front and retry`,
  );
};

export const captureBrowserScreenshot = async (
  webContentsId: number,
  request: BrowserScreenshotRequest,
): Promise<BrowserScreenshotResult> => {
  const contents = getBrowserWebContents(webContentsId);
  await ensureWebContentsDebugger(contents);
  if (!contents.debugger.isAttached()) {
    throw new Error(
      "Browser debugger is unavailable; close the page DevTools and retry",
    );
  }
  const params: Record<string, unknown> = { format: request.format };
  if (request.quality !== undefined && request.format !== "png") {
    params.quality = request.quality;
  }
  if (request.fullPage || request.clip) {
    params.captureBeyondViewport = true;
  }
  if (request.clip) {
    params.clip = {
      x: request.clip.x,
      y: request.clip.y,
      width: request.clip.width,
      height: request.clip.height,
      scale: request.clip.scale ?? 1,
    };
  }
  if (request.waitForFrame) {
    // 后台 tab 刚切进渲染态：先等首帧再截图，命中即拍，避免长超时挂起。
    await waitForPageFrame(contents, FRAME_PROBE_TIMEOUT_MS);
  }
  const result = await captureWithRetry(
    contents,
    params,
    request.fullPage || request.clip
      ? CROP_TIMEOUT_STEPS_MS
      : VIEWPORT_TIMEOUT_STEPS_MS,
  );
  if (typeof result.data !== "string" || result.data.length === 0) {
    throw new Error("Browser screenshot did not return image data");
  }
  const buffer = Buffer.from(result.data, "base64");
  if (request.filePath) {
    await mkdir(dirname(request.filePath), { recursive: true });
    await writeFile(request.filePath, buffer);
    return {
      mimeType: MIME_TYPES[request.format],
      bytes: buffer.byteLength,
      savedTo: request.filePath,
    };
  }
  if (buffer.byteLength > MAX_SCREENSHOT_BYTES) {
    throw new Error(
      `Browser screenshot is too large to return inline (${buffer.byteLength} bytes, maximum ${MAX_SCREENSHOT_BYTES}); pass filePath to save it to a file instead`,
    );
  }
  return {
    mimeType: MIME_TYPES[request.format],
    bytes: buffer.byteLength,
    savedTo: null,
    data: result.data,
  };
};
