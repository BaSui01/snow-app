import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage } from "node:http";
import type { NativeBridge } from "../native/types";

export const MAX_REMOTE_ATTACHMENTS = 4;
export const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_REMOTE_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_REMOTE_PENDING_BYTES = 40 * 1024 * 1024;

const MAX_IMAGE_PIXELS = 32_000_000;
const MAX_NAME_LENGTH = 180;
const ABANDONED_UPLOAD_TTL_MS = 60 * 60 * 1000;
const IMAGE_MIMES = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
]);

export type RemoteAttachmentContext = {
  directoryId: string | null;
  conversationId: string | null;
};

export type RemoteAttachmentSummary = {
  id: string;
  kind: "image" | "file";
  name: string;
  mimeType: string;
  size: number;
};

export type ResolvedRemoteAttachment = RemoteAttachmentSummary & {
  dataUrl?: string;
  path?: string;
};

type StoredRemoteAttachment = RemoteAttachmentSummary & {
  absolutePath: string;
  context: RemoteAttachmentContext;
  generation: number;
  createdAt: number;
  consumed: boolean;
};

const uploads = new Map<string, StoredRemoteAttachment>();
let inFlightBytes = 0;
let inFlightAttachmentCount = 0;

const sameContext = (
  left: RemoteAttachmentContext,
  right: RemoteAttachmentContext,
): boolean =>
  left.directoryId === right.directoryId &&
  left.conversationId === right.conversationId;

const safeName = (raw: string): string => {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Use the original header when percent-decoding fails.
  }
  let name = basename(decoded)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .trim()
    .replace(/[. ]+$/g, "");
  if (
    !name ||
    name === "." ||
    name === ".." ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  ) {
    name = "attachment";
  }
  return name.slice(0, MAX_NAME_LENGTH);
};

const imageDimensions = (
  bytes: Buffer,
  mimeType: string,
): [number, number] | null => {
  if (mimeType === "image/png" && bytes.length >= 24) {
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  if (mimeType === "image/gif" && bytes.length >= 10) {
    return [bytes.readUInt16LE(6), bytes.readUInt16LE(8)];
  }
  if (mimeType === "image/webp" && bytes.length >= 30) {
    const kind = bytes.toString("ascii", 12, 16);
    if (kind === "VP8X") {
      return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
    }
    if (
      kind === "VP8 " &&
      bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))
    ) {
      return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
    }
    if (kind === "VP8L" && bytes[20] === 0x2f) {
      return [
        1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
        1 +
          ((bytes[22] & 0xc0) >> 6) +
          (bytes[23] << 2) +
          ((bytes[24] & 0x0f) << 10),
      ];
    }
  }
  if (mimeType === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + length + 2 > bytes.length) break;
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        ![0xc4, 0xc8, 0xcc].includes(marker)
      ) {
        return [bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5)];
      }
      offset += length + 2;
    }
  }
  return null;
};

