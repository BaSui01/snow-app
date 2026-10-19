import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app, webContents } from "electron";
import {
  ensureWebContentsDebugger,
  getBrowserWebContents,
  registerDebuggerMessageListener,
} from "../ipc/handlers/browserNetworkRecorder";

/**
 * 页面录屏：CDP Page.startScreencast 采集 JPEG 帧，停止时合成为 MJPEG AVI
 * （无外部编码依赖，VLC / ffmpeg / 主流播放器可播放）。
 */

type ScreencastSession = {
  recordingId: string;
  notifyStopped: () => void;
  frames: { data: Buffer; timestamp: number }[];
  startedAt: number;
  filePath: string;
  quality: number;
  maxFrames: number;
  maxDurationMs: number;
  maxWidth?: number;
  lastFrameAt: number;
  fallbackFrames: number;
  visible?: boolean;
  captureError?: string;
  durationTimer?: ReturnType<typeof setTimeout>;
  captureTimer?: ReturnType<typeof setInterval>;
  capturing: boolean;
  cleanup: () => void;
};

type ScreencastOutcome = {
  recordingId: string;
  result?: Record<string, unknown>;
  error?: Error;
};
const sessions = new Map<number, ScreencastSession>();
// Preserve automatic stop results (including failures) for a later explicit stop.
const stopResults = new Map<number, Promise<ScreencastOutcome>>();
const stopping = new Set<number>();

const boundedCapture = async <T>(operation: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("Screencast capture command timed out after 5 seconds"),
            ),
          5_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const DEFAULT_MAX_FRAMES = 1200;
const DEFAULT_MAX_DURATION_MS = 120_000;
const DEFAULT_QUALITY = 70;

const defaultRecordingPath = (): string =>
  join(
    app.getPath("userData"),
    "browser-recordings",
    `screencast-${Date.now()}.avi`,
  );

const parseJpegSize = (
  data: Buffer,
): { width: number; height: number } | null => {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = data[offset + 1];
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      const height = data.readUInt16BE(offset + 5);
      const width = data.readUInt16BE(offset + 7);
      return { width, height };
    }
    const length = data.readUInt16BE(offset + 2);
    offset += 2 + length;
  }
  return null;
};

const writeFourCC = (buffer: Buffer, offset: number, text: string): void => {
  buffer.write(text, offset, 4, "latin1");
};

