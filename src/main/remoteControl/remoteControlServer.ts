import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { networkInterfaces } from "node:os";
import type { AddressInfo } from "node:net";
import { getMainWindow } from "../app/mainWindow";
import { native } from "../native/nativeBridge";
import { MOBILE_HTML as PRODUCT_MOBILE_HTML } from "./mobilePage";
import { RemoteWanAuth } from "./remoteWanAuth";
import { waitForCallbackOrTimeout, withTimeout } from "./boundedWait";
import {
  discardRemoteAttachment,
  invalidateRemoteAttachments,
  markRemoteAttachmentsConsumed,
  saveRemoteAttachment,
  type RemoteAttachmentContext,
} from "./remoteAttachmentStore";

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8788;
const MAX_BODY_BYTES = 64 * 1024;
const COOKIE_NAME = "snowRemoteToken";
const WAN_COOKIE_NAME = "snowRemoteSession";
const TOKEN_HEADER = "x-snow-remote-token";
const WAN_HOST = "127.0.0.1";

type RemoteAction =
  | "getState"
  | "getMessageImage"
  | "getSkills"
  | "setSkillEnabled"
  | "getMcpServers"
  | "setMcpEnabled"
  | "getChanges"
  | "getPermissions"
  | "getRole"
  | "getSensitiveCommands"
  | "getCodebase"
  | "getReview"
  | "send"
  | "abort"
  | "newChat"
  | "setMode"
  | "select"
  | "approve"
  | "reject"
  | "answer"
  | "cancelQuestion"
  | "setModel"
  | "setApiProfile"
  | "setThinking"
  | "toggleResponsesFastMode"
  | "runCommand";

/**
 * 可远程切换的会话级模式白名单。
 * 必须与 renderer/types/remoteControl.ts 的 SnowRemoteModeId 保持一致；
 * Renderer 桥会按同一份枚举做二次校验。
 */
const REMOTE_MODES = ["plan", "goal", "worktree", "workflow", "yolo"] as const;

/** 标识符类字段（模型 id / Profile 名 / 指令 id / 思考强度）的长度上限。 */
const MAX_IDENTIFIER_LENGTH = 200;

const isRemoteMode = (value: unknown): value is (typeof REMOTE_MODES)[number] =>
  typeof value === "string" &&
  (REMOTE_MODES as readonly string[]).includes(value);

/** 标识符必须是长度受限的字符串；空串只在思考强度（继承 Profile）时合法。 */
const isBoundedString = (value: unknown, allowEmpty = false): boolean =>
  typeof value === "string" &&
  value.length <= MAX_IDENTIFIER_LENGTH &&
  (allowEmpty || value.trim().length > 0);

type RemoteServerInfo = {
  host: string;
  port: number;
  pairingUrls: string[];
};

type RequestPolicy = { kind: "lan" } | { kind: "wan"; auth: RemoteWanAuth };

let server: ReturnType<typeof createServer> | null = null;
let wanServer: ReturnType<typeof createServer> | null = null;
let wanPort = 0;
let wanAuth: RemoteWanAuth | null = null;
let wanLifecycle: Promise<void> = Promise.resolve();
let startPromise: Promise<RemoteServerInfo | null> | null = null;
let serverInfo: RemoteServerInfo | null = null;
let activeToken = "";
let pairingGeneration = 0;
const completedSendRequests = new Map<
  string,
  { generation: number; result: unknown }
>();
let activeSendDispatches = 0;
const sendIdleWaiters = new Set<() => void>();

const waitForSendIdle = async (): Promise<void> => {
  if (activeSendDispatches === 0) return;
  await new Promise<void>((resolve) => sendIdleWaiters.add(resolve));
};

const finishRemoteMutation = (): void => {
  activeSendDispatches -= 1;
  if (activeSendDispatches === 0) {
    for (const resolve of sendIdleWaiters) resolve();
    sendIdleWaiters.clear();
  }
};

const MOBILE_HTML = PRODUCT_MOBILE_HTML;

const writeJson = (
  response: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): void => {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...extraHeaders,
  });
  response.end(body);
};

const parseCookies = (header: string | undefined): Map<string, string> => {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator > 0) {
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      try {
        cookies.set(name, decodeURIComponent(value));
      } catch {
        // Ignore malformed cookies; they must not turn an auth failure into a 500.
      }
    }
  }
  return cookies;
};

