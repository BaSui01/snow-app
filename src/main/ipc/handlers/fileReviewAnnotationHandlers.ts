import { ipcMain } from "electron";
import path from "node:path";
import type { NativeBridge, FileReviewTextAnchor } from "../../native/types";

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
};

const requireScope = (source: unknown, file: unknown): [string, string] => {
  const sourceKey = requireString(source, "File review sourceKey");
  const filePath = requireString(file, "File review filePath");
  const workspaceId = sourceKey.startsWith("ssh:") ? sourceKey.slice(4) : "";
  const remote =
    !!workspaceId.trim() && !/[\u0000-\u001f\u007f-\u009f]/.test(workspaceId);
  if (sourceKey !== "local" && !remote) {
    throw new Error(
      "File review sourceKey must be local or ssh:<stable workspaceId>",
    );
  }
  // Native verifies SSH IDs against the persistent workspace registry and performs
  // the same lexical normalization for every CRUD operation (no source-file I/O).
  if (!filePath || /[\u0000-\u001f\u007f]/.test(filePath)) {
    throw new Error("File review filePath must be an absolute path");
  }
  if (remote) {
    if (!filePath.startsWith("/") || filePath.includes("\\")) {
      throw new Error("SSH filePath must be a remote POSIX absolute path");
    }
  } else if (
    !/^[A-Za-z]:[\\/]/.test(filePath) &&
    !/^[/\\]{2}[^/\\]+[/\\][^/\\]+[/\\]/.test(filePath) &&
    !(process.platform !== "win32" && path.posix.isAbsolute(filePath))
  ) {
    throw new Error("Local filePath must be a fully qualified absolute path");
  }
  return [sourceKey, filePath];
};

const requireContent = (value: unknown): string => {
  const content = requireString(value, "File review content").trim();
  if (!content || Buffer.byteLength(content, "utf8") > 8192) {
    throw new Error(
      "File review content must be non-empty and at most 8 KiB UTF-8",
    );
  }
  return content;
};

const requireAnnotationId = (value: unknown): string => {
  const id = requireString(value, "File review annotationId");
  if (!id.trim() || id !== id.trim() || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new Error("File review annotationId is required");
  }
  return id;
};

const requireAnchor = (value: unknown): string => {
  const anchorJson = requireString(value, "File review anchorJson");
  if (Buffer.byteLength(anchorJson, "utf8") > 32768) {
    throw new Error("File review anchorJson exceeds 32 KiB UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(anchorJson);
  } catch {
    throw new Error("Invalid file review text anchor JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("File review anchor must be an object");
  }
  const anchor = parsed as Partial<FileReviewTextAnchor>;
  const fields = [
    "kind",
    "representation",
    "start",
    "end",
    "startLine",
    "endLine",
    "quote",
    "before",
    "after",
    "sourceHash",
  ];
  if (
    Object.keys(anchor).some((key) => !fields.includes(key)) ||
    anchor.kind !== "text-range" ||
    (anchor.representation !== "source" &&
      anchor.representation !== "extracted-text") ||
    typeof anchor.start !== "number" ||
    !Number.isSafeInteger(anchor.start) ||
    anchor.start < 0 ||
    typeof anchor.end !== "number" ||
    !Number.isSafeInteger(anchor.end) ||
    anchor.end <= anchor.start ||
    typeof anchor.startLine !== "number" ||
    !Number.isSafeInteger(anchor.startLine) ||
    anchor.startLine < 1 ||
    typeof anchor.endLine !== "number" ||
    !Number.isSafeInteger(anchor.endLine) ||
    anchor.endLine < anchor.startLine ||
    typeof anchor.quote !== "string" ||
    !anchor.quote.trim() ||
    anchor.quote.length > 4096 ||
    anchor.end - anchor.start !== anchor.quote.length ||
    typeof anchor.before !== "string" ||
    anchor.before.length > 80 ||
    typeof anchor.after !== "string" ||
    anchor.after.length > 80 ||
    typeof anchor.sourceHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(anchor.sourceHash)
  ) {
    throw new Error("Invalid file review text anchor fields");
  }
  // Re-serialize validated fields, so numeric JSON lexemes accepted by JS are also
  // canonical integers for native serde validation. Keep the storage size bound.
  const serialized = JSON.stringify(anchor);
  if (Buffer.byteLength(serialized, "utf8") > 32768)
    throw new Error("File review anchorJson exceeds 32 KiB UTF-8");
  return serialized;
};

export const registerFileReviewAnnotationHandlers = (
  native: NativeBridge,
): void => {
  ipcMain.handle(
    "file-review-annotations:list",
    (_event, sourceKey: unknown, filePath: unknown) =>
      native.listFileReviewAnnotations(...requireScope(sourceKey, filePath)),
  );
  ipcMain.handle(
    "file-review-annotations:create",
    (
      _event,
      sourceKey: unknown,
      filePath: unknown,
      anchorJson: unknown,
      content: unknown,
    ) =>
      native.createFileReviewAnnotation(
        ...requireScope(sourceKey, filePath),
        requireAnchor(anchorJson),
        requireContent(content),
      ),
  );
  ipcMain.handle(
    "file-review-annotations:update",
    (
      _event,
      sourceKey: unknown,
      filePath: unknown,
      annotationId: unknown,
      content: unknown,
    ) =>
      native.updateFileReviewAnnotation(
        ...requireScope(sourceKey, filePath),
        requireAnnotationId(annotationId),
        requireContent(content),
      ),
  );
  ipcMain.handle(
    "file-review-annotations:delete",
    (_event, sourceKey: unknown, filePath: unknown, annotationId: unknown) =>
      native.deleteFileReviewAnnotation(
        ...requireScope(sourceKey, filePath),
        requireAnnotationId(annotationId),
      ),
  );
};