const buildMjpegAvi = (
  frames: Buffer[],
  width: number,
  height: number,
  fps: number,
): Buffer => {
  const chunkParts: Buffer[] = [];
  const indexEntries: { offset: number; size: number }[] = [];
  let moviDataSize = 0;
  let maxFrameSize = 0;
  for (const frame of frames) {
    const header = Buffer.alloc(8);
    writeFourCC(header, 0, "00dc");
    header.writeUInt32LE(frame.length, 4);
    chunkParts.push(header, frame);
    indexEntries.push({ offset: moviDataSize, size: frame.length });
    let chunkSize = 8 + frame.length;
    if (frame.length % 2 === 1) {
      chunkParts.push(Buffer.alloc(1));
      chunkSize += 1;
    }
    moviDataSize += chunkSize;
    maxFrameSize = Math.max(maxFrameSize, frame.length);
  }
  const moviData = Buffer.concat(chunkParts, moviDataSize);

  const avih = Buffer.alloc(56);
  avih.writeUInt32LE(Math.max(1, Math.round(1_000_000 / fps)), 0);
  avih.writeUInt32LE(maxFrameSize * fps, 4);
  avih.writeUInt32LE(0, 8);
  avih.writeUInt32LE(0x10, 12);
  avih.writeUInt32LE(frames.length, 16);
  avih.writeUInt32LE(0, 20);
  avih.writeUInt32LE(1, 24);
  avih.writeUInt32LE(maxFrameSize, 28);
  avih.writeUInt32LE(width, 32);
  avih.writeUInt32LE(height, 36);

  const strh = Buffer.alloc(56);
  writeFourCC(strh, 0, "vids");
  writeFourCC(strh, 4, "MJPG");
  strh.writeUInt32LE(0, 8);
  strh.writeUInt32LE(0, 16);
  strh.writeUInt32LE(1_000_000, 20);
  strh.writeUInt32LE(Math.max(1, Math.round(fps * 1_000_000)), 24);
  strh.writeUInt32LE(0, 28);
  strh.writeUInt32LE(frames.length, 32);
  strh.writeUInt32LE(maxFrameSize, 36);
  strh.writeUInt32LE(0xffffffff, 40);
  strh.writeUInt32LE(0, 44);
  strh.writeUInt16LE(0, 48);
  strh.writeUInt16LE(0, 50);
  strh.writeUInt16LE(width, 52);
  strh.writeUInt16LE(height, 54);

  const strf = Buffer.alloc(40);
  strf.writeUInt32LE(40, 0);
  strf.writeInt32LE(width, 4);
  strf.writeInt32LE(height, 8);
  strf.writeUInt16LE(1, 12);
  strf.writeUInt16LE(24, 14);
  writeFourCC(strf, 16, "MJPG");
  strf.writeUInt32LE(maxFrameSize, 20);
  strf.writeInt32LE(0, 24);
  strf.writeInt32LE(0, 28);
  strf.writeUInt32LE(0, 32);
  strf.writeUInt32LE(0, 36);

  const wrapList = (type: string, payload: Buffer): Buffer => {
    const header = Buffer.alloc(8);
    writeFourCC(header, 0, "LIST");
    header.writeUInt32LE(4 + payload.length, 4);
    const body = Buffer.alloc(4);
    writeFourCC(body, 0, type);
    return Buffer.concat([header, body, payload]);
  };

  const wrapChunk = (type: string, payload: Buffer): Buffer => {
    const header = Buffer.alloc(8);
    writeFourCC(header, 0, type);
    header.writeUInt32LE(payload.length, 4);
    return Buffer.concat([header, payload]);
  };
  const strl = wrapList(
    "strl",
    Buffer.concat([wrapChunk("strh", strh), wrapChunk("strf", strf)]),
  );
  const hdrl = wrapList("hdrl", Buffer.concat([wrapChunk("avih", avih), strl]));

  const moviHeader = Buffer.alloc(8);
  writeFourCC(moviHeader, 0, "LIST");
  moviHeader.writeUInt32LE(4 + moviData.length, 4);
  const moviType = Buffer.alloc(4);
  writeFourCC(moviType, 0, "movi");
  const movi = Buffer.concat([moviHeader, moviType, moviData]);

  const idx1 = Buffer.alloc(8 + indexEntries.length * 16);
  writeFourCC(idx1, 0, "idx1");
  idx1.writeUInt32LE(indexEntries.length * 16, 4);
  indexEntries.forEach((entry, index) => {
    const base = 8 + index * 16;
    writeFourCC(idx1, base, "00dc");
    idx1.writeUInt32LE(0x10, base + 4);
    idx1.writeUInt32LE(entry.offset + 4, base + 8);
    idx1.writeUInt32LE(entry.size, base + 12);
  });

  const riff = Buffer.alloc(12);
  writeFourCC(riff, 0, "RIFF");
  riff.writeUInt32LE(4 + hdrl.length + movi.length + idx1.length, 4);
  writeFourCC(riff, 8, "AVI ");

  return Buffer.concat([riff, hdrl, movi, idx1]);
};

const appendFrame = (
  webContentsId: number,
  session: ScreencastSession,
  data: Buffer,
  fallback = false,
): void => {
  if (sessions.get(webContentsId) !== session) return;
  const size = parseJpegSize(data);
  if (!size || size.width <= 0 || size.height <= 0) {
    session.captureError = "Capture returned an invalid JPEG frame";
    return;
  }
  const firstSize = session.frames[0] && parseJpegSize(session.frames[0].data);
  if (
    firstSize &&
    (firstSize.width !== size.width || firstSize.height !== size.height)
  ) {
    session.captureError =
      "Viewport size changed; mismatched frames were skipped";
    return;
  }
  session.frames.push({ data, timestamp: Date.now() });
  session.lastFrameAt = Date.now();
  if (fallback) session.fallbackFrames++;
  if (session.frames.length >= session.maxFrames)
    void stopBrowserScreencast(webContentsId).catch(() => {});
};

const handleScreencastMessage = (
  webContentsId: number,
  method: string,
  params: unknown,
): void => {
  const session = sessions.get(webContentsId);
  if (!session) return;
  if (method === "Page.screencastVisibilityChanged") {
    session.visible = (params as { visible?: boolean })?.visible;
    return;
  }
  if (method !== "Page.screencastFrame") return;
  const frame = params as { data?: unknown; sessionId?: unknown };
  const target = webContents.fromId(webContentsId);
  if (
    target &&
    !target.isDestroyed() &&
    typeof frame.sessionId === "number" &&
    target.debugger.isAttached()
  ) {
    void boundedCapture(
      target.debugger.sendCommand("Page.screencastFrameAck", {
        sessionId: frame.sessionId,
      }),
    ).catch(() => {});
  }
  if (typeof frame.data === "string")
    appendFrame(webContentsId, session, Buffer.from(frame.data, "base64"));
};

