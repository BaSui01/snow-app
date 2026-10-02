import type { BrowserFramesResult } from "../../preload/types/browser";
import { ipcMain, type WebContents, type WebFrameMain } from "electron";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  getBrowserWebContents,
  ensureWebContentsDebugger,
} from "../ipc/handlers/browserNetworkRecorder";
import { buildElementLocatorScript } from "../../shared/browserElementLocator";
import { serializeAxTree, type AxNode } from "../../shared/browserAxSnapshot";
import {
  redactBrowserResult,
  redactBrowserText,
  redactBrowserUrl,
} from "../../shared/browserRedaction";

type Args = Record<string, unknown>;
type FrameEntry = {
  id: string;
  frame: WebFrameMain;
  marker: string;
  refs: Map<string, number>;
};
type State = { entries: Map<string, FrameEntry>; tail: Promise<unknown> };
type CdpFrame = { frameId: string; contextId: number; sessionId?: string };
type FrameTree = { frame: { id: string }; childFrames?: FrameTree[] };
const states = new Map<number, State>();
const frameOperations = new Set([
  "frames",
  "evaluate",
  "get_tab_content",
  "wait",
  "click",
  "hover",
  "type",
  "select_option",
  "upload-file",
  "devtools",
]);
const bounded = (
  args: Args,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number => {
  const value = args[key] ?? fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error(`Invalid ${key}`);
  return value;
};
const stateFor = (contents: WebContents): State => {
  let state = states.get(contents.id);
  if (!state) {
    state = { entries: new Map(), tail: Promise.resolve() };
    states.set(contents.id, state);
    contents.once("destroyed", () => states.delete(contents.id));
  }
  return state;
};
const alive = (contents: WebContents, entry: FrameEntry): void => {
  if (
    contents.isDestroyed() ||
    entry.frame.isDestroyed() ||
    entry.frame.detached ||
    !contents.mainFrame.framesInSubtree.includes(entry.frame)
  )
    throw new Error(
      "FRAME_STALE: frame was detached or replaced; enumerate frames again",
    );
};
const rawExecute = async (
  frame: WebFrameMain,
  script: string,
  userGesture = false,
): Promise<unknown> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      frame.executeJavaScript(script, userGesture),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                "FRAME_EXECUTION_TIMEOUT: execution did not finish within 30 seconds",
              ),
            ),
          30000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
const execute = async (
  contents: WebContents,
  entry: FrameEntry,
  script: string,
): Promise<unknown> => {
  alive(contents, entry);
  return rawExecute(
    entry.frame,
    `(async () => {
    if (globalThis[${JSON.stringify(entry.marker)}] !== document) throw new Error('FRAME_STALE: document was replaced; enumerate frames again');
    return await (${script});
  })()`,
  );
};
const entryFor = async (
  contents: WebContents,
  frame: WebFrameMain,
): Promise<FrameEntry> => {
  const state = stateFor(contents);
  for (const entry of state.entries.values()) {
    if (entry.frame !== frame) continue;
    try {
      if (await execute(contents, entry, "true")) return entry;
    } catch {
      state.entries.delete(entry.id);
    }
  }
  if (frame.isDestroyed() || frame.detached)
    throw new Error("FRAME_STALE: frame is no longer attached");
  const id = `frame-${randomUUID()}`;
  const marker = `__snow_document_${randomUUID().replaceAll("-", "")}`;
  await rawExecute(
    frame,
    `Object.defineProperty(globalThis, ${JSON.stringify(marker)}, { value: document, configurable: true }); true`,
  );
  const entry: FrameEntry = { id, frame, marker, refs: new Map() };
  state.entries.set(id, entry);
  // Expired documents are pruned during enumeration, and the guest owns all remaining state.
  if (state.entries.size > 512) {
    const oldest = state.entries.keys().next().value;
    if (oldest) state.entries.delete(oldest);
  }
  return entry;
};
const selectFrame = async (
  contents: WebContents,
  frameId: unknown,
): Promise<FrameEntry> => {
  if (frameId === undefined || frameId === null)
    return entryFor(contents, contents.mainFrame);
  if (typeof frameId !== "string" || !/^frame-[0-9a-f-]{36}$/.test(frameId))
    throw new Error("Invalid frameId; use browser-frames");
  const entry = stateFor(contents).entries.get(frameId);
  if (!entry)
    throw new Error(
      "FRAME_STALE: unknown frameId for this browser; enumerate frames again",
    );
  await execute(contents, entry, "true");
  return entry;
};
const enumerate = async (
  contents: WebContents,
): Promise<BrowserFramesResult> => {
  const frames = contents.mainFrame.framesInSubtree;
  const state = stateFor(contents);
  for (const [id, entry] of state.entries) {
    if (
      !frames.includes(entry.frame) ||
      entry.frame.isDestroyed() ||
      entry.frame.detached
    )
      state.entries.delete(id);
  }
  const entries = new Map<WebFrameMain, FrameEntry>();
  const unavailable: { frameTreeNodeId: number; error: string }[] = [];
  for (const frame of frames) {
    try {
      entries.set(frame, await entryFor(contents, frame));
    } catch {
      unavailable.push({
        frameTreeNodeId: frame.frameTreeNodeId,
        error: "Frame unavailable during enumeration",
      });
    }
  }
  return {
    frames: [...entries.values()].map((entry) => ({
      frameId: entry.id,
      parentFrameId: entry.frame.parent
        ? (entries.get(entry.frame.parent)?.id ?? null)
        : null,
      isMainFrame: entry.frame === contents.mainFrame,
      url: redactBrowserUrl(entry.frame.url),
      name: redactBrowserText(entry.frame.name),
    })),
    unavailable,
  };
};

