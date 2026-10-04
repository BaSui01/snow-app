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
  frames: { data: Buffer; timestamp: number }[];
  startedAt: number;
  filePath: string;
  quality: number;
  maxFrames: number;
  maxDurationMs: number;
};

const sessions = new Map<number, ScreencastSession>();

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
  strh.writeUInt32LE(1, 20);
  strh.writeUInt32LE(fps, 24);
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

  const strl = wrapList("strl", Buffer.concat([strh, strf]));
  const hdrl = wrapList("hdrl", Buffer.concat([avih, strl]));

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
    idx1.writeUInt32LE(entry.offset, base + 8);
    idx1.writeUInt32LE(entry.size, base + 12);
  });

  const riff = Buffer.alloc(12);
  writeFourCC(riff, 0, "RIFF");
  riff.writeUInt32LE(4 + hdrl.length + movi.length + idx1.length, 4);
  writeFourCC(riff, 8, "AVI ");

  return Buffer.concat([riff, hdrl, movi, idx1]);
};

const handleScreencastMessage = (
  webContentsId: number,
  method: string,
  params: unknown,
): void => {
  const session = sessions.get(webContentsId);
  if (!session || method !== "Page.screencastFrame") {
    return;
  }
  const frame = params as {
    data?: unknown;
    sessionId?: unknown;
    metadata?: { timestamp?: unknown };
  };
  const target = webContents.fromId(webContentsId);
  if (
    target &&
    !target.isDestroyed() &&
    typeof frame.sessionId === "number" &&
    target.debugger.isAttached()
  ) {
    target.debugger
      .sendCommand("Page.screencastFrameAck", { sessionId: frame.sessionId })
      .catch(() => {});
  }
  if (typeof frame.data === "string") {
    session.frames.push({
      data: Buffer.from(frame.data, "base64"),
      timestamp:
        typeof frame.metadata?.timestamp === "number"
          ? frame.metadata.timestamp
          : Date.now(),
    });
  }
  if (
    session.frames.length >= session.maxFrames ||
    Date.now() - session.startedAt >= session.maxDurationMs
  ) {
    void stopBrowserScreencast(webContentsId).catch(() => {});
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
  },
): Promise<{ started: boolean; file: string; startedAt: string }> => {
  if (sessions.has(webContentsId)) {
    throw new Error(
      "A screencast is already recording for this browser tab; call screencast_stop first",
    );
  }
  const contents = getBrowserWebContents(webContentsId);
  await ensureWebContentsDebugger(contents);
  if (!contents.debugger.isAttached()) {
    throw new Error(
      "Browser debugger is unavailable; close the page DevTools and retry",
    );
  }
  const session: ScreencastSession = {
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
  };
  sessions.set(webContentsId, session);
  try {
    await contents.debugger.sendCommand("Page.startScreencast", {
      format: "jpeg",
      quality: session.quality,
      everyNthFrame: 1,
      ...(options.maxWidth ? { maxWidth: options.maxWidth } : {}),
    });
  } catch (error) {
    sessions.delete(webContentsId);
    throw error;
  }
  return {
    started: true,
    file: session.filePath,
    startedAt: new Date(session.startedAt).toISOString(),
  };
};

export const stopBrowserScreencast = async (
  webContentsId: number,
): Promise<Record<string, unknown>> => {
  const session = sessions.get(webContentsId);
  if (!session) {
    throw new Error("No active screencast; call screencast_start first");
  }
  sessions.delete(webContentsId);
  const contents = webContents.fromId(webContentsId);
  if (contents && !contents.isDestroyed() && contents.debugger.isAttached()) {
    await contents.debugger.sendCommand("Page.stopScreencast").catch(() => {});
  }
  if (session.frames.length === 0) {
    throw new Error("Screencast recorded no frames");
  }
  const size = parseJpegSize(session.frames[0].data) ?? {
    width: 1280,
    height: 720,
  };
  const durationMs = Date.now() - session.startedAt;
  const fps = Math.min(
    Math.max(
      Math.round((session.frames.length / Math.max(durationMs, 1)) * 1000),
      1,
    ),
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
    file: session.filePath,
    frames: session.frames.length,
    durationMs,
    bytes: avi.length,
    fps,
    width: size.width,
    height: size.height,
    format: "MJPEG AVI",
    note: "Playable with VLC, ffmpeg and most desktop players.",
  };
};