const tokenMatches = (
  candidate: string | undefined,
  token: string,
): boolean => {
  if (!candidate) return false;
  const expected = Buffer.from(token);
  const actual = Buffer.from(candidate);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

const isAuthorized = (
  request: IncomingMessage,
  url: URL,
  token: string,
): boolean =>
  tokenMatches(request.headers[TOKEN_HEADER] as string | undefined, token) ||
  tokenMatches(parseCookies(request.headers.cookie).get(COOKIE_NAME), token) ||
  tokenMatches(url.searchParams.get("token") ?? undefined, token);

const isWanAuthorized = (
  request: IncomingMessage,
  auth: RemoteWanAuth,
): boolean =>
  auth.authorize(parseCookies(request.headers.cookie).get(WAN_COOKIE_NAME));

const hasExpectedWanOrigin = (
  request: IncomingMessage,
  auth: RemoteWanAuth,
): boolean => request.headers.origin === auth.origin;

const hasExpectedWanHost = (
  request: IncomingMessage,
  auth: RemoteWanAuth,
): boolean =>
  request.headers.host?.toLowerCase() === auth.expectedHost.toLowerCase();

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("REQUEST_TOO_LARGE");
    }
    chunks.push(buffer);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("INVALID_JSON");
  }
};

const callRenderer = async (
  action: RemoteAction,
  args: unknown[] = [],
): Promise<unknown> => {
  const window = getMainWindow();
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    throw new Error("Snow 主窗口不可用");
  }
  const invocation = `(() => { const api = window.__snowRemoteControl; if (!api) throw new Error("远程控制桥尚未就绪"); return api[${JSON.stringify(action)}](...${JSON.stringify(args)}); })()`;
  return withTimeout(
    window.webContents.executeJavaScript(invocation, true),
    10_000,
    "桌面 Snow 响应超时，请确认主窗口仍在运行",
  );
};

const dispatchRemoteSend = async (
  text: string,
  attachmentIds: string[],
  requestId: string,
  generation: number,
): Promise<unknown> => {
  activeSendDispatches += 1;
  try {
    if (generation !== pairingGeneration) throw new Error("PAIRING_ROTATED");
    const remoteState = (await callRenderer("getState")) as {
      activeConversationId?: string | null;
      workspace?: { directoryId?: string } | null;
    };
    if (generation !== pairingGeneration) throw new Error("PAIRING_ROTATED");
    const context: RemoteAttachmentContext = {
      directoryId: remoteState.workspace?.directoryId ?? null,
      conversationId: remoteState.activeConversationId ?? null,
    };
    const result = await callRenderer("send", [
      text,
      attachmentIds,
      requestId,
      context,
      generation,
    ]);
    await markRemoteAttachmentsConsumed(attachmentIds, context, generation);
    completedSendRequests.set(requestId, { generation, result });
    while (completedSendRequests.size > 200) {
      const oldest = completedSendRequests.keys().next().value;
      if (typeof oldest === "string") completedSendRequests.delete(oldest);
      else break;
    }
    return result;
  } finally {
    finishRemoteMutation();
  }
};

const getLanAddresses = (): string[] => {
  const addresses = new Set<string>(["127.0.0.1"]);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal)
        addresses.add(entry.address);
    }
  }
  return [...addresses];
};

const parsePort = (): number => {
  const raw = process.env.SNOW_REMOTE_PORT;
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SNOW_REMOTE_PORT 必须是 1 到 65535 的整数");
  }
  return port;
};

const parseWanPort = (): number => {
  const raw = process.env.SNOW_REMOTE_WAN_PORT;
  if (!raw) return 0;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("SNOW_REMOTE_WAN_PORT 必须是 0 到 65535 的整数");
  }
  return port;
};

const isJsonRequest = (request: IncomingMessage): boolean =>
  typeof request.headers["content-type"] === "string" &&
  request.headers["content-type"].toLowerCase().startsWith("application/json");

const handleRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  policy: RequestPolicy = { kind: "lan" },
): Promise<void> => {
  // Parse only the request target. Never use the client-controlled Host header.
  const url = new URL(request.url ?? "/", "http://localhost");

  const requestGeneration = pairingGeneration;
  const requestToken = activeToken;
  if (policy.kind === "wan" && !hasExpectedWanHost(request, policy.auth)) {
    writeJson(response, 421, { error: "公网入口域名不匹配" });
    return;
  }

  if (
    policy.kind === "wan" &&
    request.method === "POST" &&
    url.pathname === "/api/pair"
  ) {
    if (!hasExpectedWanOrigin(request, policy.auth)) {
      writeJson(response, 403, { error: "请求来源无效" });
      return;
    }
    if (!isJsonRequest(request)) {
      writeJson(response, 415, {
        error: "Content-Type 必须是 application/json",
      });
      return;
    }
    try {
      const body = (await readJsonBody(request)) as { code?: unknown };
      if (typeof body.code !== "string" || body.code.length > 200) {
        writeJson(response, 400, { error: "配对码无效" });
        return;
      }
      const session = policy.auth.exchange(body.code);
      if (!session) {
        writeJson(response, 401, { error: "配对码无效或已过期" });
        return;
      }
      writeJson(
        response,
        200,
        { ok: true, expiresAt: session.expiresAt },
        {
          "Set-Cookie": `${WAN_COOKIE_NAME}=${encodeURIComponent(session.token)}; Path=/; Max-Age=86400; Secure; HttpOnly; SameSite=Strict`,
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeJson(response, message === "REQUEST_TOO_LARGE" ? 413 : 400, {
        error:
          message === "REQUEST_TOO_LARGE"
            ? "请求体超过 64 KiB"
            : "JSON 格式无效",
      });
    }
    return;
  }

  const authorized =
    policy.kind === "lan"
      ? Boolean(requestToken && isAuthorized(request, url, requestToken))
      : isWanAuthorized(request, policy.auth);
  const isWanPairingPage =
    policy.kind === "wan" && request.method === "GET" && url.pathname === "/";
  if (!authorized && !isWanPairingPage) {
    writeJson(response, 401, {
      error: "未授权：请使用 Snow 设置中显示的配对链接",
    });
    return;
  }

  if (
    policy.kind === "wan" &&
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    !hasExpectedWanOrigin(request, policy.auth)
  ) {
    writeJson(response, 403, { error: "请求来源无效" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/") {
    const headers: Record<string, string> = {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": String(Buffer.byteLength(MOBILE_HTML)),
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    };
    if (
      policy.kind === "lan" &&
      tokenMatches(url.searchParams.get("token") ?? undefined, requestToken)
    ) {
      headers["Set-Cookie"] =
        `${COOKIE_NAME}=${encodeURIComponent(requestToken)}; Path=/; HttpOnly; SameSite=Strict`;
    }
    response.writeHead(200, headers);
    response.end(MOBILE_HTML);
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    writeJson(response, 200, {
      ok: true,
      rendererReady: Boolean(getMainWindow()),
    });
    return;
  }

  try {
    const ensureCurrentPairing = (): void => {
      if (requestGeneration !== pairingGeneration)
        throw new Error("PAIRING_ROTATED");
    };

    if (request.method === "GET" && url.pathname === "/api/state") {
      ensureCurrentPairing();
      writeJson(response, 200, await callRenderer("getState"));
      return;
    }

    if (
      request.method === "GET" &&
      url.pathname.startsWith("/api/message-images/")
    ) {
      const parts = url.pathname.slice("/api/message-images/".length).split("/");
      const messageId = decodeURIComponent(parts[0] ?? "");
      const imageIndex = Number(parts[1]);
      if (
        parts.length !== 2 ||
        !isBoundedString(messageId) ||
        !Number.isInteger(imageIndex) ||
        imageIndex < 0 ||
        imageIndex > 20
      ) {
        writeJson(response, 400, { error: "图片标识无效" });
        return;
      }
      ensureCurrentPairing();
      const image = (await callRenderer("getMessageImage", [
        messageId,
        imageIndex,
      ])) as { mimeType?: unknown; base64?: unknown };
      ensureCurrentPairing();
      if (
        typeof image.base64 !== "string" ||
        typeof image.mimeType !== "string" ||
        !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
          image.mimeType,
        )
      ) {
        throw new Error("图片不可用");
      }
      const body = Buffer.from(image.base64, "base64");
      if (body.length === 0 || body.length > 10 * 1024 * 1024) {
        throw new Error("图片不可用");
      }
      response.writeHead(200, {
        "Content-Type": image.mimeType,
        "Content-Length": String(body.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      response.end(body);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/skills") {
      ensureCurrentPairing();
      writeJson(response, 200, await callRenderer("getSkills"));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/skills") {
      if (!isJsonRequest(request)) {
        writeJson(response, 415, { error: "Content-Type 必须是 application/json" });
        return;
      }
      const body = (await readJsonBody(request)) as {
        skillId?: unknown;
        enabled?: unknown;
        directoryId?: unknown;
      };
      if (
        !isBoundedString(body.skillId) ||
        typeof body.enabled !== "boolean" ||
        !(
          body.directoryId === null ||
          body.directoryId === undefined ||
          isBoundedString(body.directoryId)
        )
      ) {
        writeJson(response, 400, { error: "Skill 请求无效" });
        return;
      }
      ensureCurrentPairing();
      writeJson(
        response,
        200,
        await callRenderer("setSkillEnabled", [
          body.skillId,
          body.enabled,
          body.directoryId ?? null,
        ]),
      );
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/mcp") {
      ensureCurrentPairing();
      writeJson(response, 200, await callRenderer("getMcpServers"));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/changes") {
      ensureCurrentPairing();
      const conversationId = url.searchParams.get("conversationId");
      if (conversationId !== null && !isBoundedString(conversationId)) {
        writeJson(response, 400, { error: "会话标识无效" });
        return;
      }
      writeJson(response, 200, await callRenderer("getChanges", [conversationId]));
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/sensitive-commands") {
      ensureCurrentPairing();
      writeJson(response, 200, await callRenderer("getSensitiveCommands"));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/review") {
      ensureCurrentPairing();
      writeJson(response, 200, await callRenderer("getReview"));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/codebase") {
      ensureCurrentPairing();
      writeJson(response, 200, await callRenderer("getCodebase"));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/role") {
      ensureCurrentPairing();
      writeJson(response, 200, await callRenderer("getRole"));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/permissions") {
      ensureCurrentPairing();
      writeJson(response, 200, await callRenderer("getPermissions"));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/mcp") {
      if (!isJsonRequest(request)) {
        writeJson(response, 415, { error: "Content-Type 必须是 application/json" });
        return;
      }
      const body = (await readJsonBody(request)) as {
        target?: unknown;
        id?: unknown;
        enabled?: unknown;
        directoryId?: unknown;
      };
      if (
        (body.target !== "server" && body.target !== "tool") ||
        !isBoundedString(body.id) ||
        typeof body.enabled !== "boolean" ||
        !isBoundedString(body.directoryId)
      ) {
        writeJson(response, 400, { error: "MCP 请求无效" });
        return;
      }
      ensureCurrentPairing();
      writeJson(response, 200, await callRenderer("setMcpEnabled", [
        body.target,
        body.id,
        body.enabled,
        body.directoryId,
      ]));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/attachments") {
      activeSendDispatches += 1;
      try {
        const remoteState = (await callRenderer("getState")) as {
          activeConversationId?: string | null;
          workspace?: { directoryId?: string } | null;
        };
        ensureCurrentPairing();
        const context: RemoteAttachmentContext = {
          directoryId: remoteState.workspace?.directoryId ?? null,
          conversationId: remoteState.activeConversationId ?? null,
        };
        const attachment = await saveRemoteAttachment(
          native,
          request,
          context,
          requestGeneration,
        );
        ensureCurrentPairing();
        writeJson(response, 201, attachment);
      } finally {
        finishRemoteMutation();
      }
      return;
    }

    if (
      request.method === "DELETE" &&
      url.pathname.startsWith("/api/attachments/")
    ) {
      const id = decodeURIComponent(
        url.pathname.slice("/api/attachments/".length),
      );
      if (!isBoundedString(id)) {
        writeJson(response, 400, { error: "附件标识无效" });
        return;
      }
      const remoteState = (await callRenderer("getState")) as {
        activeConversationId?: string | null;
        workspace?: { directoryId?: string } | null;
      };
      ensureCurrentPairing();
      await discardRemoteAttachment(
        id,
        {
          directoryId: remoteState.workspace?.directoryId ?? null,
          conversationId: remoteState.activeConversationId ?? null,
        },
        requestGeneration,
      );
      writeJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/send") {
      if (!isJsonRequest(request)) {
        writeJson(response, 415, {
          error: "Content-Type 必须是 application/json",
        });
        return;
      }
      const body = (await readJsonBody(request)) as {
        text?: unknown;
        attachmentIds?: unknown;
        requestId?: unknown;
      };
      if (typeof body.text !== "string") {
        writeJson(response, 400, { error: "text 必须是字符串" });
        return;
      }
      const attachmentIds = body.attachmentIds ?? [];
      if (
        !Array.isArray(attachmentIds) ||
        !attachmentIds.every((id) => isBoundedString(id)) ||
        !isBoundedString(body.requestId)
      ) {
        writeJson(response, 400, { error: "附件或请求标识无效" });
        return;
      }
      ensureCurrentPairing();
      const requestId = body.requestId as string;
      const completed = completedSendRequests.get(requestId);
      if (completed?.generation === requestGeneration) {
        writeJson(response, 200, completed.result);
        return;
      }
      const result = await dispatchRemoteSend(
        body.text,
        attachmentIds as string[],
        requestId,
        requestGeneration,
      );
      writeJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/abort") {
      if (!isJsonRequest(request)) {
        writeJson(response, 415, {
          error: "Content-Type 必须是 application/json",
        });
        return;
      }
      await readJsonBody(request);
      writeJson(response, 200, await callRenderer("abort"));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/new-chat") {
      if (!isJsonRequest(request)) {
        writeJson(response, 415, {
          error: "Content-Type 必须是 application/json",
        });
        return;
      }
      await readJsonBody(request);
      writeJson(response, 200, await callRenderer("newChat"));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/mode") {
      if (!isJsonRequest(request)) {
        writeJson(response, 415, {
          error: "Content-Type 必须是 application/json",
        });
        return;
      }
      const body = (await readJsonBody(request)) as {
        mode?: unknown;
        enabled?: unknown;
      };
      if (!isRemoteMode(body.mode)) {
        writeJson(response, 400, {
          error: `mode 必须是 ${REMOTE_MODES.join(" / ")} 之一`,
        });
        return;
      }
      // enabled 省略时视为开启（兼容早期只能开启模式的客户端）；
      // 显式传入时必须是真布尔，不接受 "true" / 1 之类的宽松真值。
      if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
        writeJson(response, 400, { error: "enabled 必须是布尔值" });
        return;
      }
      const enabled = body.enabled === undefined ? true : body.enabled;
      writeJson(
        response,
        200,
        await callRenderer("setMode", [body.mode, enabled]),
      );
      return;
    }

    // 执行聊天输入框的真实指令（由 Renderer 按 createChatCommands 快照查找）。
    // Main 只做类型与长度校验，绝不接受任意 JS 或函数体。
    if (request.method === "POST" && url.pathname === "/api/command") {
      if (!isJsonRequest(request)) {
        writeJson(response, 415, {
          error: "Content-Type 必须是 application/json",
        });
        return;
      }
      const body = (await readJsonBody(request)) as { commandId?: unknown };
      if (!isBoundedString(body.commandId)) {
        writeJson(response, 400, {
          error: `commandId 必须是长度不超过 ${MAX_IDENTIFIER_LENGTH} 的非空字符串`,
        });
        return;
      }
      writeJson(
        response,
        200,
        await callRenderer("runCommand", [body.commandId]),
      );
      return;
    }

    // 会话级模型配置：模型 / API Profile / 推理强度 / Responses Fast Mode。
    // 每次请求只允许修改一项，避免多字段互相影响造成不可预期的组合。
    // 真实合法值（modelIds / apiProfileNames）由 Renderer 按快照二次校验。
    if (request.method === "POST" && url.pathname === "/api/model") {
      if (!isJsonRequest(request)) {
        writeJson(response, 415, {
          error: "Content-Type 必须是 application/json",
        });
        return;
      }
      const body = (await readJsonBody(request)) as {
        model?: unknown;
        profile?: unknown;
        thinkingStrength?: unknown;
        responsesFastMode?: unknown;
      };
      const provided = (
        ["model", "profile", "thinkingStrength", "responsesFastMode"] as const
      ).filter((key) => body[key] !== undefined);
      if (provided.length !== 1) {
        writeJson(response, 400, {
          error:
            "每次只能修改 model / profile / thinkingStrength / responsesFastMode 中的一项",
        });
        return;
      }
      const field = provided[0];
      if (field === "model") {
        if (!isBoundedString(body.model)) {
          writeJson(response, 400, {
            error: `model 必须是长度不超过 ${MAX_IDENTIFIER_LENGTH} 的非空字符串`,
          });
          return;
        }
        writeJson(response, 200, await callRenderer("setModel", [body.model]));
        return;
      }
      if (field === "profile") {
        if (!isBoundedString(body.profile)) {
          writeJson(response, 400, {
            error: `profile 必须是长度不超过 ${MAX_IDENTIFIER_LENGTH} 的非空字符串`,
          });
          return;
        }
        writeJson(
          response,
          200,
          await callRenderer("setApiProfile", [body.profile]),
        );
        return;
      }
      if (field === "thinkingStrength") {
        // 空串是合法值：表示继承 Profile 默认推理强度。
        if (!isBoundedString(body.thinkingStrength, true)) {
          writeJson(response, 400, {
            error: `thinkingStrength 必须是长度不超过 ${MAX_IDENTIFIER_LENGTH} 的字符串`,
          });
          return;
        }
        writeJson(
          response,
          200,
          await callRenderer("setThinking", [body.thinkingStrength]),
        );
        return;
      }
      if (typeof body.responsesFastMode !== "boolean") {
        writeJson(response, 400, {
          error: "responsesFastMode 必须是布尔值",
        });
        return;
      }
      writeJson(
        response,
        200,
        await callRenderer("toggleResponsesFastMode", [body.responsesFastMode]),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/select") {
      if (!isJsonRequest(request)) {
        writeJson(response, 415, {
          error: "Content-Type 必须是 application/json",
        });
        return;
      }
      const body = (await readJsonBody(request)) as {
        conversationId?: unknown;
        directoryId?: unknown;
      };
      if (
        typeof body.conversationId !== "string" ||
        (body.directoryId !== undefined && typeof body.directoryId !== "string")
      ) {
        writeJson(response, 400, { error: "会话参数无效" });
        return;
      }
      writeJson(
        response,
        200,
        await callRenderer("select", [body.conversationId, body.directoryId]),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/authorization") {
      if (!isJsonRequest(request)) {
        writeJson(response, 415, {
          error: "Content-Type 必须是 application/json",
        });
        return;
      }
      const body = (await readJsonBody(request)) as {
        authorizationId?: unknown;
        decision?: unknown;
        reason?: unknown;
      };
      if (
        typeof body.authorizationId !== "string" ||
        !["approve", "reject"].includes(String(body.decision)) ||
        (body.reason !== undefined && typeof body.reason !== "string")
      ) {
        writeJson(response, 400, { error: "授权参数无效" });
        return;
      }
      writeJson(
        response,
        200,
        body.decision === "approve"
          ? await callRenderer("approve", [body.authorizationId])
          : await callRenderer("reject", [body.authorizationId, body.reason]),
      );
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/question") {
      if (!isJsonRequest(request)) {
        writeJson(response, 415, {
          error: "Content-Type 必须是 application/json",
        });
        return;
      }
      const body = (await readJsonBody(request)) as {
        questionId?: unknown;
        action?: unknown;
        selectedOptions?: unknown;
        customAnswers?: unknown;
      };
      const selectedOptions = body.selectedOptions ?? [];
      const customAnswers = body.customAnswers ?? [];
      if (
        typeof body.questionId !== "string" ||
        !["answer", "cancel"].includes(String(body.action)) ||
        !Array.isArray(selectedOptions) ||
        !selectedOptions.every((value) => typeof value === "string") ||
        !Array.isArray(customAnswers) ||
        !customAnswers.every((value) => typeof value === "string") ||
        selectedOptions.length > 20 ||
        customAnswers.length > 20
      ) {
        writeJson(response, 400, { error: "回答参数无效" });
        return;
      }
      writeJson(
        response,
        200,
        body.action === "cancel"
          ? await callRenderer("cancelQuestion", [body.questionId])
          : await callRenderer("answer", [
              body.questionId,
              selectedOptions,
              customAnswers,
            ]),
      );
      return;
    }

    writeJson(response, 404, { error: "接口不存在" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "REQUEST_TOO_LARGE") {
      writeJson(response, 413, { error: "请求体超过 64 KiB" });
      return;
    }
    if (message === "INVALID_JSON") {
      writeJson(response, 400, { error: "JSON 格式无效" });
      return;
    }
    const attachmentErrors: Record<string, [number, string]> = {
      INVALID_ATTACHMENT_KIND: [400, "附件类型无效"],
      INVALID_ATTACHMENT_MIME: [415, "附件 Content-Type 无效"],
      UNSUPPORTED_IMAGE_TYPE: [415, "仅支持 PNG、JPEG、GIF 和 WebP 图片"],
      TOO_MANY_ATTACHMENTS: [400, "每次最多选择 4 个附件"],
      ATTACHMENT_TOO_LARGE: [413, "附件超过大小或总容量限制"],
      EMPTY_ATTACHMENT: [400, "附件不能为空"],
      IMAGE_SIGNATURE_MISMATCH: [400, "图片内容与格式不匹配"],
      IMAGE_DIMENSIONS_INVALID: [400, "无法读取图片尺寸"],
      IMAGE_TOO_LARGE: [413, "图片像素尺寸过大"],
      INVALID_ATTACHMENT_IDS: [400, "附件列表无效"],
      ATTACHMENT_NOT_AVAILABLE: [409, "附件已失效，请重新选择"],
      PAIRING_ROTATED: [401, "配对凭据已轮换，请重新配对"],
    };
    const attachmentError = attachmentErrors[message];
    if (attachmentError) {
      writeJson(response, attachmentError[0], { error: attachmentError[1] });
      return;
    }
    console.warn("[Snow Remote] Renderer 调用失败：", message);
    writeJson(response, 503, { error: "Snow 暂时无法处理该请求" });
  }
};

const createRemoteHttpServer = (
  policy: RequestPolicy,
): ReturnType<typeof createServer> => {
  const nextServer = createServer((request, response) => {
    void handleRequest(request, response, policy).catch((error) => {
      console.error(
        "[Snow Remote] 请求处理异常：",
        error instanceof Error ? error.message : String(error),
      );
      if (!response.headersSent) {
        writeJson(response, 400, { error: "请求无效" });
      } else {
        response.destroy();
      }
    });
  });
  nextServer.requestTimeout = 15_000;
  nextServer.headersTimeout = 10_000;
  nextServer.keepAliveTimeout = 5_000;
  return nextServer;
};

const listen = async (
  nextServer: ReturnType<typeof createServer>,
  port: number,
  host: string,
): Promise<number> => {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    nextServer.once("error", onError);
    nextServer.listen(port, host, () => {
      nextServer.off("error", onError);
      resolve();
    });
  });
  return (nextServer.address() as AddressInfo).port;
};

const closeHttpServer = async (
  current: ReturnType<typeof createServer> | null,
): Promise<void> => {
  if (!current) return;
  await waitForCallbackOrTimeout((done) => {
    if (!current.listening) {
      done();
      return;
    }
    current.close(done);
    current.closeIdleConnections();
    current.closeAllConnections();
  }, 3_000);
};

const queueWanLifecycle = <T>(operation: () => Promise<T>): Promise<T> => {
  const next = wanLifecycle.then(operation, operation);
  wanLifecycle = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
};

/**
 * Start or replace the loopback-only WAN listener used by a managed frpc
 * tunnel. This never changes the LAN listener or LAN token.
 */
export const startRemoteWanListener = async (
  publicOrigin: string,
  preferredPort = 0,
): Promise<RemoteControlPairingState> =>
  queueWanLifecycle(async () => {
    if (!server || !serverInfo || !activeToken) {
      throw new Error("手机遥控服务尚未启动");
    }
    if (
      wanServer &&
      wanAuth?.origin === publicOrigin.trim().replace(/\/$/, "") &&
      (preferredPort === 0 || preferredPort === wanPort)
    ) {
      return getRemoteControlPairingState();
    }

    const nextAuth = new RemoteWanAuth(publicOrigin);
    const nextWanServer = createRemoteHttpServer({
      kind: "wan",
      auth: nextAuth,
    });
    const previousServer = wanServer;
    const previousAuth = wanAuth;
    wanServer = null;
    wanAuth = null;
    wanPort = 0;
    previousAuth?.revokeAll();
    await closeHttpServer(previousServer);

    try {
      const actualPort = await listen(nextWanServer, preferredPort, WAN_HOST);
      wanServer = nextWanServer;
      wanAuth = nextAuth;
      wanPort = actualPort;
      nextAuth.issuePairing();
      console.info(
        `[Snow Remote] 公网隧道入口已在本机端口 ${actualPort} 就绪；请在设置中查看短期配对二维码。`,
      );
      return getRemoteControlPairingState();
    } catch (error) {
      await closeHttpServer(nextWanServer);
      throw error;
    }
  });

/** Stop only the WAN listener and revoke its sessions; LAN remains available. */
export const stopRemoteWanListener = async (): Promise<void> =>
  queueWanLifecycle(async () => {
    const current = wanServer;
    wanServer = null;
    wanPort = 0;
    wanAuth?.revokeAll();
    wanAuth = null;
    await closeHttpServer(current);
  });

export const startRemoteControlServer =
  async (): Promise<RemoteServerInfo | null> => {
    if (startPromise) return startPromise;
    startPromise = (async () => {
      try {
        const host = process.env.SNOW_REMOTE_HOST?.trim() || DEFAULT_HOST;
        const port = parsePort();
        const configuredToken = process.env.SNOW_REMOTE_TOKEN?.trim();
        if (configuredToken && configuredToken.length < 24) {
          throw new Error("SNOW_REMOTE_TOKEN 至少需要 24 个字符");
        }
        activeToken = configuredToken || randomBytes(24).toString("base64url");
        pairingGeneration += 1;
        const nextServer = createRemoteHttpServer({ kind: "lan" });
        const actualPort = await listen(nextServer, port, host);

        server = nextServer;
        const hosts = host === "0.0.0.0" ? getLanAddresses() : [host];
        const pairingUrls = hosts.map(
          (address) => `http://${address}:${actualPort}/?token=${activeToken}`,
        );
        serverInfo = { host, port: actualPort, pairingUrls };

        const publicOrigin = process.env.SNOW_REMOTE_PUBLIC_ORIGIN?.trim();
        if (publicOrigin) {
          try {
            await startRemoteWanListener(publicOrigin, parseWanPort());
          } catch (error) {
            // WAN is optional. A bad public/tunnel configuration must never
            // tear down the already-running LAN remote-control listener.
            console.warn(
              "[Snow Remote] 公网入口启动失败，局域网远控保持运行：",
              error instanceof Error ? error.message : String(error),
            );
          }
        }
        console.info(
          `[Snow Remote] 手机遥控已启动，端口 ${actualPort}；请在设置中查看配对二维码。`,
        );
        return serverInfo;
      } catch (error) {
        console.error(
          "[Snow Remote] 启动失败，Snow 主应用将继续运行：",
          error instanceof Error ? error.message : String(error),
        );
        const failedLanServer = server;
        server = null;
        serverInfo = null;
        failedLanServer?.close();
        failedLanServer?.closeIdleConnections();
        failedLanServer?.closeAllConnections();
        wanServer?.close();
        wanServer?.closeIdleConnections();
        wanServer?.closeAllConnections();
        wanServer = null;
        wanAuth = null;
        wanPort = 0;
        activeToken = "";
        startPromise = null;
        return null;
      }
    })();
    return startPromise;
  };

export const stopRemoteControlServer = async (): Promise<void> => {
  const current = server;
  server = null;
  serverInfo = null;
  activeToken = "";
  pairingGeneration += 1;
  completedSendRequests.clear();
  await invalidateRemoteAttachments();
  startPromise = null;
  await Promise.all([closeHttpServer(current), stopRemoteWanListener()]);
};

export type RemoteControlPairingState = {
  running: boolean;
  host: string;
  port: number;
  pairingUrls: string[];
  generation: number;
  wan: {
    enabled: boolean;
    localPort: number;
    publicOrigin: string;
    pairingUrl: string;
    pairingExpiresAt: number | null;
  };
};

export const getRemoteControlPairingState = (): RemoteControlPairingState => ({
  running: Boolean(server && serverInfo && activeToken),
  host: serverInfo?.host ?? "",
  port: serverInfo?.port ?? 0,
  pairingUrls:
    serverInfo && activeToken
      ? (serverInfo.host === "0.0.0.0"
          ? getLanAddresses()
          : [serverInfo.host]
        ).map(
          (address) =>
            `http://${address}:${serverInfo!.port}/?token=${activeToken}`,
        )
      : [],
  generation: pairingGeneration,
  wan: (() => {
    const pairing = wanAuth
      ? (wanAuth.currentPairing() ?? wanAuth.issuePairing())
      : null;
    return {
      enabled: Boolean(wanServer && wanAuth),
      localPort: wanPort,
      publicOrigin: wanAuth?.origin ?? "",
      pairingUrl: pairing?.url ?? "",
      pairingExpiresAt: pairing?.expiresAt ?? null,
    };
  })(),
});

export const rotateRemoteControlToken =
  async (): Promise<RemoteControlPairingState> => {
    if (!serverInfo) throw new Error("手机遥控服务尚未启动");
    await waitForSendIdle();
    if (!serverInfo) throw new Error("手机遥控服务尚未启动");
    activeToken = randomBytes(24).toString("base64url");
    wanAuth?.revokeAll();
    wanAuth?.issuePairing();
    pairingGeneration += 1;
    completedSendRequests.clear();
    await invalidateRemoteAttachments();
    const hosts =
      serverInfo.host === "0.0.0.0" ? getLanAddresses() : [serverInfo.host];
    serverInfo = {
      ...serverInfo,
      pairingUrls: hosts.map(
        (address) =>
          `http://${address}:${serverInfo!.port}/?token=${activeToken}`,
      ),
    };
    return getRemoteControlPairingState();
  };