/** Map only frames descended from this guest. A temporary DOM marker correlates isolated CDP worlds
 * to WebFrameMain without inspecting URLs, cookies or storage. OOPIF sessions are per operation. */
const withCdpFrame = async <T>(
  contents: WebContents,
  entry: FrameEntry,
  action: (target: CdpFrame) => Promise<T>,
): Promise<T> => {
  await ensureWebContentsDebugger(contents);
  if (!contents.debugger.isAttached())
    throw new Error("FRAME_CDP_UNAVAILABLE: close page DevTools and retry");
  const attribute = `data-snow-frame-${randomUUID()}`;
  const sessions: string[] = [];
  const objectGroup = `snow-frame-${randomUUID()}`;
  await execute(
    contents,
    entry,
    `(() => { if (!document.documentElement) throw new Error('Frame document is not ready'); document.documentElement.setAttribute(${JSON.stringify(attribute)}, '1'); return true; })()`,
  );
  const command = (
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<any> => contents.debugger.sendCommand(method, params, sessionId);
  try {
    const queue: (string | undefined)[] = [undefined];
    const seenFrames = new Set<string>();
    for (let index = 0; index < queue.length && index < 256; index++) {
      const sessionId = queue[index];
      const tree = (await command("Page.getFrameTree", {}, sessionId)) as {
        frameTree: FrameTree;
      };
      const list: FrameTree[] = [];
      const walk = (node: FrameTree): void => {
        list.push(node);
        for (const child of node.childFrames ?? []) walk(child);
      };
      walk(tree.frameTree);
      for (const node of list) {
        let matched: CdpFrame | undefined;
        try {
          const world = await command(
            "Page.createIsolatedWorld",
            {
              frameId: node.frame.id,
              worldName: "snow-frame-tools",
              grantUniveralAccess: false,
            },
            sessionId,
          );
          if (typeof world.executionContextId !== "number")
            throw new Error("Frame context unavailable");
          const probe = await command(
            "Runtime.evaluate",
            {
              contextId: world.executionContextId,
              expression: `document.documentElement?.getAttribute(${JSON.stringify(attribute)}) === '1'`,
              returnByValue: true,
              objectGroup,
            },
            sessionId,
          );
          if (!probe.exceptionDetails && probe.result?.value === true)
            matched = {
              frameId: node.frame.id,
              contextId: world.executionContextId,
              sessionId,
            };
        } catch {
          // Discovery may require the OOPIF's own session; action errors are never swallowed.
        }
        if (matched) {
          await execute(contents, entry, "true");
          return await action(matched);
        }
        if (
          node.frame.id !== tree.frameTree.frame.id &&
          !seenFrames.has(node.frame.id)
        ) {
          seenFrames.add(node.frame.id);
          try {
            const attached = await command("Target.attachToTarget", {
              targetId: node.frame.id,
              flatten: true,
            });
            if (typeof attached.sessionId === "string") {
              sessions.push(attached.sessionId);
              queue.push(attached.sessionId);
            }
          } catch {
            /* Same-process frames have no standalone Target. */
          }
        }
      }
    }
    throw new Error(
      "FRAME_CDP_UNAVAILABLE: no isolated CDP context matched this frame; no main-frame fallback",
    );
  } finally {
    await execute(
      contents,
      entry,
      `(() => { document.documentElement?.removeAttribute(${JSON.stringify(attribute)}); return true; })()`,
    ).catch(() => {});
    for (const sessionId of [undefined, ...sessions])
      await command(
        "Runtime.releaseObjectGroup",
        { objectGroup },
        sessionId,
      ).catch(() => {});
    for (const sessionId of sessions.reverse())
      await command("Target.detachFromTarget", { sessionId }).catch(() => {});
  }
};
const elementHandle = async (
  contents: WebContents,
  entry: FrameEntry,
  target: CdpFrame,
  args: Args,
): Promise<string> => {
  const send = (
    method: string,
    params: Record<string, unknown>,
  ): Promise<any> =>
    contents.debugger.sendCommand(method, params, target.sessionId);
  if (typeof args.ref === "string") {
    const backend = entry.refs.get(args.ref);
    if (backend === undefined)
      throw new Error(
        "FRAME_REF_STALE: ref belongs to another frame/document/snapshot; capture AX again",
      );
    const resolved = await send("DOM.resolveNode", {
      backendNodeId: backend,
      executionContextId: target.contextId,
    });
    if (!resolved.object?.objectId)
      throw new Error("FRAME_REF_STALE: element no longer exists");
    const membership = await send("Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration:
        "function() { return this.ownerDocument === document && this.isConnected; }",
      returnByValue: true,
    });
    if (membership.result?.value !== true)
      throw new Error(
        "FRAME_REF_STALE: element is outside the selected document",
      );
    return resolved.object.objectId;
  }
  const script = buildElementLocatorScript(
    typeof args.selector === "string" ? args.selector : null,
    typeof args.text === "string" ? args.text : null,
    args.exact === true,
    "return element;",
  );
  const result = await send("Runtime.evaluate", {
    expression: script,
    contextId: target.contextId,
    awaitPromise: true,
    returnByValue: false,
  });
  if (result.exceptionDetails || !result.result?.objectId)
    throw new Error("Frame target element was not found or is not actionable");
  return result.result.objectId;
};
const withElement = async <T>(
  contents: WebContents,
  entry: FrameEntry,
  args: Args,
  action: (target: CdpFrame, objectId: string) => Promise<T>,
): Promise<T> =>
  withCdpFrame(contents, entry, async (target) => {
    const objectId = await elementHandle(contents, entry, target, args);
    try {
      const prepared = (await contents.debugger.sendCommand(
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: `function() {
        if (!this.isConnected || this.ownerDocument !== document || !(this instanceof Element) || this.matches(':disabled,[aria-disabled="true"]')) throw new Error('Element is stale or disabled');
        this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        return true;
      }`,
          returnByValue: true,
        },
        target.sessionId,
      )) as { exceptionDetails?: unknown };
      if (prepared.exceptionDetails)
        throw new Error("Frame target element is stale or disabled");
      await execute(contents, entry, "true");
      return await action(target, objectId);
    } finally {
      await contents.debugger
        .sendCommand("Runtime.releaseObject", { objectId }, target.sessionId)
        .catch(() => {});
    }
  });

