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
  const result = (await contents.debugger.sendCommand(
    "Page.captureScreenshot",
    params,
  )) as { data?: unknown };
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