// Static/hidden webviews can produce no Page frame events. Capture only this
// guest's surface (never the desktop), without focus, JS injection or showing it.
const captureFallback = async (
  webContentsId: number,
  session: ScreencastSession,
  contents: Electron.WebContents,
): Promise<void> => {
  if (
    sessions.get(webContentsId) !== session ||
    session.capturing ||
    Date.now() - session.lastFrameAt < 500
  )
    return;
  session.capturing = true;
  try {
    let image = await boundedCapture(
      contents.capturePage(undefined, { stayHidden: true }),
    );
    if (image.isEmpty())
      throw new Error(
        "Target surface is empty (the webview may be display:none)",
      );
    if (session.maxWidth && image.getSize().width > session.maxWidth)
      image = image.resize({ width: session.maxWidth });
    appendFrame(webContentsId, session, image.toJPEG(session.quality), true);
  } catch (error) {
    session.captureError =
      error instanceof Error ? error.message : "Target surface capture failed";
    // Native capture promises cannot be cancelled. Do not accumulate further
    // native requests behind one stalled surface; Page events can still continue.
    if (session.captureError.includes("timed out") && session.captureTimer) {
      clearInterval(session.captureTimer);
    }
  } finally {
    session.capturing = false;
  }
};

registerDebuggerMessageListener(handleScreencastMessage);

export const startBrowserScreencast = async (
  webContentsId: number,
  options: {
    filePath?: string;
    quality?: number;
    maxWidth?: number;
    maxFrames?: number;
    maxDurationMs?: number;
    recordingId?: string;
  },
  onStopped?: (recordingId: string) => void,
): Promise<{
  started: boolean;
  file: string;
  startedAt: string;
  recordingId: string;
}> => {
  const recordingId = options.recordingId ?? randomUUID();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(recordingId))
    throw new Error("Invalid screencast recordingId");
  if (sessions.has(webContentsId) || stopping.has(webContentsId)) {
    throw new Error(
      "A screencast is already recording or stopping for this browser tab",
    );
  }
  const contents = getBrowserWebContents(webContentsId);
  await boundedCapture(ensureWebContentsDebugger(contents));
  // native guest 销毁后 contents.debugger getter 可能抛错，清理须使用活着时的句柄。
  const debuggerSession = contents.debugger;
  if (!debuggerSession.isAttached()) {
    throw new Error(
      "Browser debugger is unavailable; close the page DevTools and retry",
    );
  }
  if (sessions.has(webContentsId) || stopping.has(webContentsId))
    throw new Error("A screencast is already recording or stopping");
  stopResults.delete(webContentsId);
  const autoStop = () => {
    void stopBrowserScreencast(webContentsId).catch(() => {});
  };
  const destroyed = () => {
    autoStop();
    stopResults.delete(webContentsId);
  };
  let notifiedStopped = false;
  const session: ScreencastSession = {
    recordingId,
    notifyStopped: () => {
      if (notifiedStopped) return;
      notifiedStopped = true;
      // 生命周期通知不可覆盖录屏的真实错误（例如宿主窗口已销毁）。
      try {
        onStopped?.(recordingId);
      } catch {}
    },
    frames: [],
    startedAt: Date.now(),
    filePath: options.filePath ?? defaultRecordingPath(),
    quality: Math.min(Math.max(options.quality ?? DEFAULT_QUALITY, 1), 100),
    maxFrames: Math.min(
      Math.max(options.maxFrames ?? DEFAULT_MAX_FRAMES, 1),
      6000,
    ),
    maxDurationMs: Math.min(
      Math.max(options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS, 1000),
      600_000,
    ),
    maxWidth: options.maxWidth,
    lastFrameAt: 0,
    fallbackFrames: 0,
    capturing: false,
    cleanup: () => {
      if (session.durationTimer) clearTimeout(session.durationTimer);
      if (session.captureTimer) clearInterval(session.captureTimer);
      try {
        debuggerSession.removeListener("detach", autoStop);
      } catch {}
      try {
        contents.removeListener("destroyed", destroyed);
      } catch {}
    },
  };
  sessions.set(webContentsId, session);
  contents.once("destroyed", destroyed);
  contents.debugger.once("detach", autoStop);
  try {
    await boundedCapture(
      contents.debugger.sendCommand("Page.startScreencast", {
        format: "jpeg",
        quality: session.quality,
        everyNthFrame: 1,
        ...(options.maxWidth ? { maxWidth: options.maxWidth } : {}),
      }),
    );
    if (contents.isDestroyed() || !contents.debugger.isAttached())
      throw new Error("Browser debugger became unavailable");
    // The independent deadline works even when Page never emits a single frame.
    if (sessions.get(webContentsId) === session) {
      session.durationTimer = setTimeout(
        autoStop,
        Math.max(0, session.maxDurationMs - (Date.now() - session.startedAt)),
      );
      session.captureTimer = setInterval(() => {
        void captureFallback(webContentsId, session, contents);
      }, 250);
      void captureFallback(webContentsId, session, contents);
    }
  } catch (error) {
    session.cleanup();
    if (sessions.get(webContentsId) === session) sessions.delete(webContentsId);
    session.frames.length = 0;
    stopping.add(webContentsId);
    try {
      if (!contents.isDestroyed() && contents.debugger.isAttached()) {
        await boundedCapture(
          contents.debugger.sendCommand("Page.stopScreencast"),
        ).catch(() => {});
      }
    } finally {
      stopping.delete(webContentsId);
      session.notifyStopped();
    }
    throw error;
  }
  return {
    started: true,
    file: session.filePath,
    startedAt: new Date(session.startedAt).toISOString(),
    recordingId,
  };
};