/** Translate frame-local coordinates through each parent document; reject unsupported transforms
 * rather than sending an approximate event to another element. No cross-origin DOM access is used. */
const rootPointerPoint = async (
  contents: WebContents,
  entry: FrameEntry,
  target: CdpFrame,
  objectId: string,
): Promise<{ x: number; y: number }> => {
  const local = (await contents.debugger.sendCommand(
    "Runtime.callFunctionOn",
    {
      objectId,
      returnByValue: true,
      functionDeclaration: `function() {
      const style = getComputedStyle(this);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) throw new Error('Element is hidden');
      const rect = Array.from(this.getClientRects()).find(rect => rect.width > 0 && rect.height > 0);
      if (!rect) throw new Error('Element has no layout');
      const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
      const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
      if (right <= left || bottom <= top) throw new Error('Element is outside the viewport');
      const x = (left + right) / 2, y = (top + bottom) / 2;
      let hit = document.elementFromPoint(x, y);
      while (hit?.shadowRoot?.elementFromPoint) { const next = hit.shadowRoot.elementFromPoint(x, y); if (!next || next === hit) break; hit = next; }
      let node = this;
      while (node && node !== hit && !node.contains(hit)) node = node.getRootNode()?.host;
      if (!node) throw new Error('Element is obscured');
      return { x, y };
    }`,
    },
    target.sessionId,
  )) as {
    result?: { value?: { x: number; y: number } };
    exceptionDetails?: unknown;
  };
  if (local.exceptionDetails || !local.result?.value)
    throw new Error(
      "Frame element is hidden, obscured or outside the viewport",
    );
  let point = local.result.value;
  let childFrame = entry.frame;
  let childProtocolId = target.frameId;
  while (childFrame.parent) {
    const parent = childFrame.parent;
    const parentEntry = await entryFor(contents, parent);
    const translated = await withCdpFrame(
      contents,
      parentEntry,
      async (parentTarget) => {
        const owner = (await contents.debugger.sendCommand(
          "DOM.getFrameOwner",
          { frameId: childProtocolId },
          parentTarget.sessionId,
        )) as { backendNodeId?: number };
        if (!owner.backendNodeId)
          throw new Error("FRAME_STALE: frame owner is unavailable");
        const resolved = (await contents.debugger.sendCommand(
          "DOM.resolveNode",
          {
            backendNodeId: owner.backendNodeId,
            executionContextId: parentTarget.contextId,
          },
          parentTarget.sessionId,
        )) as { object?: { objectId?: string } };
        const ownerId = resolved.object?.objectId;
        if (!ownerId)
          throw new Error("FRAME_STALE: frame owner is unavailable");
        try {
          const mapped = (await contents.debugger.sendCommand(
            "Runtime.callFunctionOn",
            {
              objectId: ownerId,
              returnByValue: true,
              functionDeclaration: `function(x, y) {
            if (!this.isConnected || this.ownerDocument !== document) throw new Error('Frame owner is stale');
            this.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
            for (let node = this; node instanceof Element; node = node.parentElement || node.getRootNode().host) {
              const style = getComputedStyle(node);
              if (style.perspective !== 'none' || style.rotate !== 'none' || style.scale !== 'none') throw new Error('Perspective or individual rotate/scale transforms are unsupported');
              if (style.transform !== 'none') {
                const matrix = new DOMMatrixReadOnly(style.transform);
                if (!matrix.is2D || matrix.b !== 0 || matrix.c !== 0 || matrix.a <= 0 || matrix.d <= 0) throw new Error('Rotated, skewed or mirrored frames are unsupported');
              }
            }
            const rect = this.getBoundingClientRect();
            if (!this.offsetWidth || !this.offsetHeight || rect.width <= 0 || rect.height <= 0) throw new Error('Frame is hidden');
            const style = getComputedStyle(this);
            const sx = rect.width / this.offsetWidth, sy = rect.height / this.offsetHeight;
            const px = rect.left + (this.clientLeft + parseFloat(style.paddingLeft) + x) * sx;
            const py = rect.top + (this.clientTop + parseFloat(style.paddingTop) + y) * sy;
            let hit = document.elementFromPoint(px, py);
            while (hit?.shadowRoot?.elementFromPoint) { const next = hit.shadowRoot.elementFromPoint(px, py); if (!next || next === hit) break; hit = next; }
            if (px < 0 || py < 0 || px >= innerWidth || py >= innerHeight || hit !== this) throw new Error('Frame is clipped or obscured');
            return { x: px, y: py };
          }`,
              arguments: [{ value: point.x }, { value: point.y }],
            },
            parentTarget.sessionId,
          )) as {
            result?: { value?: { x: number; y: number } };
            exceptionDetails?: unknown;
          };
          if (mapped.exceptionDetails || !mapped.result?.value)
            throw new Error(
              "Frame pointer mapping failed: hidden/obscured frame or unsupported rotation/skew/perspective",
            );
          return { point: mapped.result.value, frameId: parentTarget.frameId };
        } finally {
          await contents.debugger
            .sendCommand(
              "Runtime.releaseObject",
              { objectId: ownerId },
              parentTarget.sessionId,
            )
            .catch(() => {});
        }
      },
    );
    point = translated.point;
    childProtocolId = translated.frameId;
    childFrame = parent;
  }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y))
    throw new Error("Invalid frame pointer coordinates");
  await execute(contents, entry, "true");
  return point;
};
const perform = async (
  contents: WebContents,
  entry: FrameEntry,
  operation: string,
  args: Args,
): Promise<unknown> => {
  const metadata = {
    frameId: entry.id,
    url: redactBrowserUrl(entry.frame.url),
    title: await execute(contents, entry, "String(document.title || '')"),
  };
  if (operation === "evaluate") {
    if (typeof args.expression !== "string" || !args.expression.trim())
      throw new Error("expression is required");
    if (
      /cookie|localStorage|sessionStorage|indexedDB|authorization|password|secret|token/i.test(
        args.expression,
      )
    )
      throw new Error(
        "Credential/storage access is not allowed in frame evaluation",
      );
    return {
      ...metadata,
      result: await execute(contents, entry, args.expression),
    };
  }
  if (
    operation === "get_tab_content" ||
    (operation === "devtools" &&
      (args.action === undefined || args.action === "snapshot"))
  ) {
    const maxLength = bounded(
      args,
      operation === "get_tab_content" ? "maxLength" : "maxContentLength",
      20000,
      1000,
      100000,
    );
    const result = await execute(
      contents,
      entry,
      `(() => ({ title: document.title, content: String(document.body?.innerText || '').slice(0, ${maxLength}) }))()`,
    );
    return { ...metadata, ...(result as object) };
  }
  if (operation === "wait") {
    const conditions = ["text", "textGone", "selector", "selectorGone"].filter(
      (key) => typeof args[key] === "string" && args[key],
    );
    const fixed = args.time !== undefined && args.time !== null;
    if ((fixed && conditions.length) || (!fixed && !conditions.length))
      throw new Error(
        "wait requires time or text/selector conditions, not both",
      );
    const timeout = fixed
      ? bounded(args, "time", 100, 100, 30000)
      : bounded(args, "timeoutMs", 30000, 1000, 120000);
    const start = Date.now();
    while (true) {
      const satisfied = await execute(
        contents,
        entry,
        `(() => { const args = ${JSON.stringify(args)};
        const text = String(document.body?.innerText || '');
        return ${JSON.stringify(conditions)}.every(key => key === 'text' ? text.includes(args[key]) : key === 'textGone' ? !text.includes(args[key]) : key === 'selector' ? !!document.querySelector(args[key]) : !document.querySelector(args[key]));
      })()`,
      );
      if ((!fixed && satisfied) || (fixed && Date.now() - start >= timeout))
        return { ...metadata, success: true, waitedMs: Date.now() - start };
      if (Date.now() - start >= timeout)
        return {
          ...metadata,
          success: false,
          error: "Frame wait timed out",
          waitedMs: Date.now() - start,
        };
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(100, timeout - (Date.now() - start))),
      );
    }
  }
  if (operation === "devtools") {
    if (args.action !== "ax")
      throw new Error("frameId is supported only for devtools snapshot/ax");
    return withCdpFrame(contents, entry, async (target) => {
      const result = (await contents.debugger.sendCommand(
        "Accessibility.getFullAXTree",
        { frameId: target.frameId },
        target.sessionId,
      )) as { nodes?: AxNode[] };
      entry.refs.clear();
      const nodes = (result.nodes ?? []).map((node) => ({
        ...node,
        value: undefined,
      }));
      const snapshot = serializeAxTree(nodes, {
        verbose: args.verbose === true,
        maxNodes: bounded(args, "maxNodes", 200, 1, 1000),
        refForNode: (node) => {
          if (
            !node.backendDOMNodeId ||
            (node.frameId && node.frameId !== target.frameId)
          )
            return null;
          const ref = `fr-${randomUUID()}`;
          entry.refs.set(ref, node.backendDOMNodeId);
          return ref;
        },
      });
      return { ...metadata, ...snapshot, valuesRedacted: true };
    });
  }
  return withElement(contents, entry, args, async (target, objectId) => {
    const send = (
      method: string,
      params: Record<string, unknown>,
    ): Promise<any> =>
      contents.debugger.sendCommand(method, params, target.sessionId);
    const locate = async (body: string): Promise<unknown> => {
      await execute(contents, entry, "true");
      const result = await send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `async function() { const element = this; if (!element.isConnected || element.ownerDocument !== document) throw new Error('Element is stale'); ${body} }`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails)
        throw new Error(
          "Frame element operation failed: target is stale or does not support this action",
        );
      return result.result?.value;
    };
    if (operation === "upload-file") {
      if (
        !Array.isArray(args.files) ||
        !args.files.length ||
        args.files.some((file) => typeof file !== "string" || !isAbsolute(file))
      )
        throw new Error("files must be non-empty absolute paths");
      for (const file of args.files as string[])
        if (!(await stat(file)).isFile())
          throw new Error("Upload path is not a regular file");
      await locate(
        `if (element.tagName !== 'INPUT' || element.type !== 'file') throw new Error('Target is not a file input'); if (${args.files.length} > 1 && !element.multiple) throw new Error('File input does not accept multiple files'); return true;`,
      );
      await send("DOM.setFileInputFiles", { objectId, files: args.files });
      return { ...metadata, success: true, fileCount: args.files.length };
    }
    if (operation === "click" || operation === "hover") {
      const { x, y } = await rootPointerPoint(
        contents,
        entry,
        target,
        objectId,
      );
      contents.focus();
      const pointer = (params: Record<string, unknown>): Promise<unknown> =>
        contents.debugger.sendCommand("Input.dispatchMouseEvent", params);
      await pointer({ type: "mouseMoved", x, y });
      if (operation === "click") {
        await pointer({
          type: "mousePressed",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
        await pointer({
          type: "mouseReleased",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
      }
      return { ...metadata, success: true };
    }
    if (operation === "select_option") {
      if (
        !Array.isArray(args.values) ||
        !args.values.length ||
        args.values.some((value) => typeof value !== "string")
      )
        throw new Error("values must be a non-empty string array");
      const selected =
        await locate(`if (element.tagName !== 'SELECT') throw new Error('Target is not a select');
        const values = ${JSON.stringify(args.values)};
        if (!element.multiple && values.length > 1) throw new Error('Target is not a multiple select');
        const options = values.map(value => Array.from(element.options).find(option => option.value === value || option.label === value));
        if (options.some(option => !option || option.disabled)) throw new Error('Option is unavailable');
        for (const option of element.options) option.selected = options.includes(option);
        element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true }));
        return Array.from(element.selectedOptions).map(option => option.value);`);
      return { ...metadata, success: true, selected };
    }
    if (operation === "type") {
      if (typeof args.value !== "string")
        throw new Error("value must be a string");
      const delay = bounded(args, "delayMs", 0, 0, 1000);
      contents.focus();
      await locate(`element.focus();
        if (!element.isContentEditable && !['INPUT','TEXTAREA'].includes(element.tagName)) throw new Error('Target is not editable');
        if (element.readOnly) throw new Error('Target is readonly');
        if (element.isContentEditable) {
          element.textContent = '';
          const range = document.createRange(); range.selectNodeContents(element); range.collapse(false);
          const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        } else {
          const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, '');
        }
        element.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
      const values = delay ? [...args.value] : [args.value];
      if (delay && values.length * delay > 120000)
        throw new Error("Frame typing would exceed the operation timeout");
      for (const text of values) {
        await locate(
          "const root = element.getRootNode(); if (root.activeElement !== element && !element.contains(root.activeElement)) throw new Error('Target lost focus'); return true;",
        );
        if (delay) {
          await contents.debugger.sendCommand("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: text,
            text,
          });
          await contents.debugger.sendCommand("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: text,
          });
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          await contents.debugger.sendCommand("Input.insertText", { text });
        }
      }
      await locate(
        `element.dispatchEvent(new Event('change', { bubbles: true })); ${args.submit === true ? "if (element.form) element.form.requestSubmit();" : ""} return true;`,
      );
      return { ...metadata, success: true };
    }
    throw new Error("Unsupported frame operation");
  });
};
export const registerBrowserFrameHandlers = (): void => {
  ipcMain.handle(
    "browser:frame-operation",
    async (
      event,
      webContentsId: unknown,
      operation: unknown,
      args: unknown,
    ) => {
      try {
        if (
          typeof webContentsId !== "number" ||
          typeof operation !== "string" ||
          !frameOperations.has(operation) ||
          !args ||
          typeof args !== "object" ||
          Array.isArray(args)
        )
          throw new Error("Invalid frame operation arguments");
        const contents = getBrowserWebContents(webContentsId);
        if (
          contents.hostWebContents?.id !== event.sender.id ||
          event.senderFrame !== event.sender.mainFrame
        )
          throw new Error("Frame operation is not owned by this renderer");
        const state = stateFor(contents);
        const parameters = args as Args;
        const task = state.tail
          .catch(() => {})
          .then(async () => {
            if (operation === "frames") return enumerate(contents);
            const entry = await selectFrame(contents, parameters.frameId);
            return perform(contents, entry, operation, parameters);
          });
        state.tail = task.catch(() => {});
        return redactBrowserResult({
          instanceId: parameters.instanceId,
          ...((await task) as object),
        });
      } catch (error) {
        throw new Error(
          redactBrowserText(
            error instanceof Error ? error.message : "Frame operation failed",
          ),
        );
      }
    },
  );
};
