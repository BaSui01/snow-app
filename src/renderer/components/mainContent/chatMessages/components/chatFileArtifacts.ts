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

type WriteArguments = {
  target: unknown;
  source: unknown;
  deleteSource: boolean;
};
type WriteResult = WriteArguments & {
  trackedPaths: string[];
  success: boolean;
};
type WriteEvidence = {
  paths: readonly string[];
  success: boolean;
  unfinished: boolean;
  revision: string;
};
type CachedWrite = {
  name: string;
  arguments: string;
  result: string | undefined;
  status: ToolCallInfo["status"];
  authorization: boolean;
  args: WriteArguments;
  output: WriteResult;
  evidence: WriteEvidence;
};
type CachedMessage = {
  content: string | undefined;
  links: readonly string[];
  revision: string;
  calls: Map<string, CachedWrite>;
};

// Version tokens, not serialized tool output. No message/call objects are retained globally.
let artifactVersion = 0;
const nextRevision = (): string => `artifact:${++artifactVersion}`;
const samePaths = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((path, index) => path === right[index]);

const readWriteArguments = (text: string): WriteArguments => {
  const args = parseObject(text);
  const readPath = (key: string): unknown => {
    if (args) return args[key];
    // Suspend older previews as soon as a complete string path arrives in streaming JSON.
    const match = text.match(
      new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`),
    );
    try {
      return match ? JSON.parse(match[1]) : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    target: readPath("filePath"),
    source: readPath("sourceFilePath"),
    deleteSource:
      args?.deleteSource === true ||
      (!args && /"deleteSource"\s*:\s*true(?=\s*[,}]|$)/.test(text)),
  };
};

const readWriteResult = (text: string | undefined): WriteResult => {
  const result = parseObject(text);
  const tracking = result?.fileTracking;
  const files =
    tracking && typeof tracking === "object" && "files" in tracking
      ? tracking.files
      : undefined;
  return {
    target: result?.targetFilePath ?? result?.filePath ?? result?.path,
    source: result?.sourceFilePath,
    deleteSource: result?.deleteSource === true,
    trackedPaths: Array.isArray(files)
      ? files.flatMap((file: unknown) =>
          file &&
          typeof file === "object" &&
          "filePath" in file &&
          typeof file.filePath === "string" &&
          !("kind" in file && file.kind === "delete")
            ? [file.filePath]
            : [],
        )
      : [],
    success:
      result?.success === true &&
      !("error" in result) &&
      result.truncated !== true,
  };
};

/** A cut modifies BOTH files, even when the paste destination is not HTML. */
const affectedWritePaths = (
  name: string,
  args: WriteArguments,
  result: WriteResult,
  workspace: string | undefined,
): string[] => {
  const paths = new Map<string, string>();
  const add = (raw: unknown): void => {
    if (typeof raw !== "string") return;
    const path = resolveArtifactPath(raw, workspace);
    if (path) paths.set(artifactFileKey(path), path);
  };
  add(result.target ?? args.target);
  for (const path of result.trackedPaths) add(path);
  if (
    name === "filesystem-copy" &&
    (args.deleteSource || result.deleteSource)
  ) {
    add(result.source ?? args.source);
  }
  return [...paths.values()];
};

/**
 * Cache by stable persisted message/call identity, not render-frame object identity.
 * Only the current message/call set is retained; a workspace change drops all entries.
 */
export const createChatFileArtifactCollector =
  (): typeof collectChatFileArtifacts => {
    let cachedWorkspace: string | undefined;
    let cachedMessages = new Map<string, CachedMessage>();
    return (messages, workspace) => {
      if (workspace !== cachedWorkspace) {
        cachedMessages.clear();
        cachedWorkspace = workspace;
      }
      const nextMessages = new Map<string, CachedMessage>();
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
          const previousMessage = cachedMessages.get(message.id);
          const cached: CachedMessage = {
            content: previousMessage?.content,
            links: previousMessage?.links ?? [],
            revision: previousMessage?.revision ?? nextRevision(),
            calls: new Map(),
          };
          nextMessages.set(message.id, cached);
          for (const [index, call] of (message.toolCalls ?? []).entries()) {
            if (!WRITE_TOOLS.has(call.name)) continue;
            const callKey = call.interactionId || call.callId || String(index);
            const previous = previousMessage?.calls.get(callKey);
            let current = previous;
            const authorization = Boolean(call.authorizationId);
            if (
              !previous ||
              previous.name !== call.name ||
              previous.arguments !== call.arguments ||
              previous.result !== call.result ||
              previous.status !== call.status ||
              previous.authorization !== authorization
            ) {
              const args =
                previous?.arguments === call.arguments
                  ? previous.args
                  : readWriteArguments(call.arguments);
              const output =
                previous && previous.result === call.result
                  ? previous.output
                  : readWriteResult(call.result);
              const paths = affectedWritePaths(
                call.name,
                args,
                output,
                workspace,
              );
              const success =
                call.status === "completed" && output.success && !authorization;
              const unfinished =
                call.status === "pending" ||
                call.status === "running" ||
                authorization;
              const evidence = previous?.evidence;
              current = {
                name: call.name,
                arguments: call.arguments,
                result: call.result,
                status: call.status,
                authorization,
                args,
                output,
                evidence: {
                  paths,
                  success,
                  unfinished,
                  revision:
                    evidence &&
                    evidence.success === success &&
                    evidence.unfinished === unfinished &&
                    samePaths(evidence.paths, paths) &&
                    (!success || previous.result === call.result)
                      ? evidence.revision
                      : nextRevision(),
                },
              };
            }
            if (!current) continue;
            cached.calls.set(callKey, current);
            const { paths, success, unfinished, revision } = current.evidence;
            for (const path of paths) {
              const key = artifactFileKey(path);
              if (unfinished) unfinishedWrites.add(key);
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
        }
        for (const message of run) {
          if (
            message.role !== "assistant" ||
            message.status === "sending" ||
            message.status === "error"
          )
            continue;
          const cached = nextMessages.get(message.id)!;
          if (cached.content !== message.content) {
            const links = new Map<string, string>();
            for (const token of markdown.parse(message.content, {})) {
              for (const child of token.children ?? []) {
                if (child.type !== "link_open") continue;
                const href = child.attrGet("href");
                const path = href
                  ? resolveArtifactHref(href, workspace)
                  : undefined;
                if (path) links.set(artifactFileKey(path), path);
              }
            }
            cached.content = message.content;
            cached.links = [...links.values()];
          }
          for (const path of cached.links) {
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
                    revision: cached.revision,
                    automatic: false,
                    blocked: false,
                    isSsh: workspace?.startsWith("ssh://") ?? false,
                  },
            );
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
      cachedMessages = nextMessages;
      // All cards read the current file: pending/failed writes suspend earlier cards too.
      return artifacts.map((artifact) => {
        const latest = latestWrites.get(artifact.key);
        return {
          ...artifact,
          blocked:
            unfinishedWrites.has(artifact.key) || (latest?.blocked ?? false),
          revision: latest?.revision ?? artifact.revision,
        };
      });
    };
  };

/** Reconstruct evidence from persisted calls, not live tool events or model path mentions. */
export const collectChatFileArtifacts = (
  messages: ChatConversationMessage[],
  workspace: string | undefined,
): ChatFileArtifact[] => createChatFileArtifactCollector()(messages, workspace);