const validateImage = async (path: string, mimeType: string): Promise<void> => {
  const bytes = await readFile(path);
  const validSignature =
    (mimeType === "image/png" &&
      bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) ||
    (mimeType === "image/jpeg" &&
      bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) ||
    (mimeType === "image/gif" &&
      ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) ||
    (mimeType === "image/webp" &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP");
  if (!validSignature) throw new Error("IMAGE_SIGNATURE_MISMATCH");
  const dimensions = imageDimensions(bytes, mimeType);
  if (!dimensions || dimensions[0] < 1 || dimensions[1] < 1) {
    throw new Error("IMAGE_DIMENSIONS_INVALID");
  }
  if (dimensions[0] * dimensions[1] > MAX_IMAGE_PIXELS) {
    throw new Error("IMAGE_TOO_LARGE");
  }
};

const removeQuietly = async (path: string): Promise<void> => {
  try {
    await unlink(path);
  } catch {
    // Best-effort cleanup for temporary or abandoned uploads.
  }
};

const cleanupExpired = async (): Promise<void> => {
  const cutoff = Date.now() - ABANDONED_UPLOAD_TTL_MS;
  const expired = [...uploads.values()].filter(
    (item) => !item.consumed && item.createdAt < cutoff,
  );
  for (const item of expired) {
    uploads.delete(item.id);
    await removeQuietly(item.absolutePath);
  }
};

const pendingBytes = (): number =>
  [...uploads.values()].reduce(
    (total, item) => total + (item.consumed ? 0 : item.size),
    0,
  );

export const saveRemoteAttachment = async (
  native: NativeBridge,
  request: IncomingMessage,
  context: RemoteAttachmentContext,
  generation: number,
): Promise<RemoteAttachmentSummary> => {
  await cleanupExpired();
  const kind = request.headers["x-snow-attachment-kind"];
  if (kind !== "image" && kind !== "file")
    throw new Error("INVALID_ATTACHMENT_KIND");
  const mimeType = String(request.headers["content-type"] ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (!mimeType || mimeType === "application/json")
    throw new Error("INVALID_ATTACHMENT_MIME");
  if (kind === "image" && !IMAGE_MIMES.has(mimeType)) {
    throw new Error("UNSUPPORTED_IMAGE_TYPE");
  }
  const matching = [...uploads.values()].filter(
    (item) =>
      !item.consumed &&
      item.generation === generation &&
      sameContext(item.context, context),
  );
  if (matching.length + inFlightAttachmentCount >= MAX_REMOTE_ATTACHMENTS)
    throw new Error("TOO_MANY_ATTACHMENTS");

  inFlightAttachmentCount += 1;
  try {
    const maxBytes =
      kind === "image" ? MAX_REMOTE_IMAGE_BYTES : MAX_REMOTE_FILE_BYTES;
    const declaredLength = Number(request.headers["content-length"] ?? 0);
    if (
      !Number.isFinite(declaredLength) ||
      declaredLength < 0 ||
      declaredLength > maxBytes ||
      pendingBytes() + declaredLength > MAX_REMOTE_PENDING_BYTES
    ) {
      throw new Error("ATTACHMENT_TOO_LARGE");
    }

    const rawName = String(request.headers["x-snow-file-name"] ?? "attachment");
    const name = safeName(rawName);
    const suffix =
      kind === "image"
        ? IMAGE_MIMES.get(mimeType)!
        : extname(name).slice(0, 16);
    const id = randomBytes(18).toString("base64url");
    const day = new Date().toISOString().slice(0, 10);
    const uploadRoot = await native.getUploadRoot();
    const directory = join(uploadRoot, "remote", day, id);
    await mkdir(directory, { recursive: true });
    const absolutePath = join(
      directory,
      kind === "image" ? `image${suffix}` : name,
    );
    let size = 0;
    let reservedBytes = 0;
    const limiter = async function* (source: AsyncIterable<Buffer | string>) {
      for await (const chunk of source) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (
          size > maxBytes ||
          pendingBytes() + inFlightBytes + buffer.length >
            MAX_REMOTE_PENDING_BYTES
        ) {
          throw new Error("ATTACHMENT_TOO_LARGE");
        }
        inFlightBytes += buffer.length;
        reservedBytes += buffer.length;
        yield buffer;
      }
    };
    try {
      await pipeline(
        request,
        limiter,
        createWriteStream(absolutePath, { flags: "wx" }),
      );
      if (size === 0) throw new Error("EMPTY_ATTACHMENT");
      if (kind === "image") await validateImage(absolutePath, mimeType);
      const stored: StoredRemoteAttachment = {
        id,
        kind,
        name,
        mimeType,
        size,
        absolutePath,
        context,
        generation,
        createdAt: Date.now(),
        consumed: false,
      };
      uploads.set(id, stored);
      return { id, kind, name, mimeType, size };
    } catch (error) {
      await removeQuietly(absolutePath);
      throw error;
    } finally {
      inFlightBytes = Math.max(0, inFlightBytes - reservedBytes);
    }
  } finally {
    inFlightAttachmentCount = Math.max(0, inFlightAttachmentCount - 1);
  }
};

const requireAttachments = (
  ids: string[],
  context: RemoteAttachmentContext,
  generation: number,
): StoredRemoteAttachment[] => {
  if (ids.length > MAX_REMOTE_ATTACHMENTS || new Set(ids).size !== ids.length) {
    throw new Error("INVALID_ATTACHMENT_IDS");
  }
  return ids.map((id) => {
    const item = uploads.get(id);
    if (
      !item ||
      item.consumed ||
      item.generation !== generation ||
      !sameContext(item.context, context)
    ) {
      throw new Error("ATTACHMENT_NOT_AVAILABLE");
    }
    return item;
  });
};

export const resolveRemoteAttachments = async (
  ids: string[],
  context: RemoteAttachmentContext,
  generation: number,
): Promise<ResolvedRemoteAttachment[]> =>
  Promise.all(
    requireAttachments(ids, context, generation).map(async (item) => {
      if (item.kind === "file") {
        return { ...item, path: item.absolutePath };
      }
      const bytes = await readFile(item.absolutePath);
      return {
        ...item,
        dataUrl: `data:${item.mimeType};base64,${bytes.toString("base64")}`,
      };
    }),
  ).then((items) =>
    items.map(
      ({
        absolutePath: _path,
        context: _context,
        generation: _generation,
        createdAt: _created,
        consumed: _consumed,
        ...item
      }) => item,
    ),
  );

export const markRemoteAttachmentsConsumed = async (
  ids: string[],
  context: RemoteAttachmentContext,
  generation: number,
): Promise<void> => {
  const items = requireAttachments(ids, context, generation);
  for (const item of items) {
    item.consumed = true;
    uploads.delete(item.id);
    if (item.kind === "image") {
      await removeQuietly(item.absolutePath);
    }
  }
};

export const invalidateRemoteAttachments = async (): Promise<void> => {
  const pending = [...uploads.values()].filter((item) => !item.consumed);
  uploads.clear();
  for (const item of pending) await removeQuietly(item.absolutePath);
};

export const discardRemoteAttachment = async (
  id: string,
  context: RemoteAttachmentContext,
  generation: number,
): Promise<void> => {
  const item = uploads.get(id);
  if (
    !item ||
    item.consumed ||
    item.generation !== generation ||
    !sameContext(item.context, context)
  ) {
    return;
  }
  uploads.delete(id);
  await removeQuietly(item.absolutePath);
};
