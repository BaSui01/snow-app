import MarkdownIt from "markdown-it";
import { localFileUrlToPath } from "../../../../utils/localFileUrl";
import { localPathToFileUrl } from "../../../../utils/browserFileOpen";
import type {
  ChatConversationMessage,
  ToolCallInfo,
} from "../utils/conversationTypes";

export { HTML_ARTIFACT_MAX_BYTES } from "../../../../../shared/htmlArtifact";
const WRITE_TOOLS = new Set([
  "filesystem-create",
  "filesystem-replace_edit",
  "filesystem-copy",
]);
const markdown = new MarkdownIt({ html: false, linkify: false });
const defaultValidateLink = markdown.validateLink.bind(markdown);
markdown.validateLink = (href) =>
  /^file:/i.test(href)
    ? localFileUrlToPath(href.split(/[?#]/, 1)[0]) !== undefined
    : defaultValidateLink(href);

export type ChatFileArtifact = {
  key: string;
  path: string;
  ownerId: string;
  revision: string;
  automatic: boolean;
  blocked: boolean;
  isSsh: boolean;
};

const parseObject = (
  text: string | undefined,
): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(
      text?.split("\n\n[Hook Context]")[0] ?? "",
    );
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

/** Only local paths or the conversation's own SSH authority; never the app URL base. */
export const resolveArtifactPath = (
  raw: string,
  workspace: string | undefined,
): string | undefined => {
  const remote = workspace?.startsWith("ssh://") ?? false;
  if (!raw || /[\u0000-\u001f]/.test(raw) || /^[\\/]{2}/.test(raw)) return;
  let path = raw;
  if (/^ssh:\/\//i.test(path)) {
    if (
      !remote ||
      path.match(/^ssh:\/\/[^/]+/i)?.[0] !==
        workspace?.match(/^ssh:\/\/[^/]+/i)?.[0]
    )
      return;
    path = path.replace(/^ssh:\/\/[^/]+/i, "");
  }
  if (/^file:/i.test(path)) {
    if (remote) return;
    const local = localFileUrlToPath(path);
    if (!local) return;
    path = local;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) return;
  if (!/\.html?$/i.test(path)) return;
  if (remote) {
    if (/^[a-z]:/i.test(path) || path.includes("\\")) return;
    const root = workspace!.replace(/^ssh:\/\/[^/]+/, "");
    // URL resolves dot segments; encode each segment so spaces and percent names stay literal.
    const absolute = path.startsWith("/")
      ? path
      : `${root.replace(/\/$/, "")}/${path}`;
    return decodeURIComponent(
      new URL(
        absolute.split("/").map(encodeURIComponent).join("/"),
        "https://artifact.invalid",
      ).pathname,
    );
  }
  if (!/^(?:\/|[a-z]:[\\/])/i.test(path)) {
    if (!workspace) return;
    path = `${workspace.replace(/[\\/]+$/, "")}/${path}`;
  }
  const url = localPathToFileUrl(path);
  return url ? localFileUrlToPath(url) : undefined;
};

/** URI decorations are not filename characters; encoded %23/%3F remain literal after decoding. */
export const resolveArtifactHref = (
  href: string,
  workspace: string | undefined,
): string | undefined => {
  const pathname = href.trim().split(/[?#]/, 1)[0];
  try {
    return resolveArtifactPath(
      /^file:/i.test(pathname) ? pathname : decodeURIComponent(pathname),
      workspace,
    );
  } catch {
    return;
  }
};

export const artifactFileKey = (path: string): string =>
  /^[a-z]:/i.test(path) ? path.replace(/\\/g, "/").toLowerCase() : path;

const writePath = (
  call: ToolCallInfo,
  workspace: string | undefined,
): string | undefined => {
  const result = parseObject(call.result);
  const args = parseObject(call.arguments);
  const target = result?.targetFilePath ?? result?.filePath ?? result?.path;
  if (typeof target === "string") return resolveArtifactPath(target, workspace);
  const tracking = result?.fileTracking;
  const files =
    tracking && typeof tracking === "object" && "files" in tracking
      ? tracking.files
      : undefined;
  if (Array.isArray(files) && files.length === 1) {
    const file = files[0];
    if (file && typeof file.filePath === "string" && file.kind !== "delete")
      return resolveArtifactPath(file.filePath, workspace);
  }
  const argumentKey = "filePath";
  let argumentPath = args?.[argumentKey];
  // A complete JSON string path is enough to suspend an older preview while args stream.
  if (!args && call.status !== "completed") {
    const match = call.arguments.match(
      new RegExp(`"${argumentKey}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`),
    );
    try {
      argumentPath = match ? JSON.parse(match[1]) : undefined;
    } catch {
      return;
    }
  }
  return typeof argumentPath === "string"
    ? resolveArtifactPath(argumentPath, workspace)
    : undefined;
};

/** Reconstruct evidence from persisted calls, not live tool events or model path mentions. */
export const collectChatFileArtifacts = (
  messages: ChatConversationMessage[],
  workspace: string | undefined,
): ChatFileArtifact[] => {
  const artifacts: ChatFileArtifact[] = [];
  const unfinishedWrites = new Set<string>();
  const latestWrites = new Map<
    string,
    { blocked: boolean; revision: string }
  >();
  let run: ChatConversationMessage[] = [];
  const flush = (): void => {
    const candidates = new Map<string, ChatFileArtifact>();
    for (const message of run) {
      if (message.role !== "assistant") continue;
      for (const call of message.toolCalls ?? []) {
        if (!WRITE_TOOLS.has(call.name)) continue;
        const path = writePath(call, workspace);
        if (!path) continue;
        const key = artifactFileKey(path);
        if (
          call.status === "pending" ||
          call.status === "running" ||
          call.authorizationId
        ) {
          unfinishedWrites.add(key);
        }
        const result = parseObject(call.result);
        const success =
          call.status === "completed" &&
          result?.success === true &&
          !("error" in result) &&
          result.truncated !== true &&
          !call.authorizationId;
        const revision = `${message.id}:${call.interactionId}:${call.result ?? call.status}`;
        latestWrites.set(key, { blocked: !success, revision });
        if (!success) continue;
        candidates.set(key, {
          key,
          path,
          ownerId: candidates.get(key)?.ownerId ?? message.id,
          revision,
          automatic: true,
          blocked: false,
          isSsh: workspace?.startsWith("ssh://") ?? false,
        });
      }
    }
    for (const message of run) {
      if (
        message.role !== "assistant" ||
        message.status === "sending" ||
        message.status === "error"
      )
        continue;
      for (const token of markdown.parse(message.content, {})) {
        for (const child of token.children ?? []) {
          if (child.type !== "link_open") continue;
          const href = child.attrGet("href");
          if (!href) continue;
          const path = resolveArtifactHref(href, workspace);
          if (!path) continue;
          const key = artifactFileKey(path);
          const previous = candidates.get(key);
          candidates.set(
            key,
            previous
              ? { ...previous, ownerId: message.id }
              : {
                  key,
                  path,
                  ownerId: message.id,
                  revision: message.id,
                  automatic: false,
                  blocked: false,
                  isSsh: workspace?.startsWith("ssh://") ?? false,
                },
          );
        }
      }
    }
    artifacts.push(...candidates.values());
    run = [];
  };
  for (const message of messages) {
    if (message.role === "user") flush();
    else run.push(message);
  }
  flush();
  // All cards read the current file: a later pending/failed write suspends older cards too.
  return artifacts.map((artifact) => {
    const latest = latestWrites.get(artifact.key);
    return {
      ...artifact,
      blocked: unfinishedWrites.has(artifact.key) || (latest?.blocked ?? false),
      revision: latest?.revision ?? artifact.revision,
    };
  });
};
