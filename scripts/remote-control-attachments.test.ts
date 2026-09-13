import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, test } from "node:test";
import type { IncomingMessage } from "node:http";
import type { NativeBridge } from "../src/main/native/types";
import {
  invalidateRemoteAttachments,
  resolveRemoteAttachments,
  saveRemoteAttachment,
} from "../src/main/remoteControl/remoteAttachmentStore.ts";

let root = "";

const native = {
  getUploadRoot: async () => root,
} as unknown as NativeBridge;

const context = { directoryId: "workspace-a", conversationId: "chat-a" };

const request = (
  bytes: Buffer,
  kind: "image" | "file",
  mimeType: string,
  name: string,
): IncomingMessage => {
  const stream = Readable.from([bytes]) as IncomingMessage;
  stream.headers = {
    "content-type": mimeType,
    "content-length": String(bytes.length),
    "x-snow-attachment-kind": kind,
    "x-snow-file-name": encodeURIComponent(name),
  };
  return stream;
};

const png = (): Buffer => {
  const bytes = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(2, 16);
  bytes.writeUInt32BE(3, 20);
  return bytes;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "snow-remote-test-"));
});

afterEach(async () => {
  await invalidateRemoteAttachments();
  await rm(root, { recursive: true, force: true });
});

test("accepts a signature-matched image and resolves it only in its context", async () => {
  const saved = await saveRemoteAttachment(
    native,
    request(png(), "image", "image/png", "phone.png"),
    context,
    3,
  );
  const [resolved] = await resolveRemoteAttachments([saved.id], context, 3);
  assert.equal(resolved.kind, "image");
  assert.match(resolved.dataUrl ?? "", /^data:image\/png;base64,/);
  await assert.rejects(
    resolveRemoteAttachments(
      [saved.id],
      { ...context, conversationId: "chat-b" },
      3,
    ),
    /ATTACHMENT_NOT_AVAILABLE/,
  );
});

test("rejects an image whose declared MIME does not match its bytes", async () => {
  await assert.rejects(
    saveRemoteAttachment(
      native,
      request(Buffer.from("not an image"), "image", "image/png", "fake.png"),
      context,
      1,
    ),
    /IMAGE_SIGNATURE_MISMATCH/,
  );
});

test("stores ordinary files with a safe original display name", async () => {
  const saved = await saveRemoteAttachment(
    native,
    request(Buffer.from("hello"), "file", "text/plain", "notes.txt"),
    context,
    1,
  );
  const [resolved] = await resolveRemoteAttachments([saved.id], context, 1);
  assert.equal(resolved.name, "notes.txt");
  assert.equal(basename(resolved.path ?? ""), "notes.txt");
});

test("does not allow traversal-only or Windows device filenames", async () => {
  const traversal = await saveRemoteAttachment(
    native,
    request(Buffer.from("iori"), "file", "application/octet-stream", ".."),
    context,
    2,
  );
  const [resolvedTraversal] = await resolveRemoteAttachments(
    [traversal.id],
    context,
    2,
  );
  assert.equal(basename(resolvedTraversal.path ?? ""), "attachment");

  const device = await saveRemoteAttachment(
    native,
    request(Buffer.from("iori"), "file", "application/octet-stream", "CON.txt"),
    context,
    2,
  );
  const [resolvedDevice] = await resolveRemoteAttachments(
    [device.id],
    context,
    2,
  );
  assert.equal(basename(resolvedDevice.path ?? ""), "attachment");
});

test("limits one context to four pending attachments", async () => {
  for (let index = 0; index < 4; index += 1) {
    await saveRemoteAttachment(
      native,
      request(Buffer.from(String(index)), "file", "text/plain", `${index}.txt`),
      context,
      7,
    );
  }
  await assert.rejects(
    saveRemoteAttachment(
      native,
      request(Buffer.from("five"), "file", "text/plain", "five.txt"),
      context,
      7,
    ),
    /TOO_MANY_ATTACHMENTS/,
  );
});