export const stopBrowserScreencast = async (
  webContentsId: number,
  recordingId?: string,
): Promise<Record<string, unknown>> => {
  const session = sessions.get(webContentsId);
  if (recordingId && session && session.recordingId !== recordingId)
    throw new Error(
      "Screencast recordingId no longer matches the active recording",
    );
  let outcomePromise = stopResults.get(webContentsId);
  if (session) {
    sessions.delete(webContentsId);
    stopping.add(webContentsId);
    const durationMs = Math.max(1, Date.now() - session.startedAt);
    outcomePromise = (async (): Promise<ScreencastOutcome> => {
      try {
        // 清理即使意外失败，也必须进入 finally 发送停止通知。
        session.cleanup();
        const contents = webContents.fromId(webContentsId);
        if (
          contents &&
          !contents.isDestroyed() &&
          contents.debugger.isAttached()
        ) {
          await boundedCapture(
            contents.debugger.sendCommand("Page.stopScreencast"),
          ).catch(() => {});
        }
        if (session.frames.length === 0) {
          throw new Error(
            `Screencast recorded no valid frames; Page visible=${session.visible ?? "unknown"}; ${session.captureError ?? "no Page frame events"}. Keep the target tab rendering (activate it or hold capture-render for the recording duration), then retry. No AVI was written.`,
          );
        }
        const size = parseJpegSize(session.frames[0].data);
        if (!size)
          throw new Error(
            "Screencast JPEG dimensions are unavailable; no AVI was written",
          );
        const fps = Math.min(
          Math.max((session.frames.length / durationMs) * 1000, 0.001),
          60,
        );
        const avi = buildMjpegAvi(
          session.frames.map((frame) => frame.data),
          size.width,
          size.height,
          fps,
        );
        await mkdir(dirname(session.filePath), { recursive: true });
        await writeFile(session.filePath, avi);
        return {
          recordingId: session.recordingId,
          result: {
            recordingId: session.recordingId,
            file: session.filePath,
            frames: session.frames.length,
            durationMs,
            bytes: avi.length,
            fps,
            width: size.width,
            height: size.height,
            format: "MJPEG AVI",
            fallbackFrames: session.fallbackFrames,
            pageVisible: session.visible ?? null,
            ...(session.captureError ? { warning: session.captureError } : {}),
            note: "Target-only MJPEG AVI; native surface snapshots fill gaps when Page produces no frames.",
          },
        };
      } catch (error) {
        return {
          recordingId: session.recordingId,
          error:
            error instanceof Error
              ? error
              : new Error("Screencast finalization failed"),
        };
      } finally {
        session.frames.length = 0;
        stopping.delete(webContentsId);
        session.notifyStopped();
      }
    })();
    // Store a fulfilled outcome, not a rejected promise: auto-stop has no caller yet.
    stopResults.set(webContentsId, outcomePromise);
    while (stopResults.size > 100) {
      const oldest = stopResults.keys().next().value;
      if (oldest !== undefined) stopResults.delete(oldest);
    }
  }
  if (!outcomePromise)
    throw new Error("No active screencast; call screencast_start first");
  const outcome = await outcomePromise;
  if (recordingId && outcome.recordingId !== recordingId)
    throw new Error(
      "Screencast recordingId no longer matches the stopped recording",
    );
  if (outcome.error) throw outcome.error;
  return outcome.result!;
};
