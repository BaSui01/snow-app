import {
  buildElementLocatorScript,
  DESCRIBE_ELEMENT_SCRIPT,
} from "../../../../shared/browserElementLocator";
import {
  resolveAxRef,
  serializeAxTree,
  type AxNode,
} from "./browserAxSnapshot";
import type { BrowserMcpCommandArgs } from "./browserMcpController";

const TEXT_PREVIEW_LENGTH = 160;

// 公共元素描述函数片段（normalize + describe）。定位脚本、fill 脚本与
// CDP callFunctionOn 复用。注意：const 在同一作用域重复声明会抛
// SyntaxError，因此每个脚本作用域只能注入一次。

// 路由 mock 规则(渲染进程侧累积,route 追加/覆盖,routeClear 清空;提交给主进程 Fetch 拦截)。
// 按实例隔离:每个浏览器实例维护自己的规则,实例卸载时由
// clearBrowserRouteRulesForInstance 清理,避免跨实例残留/误提交。
type BrowserRouteRule = {
  pattern: string;
  status?: number;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
};

const browserRouteRulesByInstance = new Map<string, BrowserRouteRule[]>();

/** 实例卸载时清理其累积的路由规则,防止残留规则影响其他实例。 */
export const clearBrowserRouteRulesForInstance = (instanceId: string): void => {
  browserRouteRulesByInstance.delete(instanceId);
};

/**
 * 每个浏览器实例（= 右侧面板一个浏览器 tab）最近一次主 Frame 导航状态。
 *
 * 主 Frame 导航失败后 Chromium 会停留在 chrome-error://chromewebdata/
 * 错误页，此时 capturePage 仍能返回全黑 PNG。Screenshot 等操作在捕获前
 * 检查该状态，失败时直接返回原导航错误，避免把错误页图片当作正常结果。
 * 状态以 instanceId 为 key 隔离，实例（tab）关闭时清理。
 */
type MainFrameNavigationState =
  | { status: "success"; url: string }
  | {
      status: "failed";
      url: string;
      errorCode?: number;
      errorDescription: string;
    };

const mainFrameNavigationStates = new Map<string, MainFrameNavigationState>();

/** 主 Frame 导航成功（含页面内导航、重定向目标加载）后记录并清除失败状态。 */
export const recordMainFrameNavigationSuccess = (
  instanceId: string,
  url: string,
): void => {
  mainFrameNavigationStates.set(instanceId, { status: "success", url });
};

/** 主 Frame 导航失败时记录，供 screenshot 等操作拒绝执行。 */
export const recordMainFrameNavigationFailure = (
  instanceId: string,
  url: string,
  errorCode: number | undefined,
  errorDescription: string,
): void => {
  mainFrameNavigationStates.set(instanceId, {
    status: "failed",
    url,
    ...(errorCode !== undefined ? { errorCode } : {}),
    errorDescription,
  });
};

/** 实例（tab）关闭或卸载时清理对应状态，避免跨实例残留。 */
export const clearBrowserNavigationState = (instanceId: string): void => {
  mainFrameNavigationStates.delete(instanceId);
};

const getMainFrameNavigationState = (
  instanceId: string | undefined,
): MainFrameNavigationState | undefined =>
  instanceId ? mainFrameNavigationStates.get(instanceId) : undefined;

// Electron webview console-message level: 0=verbose, 1=info, 2=warning, 3=error.
const CONSOLE_LEVEL_MIN: Record<string, number> = {
  verbose: 0,
  info: 1,
  warning: 2,
  error: 3,
};

const requiredString = (args: BrowserMcpCommandArgs, field: string): string => {
  const value = args[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
};

/**
 * 无障碍快照 ref 回指：uid → backendDOMNodeId → DOM.resolveNode → callFunctionOn
 * 取元素中心坐标与可见性（页面上下文执行）。返回 objectId 供 type 复用。
 */
const resolveRefHandle = async (
  webview: Electron.WebviewTag,
  webContentsId: number,
  ref: string,
): Promise<{
  objectId: string;
  info: {
    x: number;
    y: number;
    visible: boolean;
    tag: string;
    viewportW: number;
    viewportH: number;
  };
}> => {
  const backend = resolveAxRef(ref);
  if (backend === null) {
    throw new Error(
      `Ref ${ref} is not in the current snapshot. Capture a new accessibility snapshot (browser-devtools action=ax) first.`,
    );
  }
  const resolved = (await window.snow.browserCdpCommand(
    webContentsId,
    "DOM.resolveNode",
    { backendNodeId: backend },
  )) as { object?: { objectId?: string } };
  const objectId = resolved?.object?.objectId;
  if (!objectId) {
    throw new Error(
      `Element for ref ${ref} no longer exists in the DOM. Capture a new accessibility snapshot.`,
    );
  }
  const called = (await window.snow.browserCdpCommand(
    webContentsId,
    "Runtime.callFunctionOn",
    {
      objectId,
      functionDeclaration: `function() {
        // 视口外元素自动滚入可视区（selector/text 定位路径已内置
        // scrollIntoView，这里对齐行为，避免 "outside the viewport" 误报）。
        try {
          this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        } catch {
          // 非布局元素（如 SVG 内部节点）可能不支持 scrollIntoView，忽略。
        }
        const r = this.getBoundingClientRect();
        const style = getComputedStyle(this);
        return {
          x: Math.round(r.left + r.width / 2),
          y: Math.round(r.top + r.height / 2),
          visible: r.width > 0 && r.height > 0 &&
            style.visibility !== 'hidden' && style.display !== 'none',
          tag: this.tagName ? this.tagName.toLowerCase() : '',
          viewportW: window.innerWidth,
          viewportH: window.innerHeight,
        };
      }`,
      returnByValue: true,
    },
  )) as {
    result?: {
      value?: {
        x?: number;
        y?: number;
        visible?: boolean;
        tag?: string;
        viewportW?: number;
        viewportH?: number;
      };
    };
  };
  const info = called?.result?.value;
  if (!info || !info.visible) {
    throw new Error(`Element for ref ${ref} is not visible on the page.`);
  }
  if (
    typeof info.x !== "number" ||
    typeof info.y !== "number" ||
    info.x < 0 ||
    info.y < 0 ||
    info.x >= (info.viewportW ?? 0) ||
    info.y >= (info.viewportH ?? 0)
  ) {
    throw new Error(
      `Element for ref ${ref} is outside the browser viewport; scroll to it first.`,
    );
  }
  return {
    objectId,
    info: {
      x: info.x,
      y: info.y,
      visible: true,
      tag: info.tag ?? "",
      viewportW: info.viewportW ?? 0,
      viewportH: info.viewportH ?? 0,
    },
  };
};

const requiredRawString = (
  args: BrowserMcpCommandArgs,
  field: string,
): string => {
  const value = args[field];
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  return value;
};

const optionalString = (
  args: BrowserMcpCommandArgs,
  field: string,
): string | undefined => {
  const value = args[field];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string when provided`);
  }
  return value.trim();
};

const currentPageMetadata = async (
  webview: Electron.WebviewTag,
  instanceId: string,
): Promise<{ instanceId: string; url: string; title: string }> => ({
  instanceId,
  url: webview.getURL(),
  title: await webview.executeJavaScript("document.title || ''"),
});

/** 等待一次加载完成（did-stop-loading）；trigger 触发导航/重载。 */
const waitForLoad = (
  webview: Electron.WebviewTag,
  timeoutMs: number,
  trigger: () => void | Promise<unknown>,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    let sawSuccessfulNavigation = false;
    const handleNavigate = (): void => {
      sawSuccessfulNavigation = true;
    };
    const handleStop = (): void => {
      cleanup();
      resolve();
    };
    const handleFail = (
      event: Event & {
        errorCode?: number;
        errorDescription?: string;
        validatedURL?: string;
        isMainFrame?: boolean;
      },
    ): void => {
      if (event.isMainFrame === false) {
        return;
      }
      if (
        event.errorCode === -3 ||
        (event.errorCode === -2 && sawSuccessfulNavigation)
      ) {
        return;
      }
      cleanup();
      reject(
        new Error(
          event.errorDescription ||
            `Failed to load ${event.validatedURL || "the target page"}`,
        ),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Browser load timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      webview.removeEventListener(
        "did-navigate",
        handleNavigate as EventListener,
      );
      webview.removeEventListener(
        "did-navigate-in-page",
        handleNavigate as EventListener,
      );
      webview.removeEventListener(
        "did-stop-loading",
        handleStop as EventListener,
      );
      webview.removeEventListener("did-fail-load", handleFail as EventListener);
    };

    webview.addEventListener("did-navigate", handleNavigate as EventListener);
    webview.addEventListener(
      "did-navigate-in-page",
      handleNavigate as EventListener,
    );
    webview.addEventListener("did-stop-loading", handleStop as EventListener);
    webview.addEventListener("did-fail-load", handleFail as EventListener);
    try {
      const pending = trigger();
      if (
        pending &&
        typeof (pending as Promise<unknown>).catch === "function"
      ) {
        (pending as Promise<unknown>).catch((error: unknown) => {
          const code =
            error instanceof Error
              ? (error as Error & { code?: string }).code
              : undefined;
          if (code === "ERR_ABORTED" || code === "ERR_FAILED") {
            return;
          }
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        });
      }
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });

const waitForNavigation = (
  webview: Electron.WebviewTag,
  url: string,
  timeoutMs: number,
): Promise<void> => waitForLoad(webview, timeoutMs, () => webview.loadURL(url));

const waitForReload = (
  webview: Electron.WebviewTag,
  timeoutMs: number,
  ignoreCache: boolean,
): Promise<void> =>
  waitForLoad(webview, timeoutMs, () =>
    ignoreCache ? webview.reloadIgnoringCache() : webview.reload(),
  );

const navigate = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> => {
  const timeoutMs =
    typeof args.timeoutMs === "number" ? args.timeoutMs : 30_000;
  const reload = args.reload === true;
  const ignoreCache = args.ignoreCache === true;
  const initScript = optionalString(args, "initScript");
  const url = optionalString(args, "url") ?? "";
  if (!reload && !url) {
    throw new Error("url is required unless reload=true for browser-navigate");
  }
  const webContentsId = webview.getWebContentsId();
  let scriptId: string | null = null;
  if (initScript) {
    if (
      /cookie|localStorage|sessionStorage|indexedDB|authorization|password|secret|token/i.test(
        initScript,
      )
    ) {
      throw new Error("Credential/storage access is not allowed in initScript");
    }
    const added = (await window.snow.browserCdpCommand(
      webContentsId,
      "Page.addScriptToEvaluateOnNewDocument",
      { source: initScript },
    )) as { identifier?: string };
    scriptId = typeof added?.identifier === "string" ? added.identifier : null;
  }
  try {
    if (reload) {
      await waitForReload(webview, timeoutMs, ignoreCache);
    } else {
      await waitForNavigation(webview, url, timeoutMs);
    }
  } finally {
    if (scriptId) {
      await window.snow
        .browserCdpCommand(
          webContentsId,
          "Page.removeScriptToEvaluateOnNewDocument",
          { identifier: scriptId },
        )
        .catch(() => {});
    }
  }
  return {
    ...(await currentPageMetadata(webview, instanceId)),
    success: true,
    reloaded: reload,
  };
};

/**
 * 三路定位（selector / text / ref）并执行 actionBody，返回元素中心坐标与描述。
 * ref 走无障碍树确定性定位；selector/text 走 DOM 定位脚本（含 shadowRoot 遍历）。
 */
const locateElementTarget = async (
  webview: Electron.WebviewTag,
  args: BrowserMcpCommandArgs,
  actionBody: string,
  exact = false,
): Promise<{
  x: number;
  y: number;
  width?: number;
  height?: number;
  element: unknown;
}> => {
  const selector = optionalString(args, "selector");
  const text = optionalString(args, "text");
  const ref = optionalString(args, "ref");
  if (ref) {
    const { info } = await resolveRefHandle(
      webview,
      webview.getWebContentsId(),
      ref,
    );
    return { x: info.x, y: info.y, element: { tagName: info.tag, ref } };
  }
  const locateScript = buildElementLocatorScript(
    selector ?? null,
    text ?? null,
    exact,
    actionBody,
  );
  return (await webview.executeJavaScript(locateScript)) as {
    x: number;
    y: number;
    width?: number;
    height?: number;
    element: unknown;
  };
};

const click = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> => {
  const x = typeof args.x === "number" ? args.x : null;
  const y = typeof args.y === "number" ? args.y : null;
  let target: { x: number; y: number; element: unknown };
  if (x !== null && y !== null) {
    target = { x: Math.round(x), y: Math.round(y), element: null };
  } else {
    target = await locateElementTarget(
      webview,
      args,
      `const rect = element.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
      throw new Error('Clickable element is outside the browser viewport');
    }
    return {
      x,
      y,
      element: {
        tagName: element.tagName.toLowerCase(),
        id: element.id || null,
        text: describe(element).slice(0, ${TEXT_PREVIEW_LENGTH}),
        href: element.href || null,
      },
    };`,
      args.exact === true,
    );
  }
  const metadata = await currentPageMetadata(webview, instanceId);
  webview.focus();
  await webview.sendInputEvent({ type: "mouseMove", x: target.x, y: target.y });
  await webview.sendInputEvent({
    type: "mouseDown",
    x: target.x,
    y: target.y,
    button: "left",
    clickCount: 1,
  });
  // 按下与抬起之间留出真实点击间隔：部分站点（如必应搜索结果）在
  // mouseup 前有 JS 拦截逻辑，瞬时点击会被忽略。
  await new Promise((resolve) => setTimeout(resolve, 50));
  await webview.sendInputEvent({
    type: "mouseUp",
    x: target.x,
    y: target.y,
    button: "left",
    clickCount: 1,
  });
  if (args.dblClick === true) {
    await new Promise((resolve) => setTimeout(resolve, 60));
    await webview.sendInputEvent({
      type: "mouseDown",
      x: target.x,
      y: target.y,
      button: "left",
      clickCount: 2,
    });
    await webview.sendInputEvent({
      type: "mouseUp",
      x: target.x,
      y: target.y,
      button: "left",
      clickCount: 2,
    });
  }
  return {
    ...metadata,
    success: true,
    element: target.element,
  };
};

const evaluate = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> =>
  window.snow.browserFrameOperation(webview.getWebContentsId(), "evaluate", {
    ...args,
    instanceId,
  });

/** 一次性设值逻辑（作用域内元素为 element）：原生 setter + input/change 事件
 * （React 受控组件兼容，与 Playwright fill 同原理）。定位脚本与 ref 回指共用。
 * 注意：本片段不再定义 describe —— selector/text 路径由定位脚本注入，
 * ref 路径由调用方在 functionDeclaration 中注入 DESCRIBE_ELEMENT_SCRIPT。 */
const buildFillBody = (
  value: string,
  submit: boolean,
): string => `const value = ${JSON.stringify(value)};
  if (element.matches('input[type="checkbox"], input[type="radio"]')) {
    const desired = value === 'true' || value === '1' || value === 'checked';
    const isRadio = element.type === 'radio';
    if (!(isRadio && !desired) && element.checked !== desired) {
      element.click();
      if (element.checked !== desired) {
        element.checked = desired;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  } else if (element.matches('select')) {
    const option = Array.from(element.options).find((candidate) => candidate.value === value || candidate.label === value);
    if (!option) {
      throw new Error('No option matches the provided value: ' + value);
    }
    if (option.disabled) {
      throw new Error('Option is disabled: ' + value);
    }
    if (!element.multiple) {
      for (const item of element.options) item.selected = false;
    }
    option.selected = true;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    const editable = element.matches(
      'input:not([type="hidden"]), textarea, [contenteditable="true"], [contenteditable=""]'
    );
    if (!editable) {
      throw new Error('Target element is not editable (expected input, textarea, select, checkbox, radio, or contenteditable)');
    }
    if (element.readOnly) {
      throw new Error('Target element is readonly');
    }
    if (element.matches('[contenteditable="true"], [contenteditable=""]')) {
      element.textContent = value;
    } else {
      const proto = element.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) {
        setter.call(element, value);
      } else {
        element.value = value;
      }
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }
  if (${JSON.stringify(submit)}) {
    const form = element.closest('form');
    if (form) {
      form.requestSubmit();
    } else {
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
  }
  element.focus();
  return {
    element: {
      tagName: element.tagName.toLowerCase(),
      id: element.id || null,
      text: describe(element).slice(0, ${TEXT_PREVIEW_LENGTH}),
    },
  };`;

const type = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> => {
  const selector = optionalString(args, "selector");
  const text = optionalString(args, "text");
  const ref = optionalString(args, "ref");
  const value = requiredRawString(args, "value");
  const submit = args.submit === true;
  const delayMs = typeof args.delayMs === "number" ? args.delayMs : 0;
  const webContentsId = webview.getWebContentsId();

  // 逐键模式：聚焦元素，用真实键盘事件逐字符输入（触发表单校验）。
  if (delayMs > 0) {
    let target: { element: unknown };
    if (ref) {
      const { objectId } = await resolveRefHandle(webview, webContentsId, ref);
      const focused = (await window.snow.browserCdpCommand(
        webContentsId,
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: `function() {
            this.focus();
            return {
              element: {
                tagName: this.tagName ? this.tagName.toLowerCase() : '',
                id: this.id || null,
                text: (this.innerText || this.textContent || this.value || '')
                  .replace(/\\s+/g, ' ').trim().slice(0, ${TEXT_PREVIEW_LENGTH}),
              },
            };
          }`,
          returnByValue: true,
        },
      )) as { result?: { value?: { element?: unknown } } };
      target = { element: focused?.result?.value?.element };
    } else {
      const focusScript = buildElementLocatorScript(
        selector ?? null,
        text ?? null,
        false,
        `element.focus();
        return {
          element: {
            tagName: element.tagName.toLowerCase(),
            id: element.id || null,
            text: describe(element).slice(0, ${TEXT_PREVIEW_LENGTH}),
          },
        };`,
      );
      target = (await webview.executeJavaScript(focusScript)) as {
        element: unknown;
      };
    }
    webview.focus();
    for (const char of value) {
      await webview.sendInputEvent({ type: "keyDown", keyCode: char });
      await webview.sendInputEvent({ type: "char", keyCode: char });
      await webview.sendInputEvent({ type: "keyUp", keyCode: char });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (submit) {
      await webview.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
      await webview.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    }
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      success: true,
      mode: "keys",
      element: target.element,
    };
  }

  // 默认一次性设值模式。
  if (ref) {
    const { objectId } = await resolveRefHandle(webview, webContentsId, ref);
    const filled = (await window.snow.browserCdpCommand(
      webContentsId,
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: `function() {
          const element = this;
          ${DESCRIBE_ELEMENT_SCRIPT}
          ${buildFillBody(value, submit)}
        }`,
        returnByValue: true,
      },
    )) as { result?: { value?: { element?: unknown } } };
    const result = filled?.result?.value;
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      success: true,
      mode: "fill",
      value,
      element: result?.element,
    };
  }
  const fillScript = buildElementLocatorScript(
    selector ?? null,
    text ?? null,
    false,
    buildFillBody(value, submit),
  );
  const result = (await webview.executeJavaScript(fillScript)) as {
    element: unknown;
  };
  return {
    ...(await currentPageMetadata(webview, instanceId)),
    success: true,
    mode: "fill",
    value,
    element: result.element,
  };
};

/** 批量填充表单：逐个元素调用 type 的填充逻辑，单项失败不中断，汇总结果。 */
const fillForm = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> => {
  const elements = Array.isArray(args.elements) ? args.elements : [];
  if (elements.length === 0) {
    throw new Error("elements must be a non-empty array");
  }
  const results: { index: number; ok: boolean; error?: string }[] = [];
  let successCount = 0;
  for (const [index, item] of elements.entries()) {
    const itemArgs =
      item !== null && typeof item === "object" && !Array.isArray(item)
        ? (item as BrowserMcpCommandArgs)
        : {};
    try {
      await type(webview, instanceId, { ...itemArgs, instanceId });
      results.push({ index, ok: true });
      successCount += 1;
    } catch (error) {
      results.push({
        index,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    ...(await currentPageMetadata(webview, instanceId)),
    results,
    successCount,
    failureCount: results.length - successCount,
  };
};

/** 主进程直通操作：页面元数据 + 操作结果合并返回。 */
const passthrough = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  invoke: () => Promise<unknown>,
): Promise<unknown> => {
  const metadata = await currentPageMetadata(webview, instanceId);
  const result = await invoke();
  return result !== null && typeof result === "object" && !Array.isArray(result)
    ? { ...metadata, ...(result as object) }
    : { ...metadata, result };
};

const readStringOrNull = (value: unknown): string | null | undefined =>
  typeof value === "string" ? value : value === null ? null : undefined;

const emulatePage = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> =>
  passthrough(webview, instanceId, () =>
    window.snow.browserEmulate(webview.getWebContentsId(), {
      colorScheme:
        args.colorScheme === "dark" ||
        args.colorScheme === "light" ||
        args.colorScheme === "auto"
          ? args.colorScheme
          : undefined,
      cpuThrottlingRate:
        typeof args.cpuThrottlingRate === "number"
          ? args.cpuThrottlingRate
          : undefined,
      extraHttpHeaders:
        args.extraHttpHeaders === null
          ? null
          : args.extraHttpHeaders !== undefined &&
              typeof args.extraHttpHeaders === "object" &&
              !Array.isArray(args.extraHttpHeaders)
            ? (args.extraHttpHeaders as Record<string, string>)
            : undefined,
      geolocation:
        args.geolocation === null
          ? null
          : args.geolocation !== undefined &&
              typeof args.geolocation === "object" &&
              !Array.isArray(args.geolocation) &&
              typeof (args.geolocation as { latitude?: unknown }).latitude ===
                "number" &&
              typeof (args.geolocation as { longitude?: unknown }).longitude ===
                "number"
            ? {
                latitude: (args.geolocation as { latitude: number }).latitude,
                longitude: (args.geolocation as { longitude: number })
                  .longitude,
                accuracy:
                  typeof (args.geolocation as { accuracy?: unknown })
                    .accuracy === "number"
                    ? (args.geolocation as { accuracy: number }).accuracy
                    : undefined,
              }
            : undefined,
      networkConditions: readStringOrNull(args.networkConditions),
      userAgent: readStringOrNull(args.userAgent),
      viewport: readStringOrNull(args.viewport),
    }),
  );

const resizePage = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> =>
  passthrough(webview, instanceId, () =>
    window.snow.browserResizePage(
      webview.getWebContentsId(),
      typeof args.width === "number" ? args.width : 800,
      typeof args.height === "number" ? args.height : 600,
    ),
  );

const traceStart = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> =>
  passthrough(webview, instanceId, () =>
    window.snow.browserTraceStart(
      webview.getWebContentsId(),
      Array.isArray(args.categories)
        ? args.categories.filter(
            (item): item is string => typeof item === "string",
          )
        : undefined,
    ),
  );

const traceStop = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> =>
  passthrough(webview, instanceId, () =>
    window.snow.browserTraceStop(webview.getWebContentsId(), {
      filePath: optionalString(args, "filePath"),
    }),
  );

const traceInsight = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> =>
  passthrough(webview, instanceId, () =>
    window.snow.browserTraceInsight(
      webview.getWebContentsId(),
      requiredString(args, "insightId"),
    ),
  );

const cssStyles = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> => {
  const selector = optionalString(args, "selector");
  const ref = optionalString(args, "ref");
  let backendNodeId: number | undefined;
  if (ref) {
    backendNodeId = resolveAxRef(ref) ?? undefined;
    if (backendNodeId === undefined) {
      throw new Error(
        `Ref ${ref} is not in the current snapshot. Capture a new accessibility snapshot (browser-devtools action=ax) first.`,
      );
    }
  }
  if (!selector && backendNodeId === undefined) {
    throw new Error(
      "Either selector or ref is required for browser-get_css_styles",
    );
  }
  return passthrough(webview, instanceId, () =>
    window.snow.browserCssStyles(webview.getWebContentsId(), {
      selector,
      backendNodeId,
      pageIdx: typeof args.pageIdx === "number" ? args.pageIdx : undefined,
      pageSize: typeof args.pageSize === "number" ? args.pageSize : undefined,
    }),
  );
};

const auditPage = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> =>
  passthrough(webview, instanceId, () =>
    window.snow.browserAudit(
      webview.getWebContentsId(),
      Array.isArray(args.categories)
        ? args.categories.filter(
            (item): item is string => typeof item === "string",
          )
        : undefined,
    ),
  );

const HEAP_ACTIONS = new Map<
  string,
  | "take"
  | "summary"
  | "query"
  | "details"
  | "edges"
  | "retainers"
  | "paths"
  | "strings"
  | "compare"
>([
  ["take_heapsnapshot", "take"],
  ["get_heapsnapshot_summary", "summary"],
  ["query_heapsnapshot_objects", "query"],
  ["get_heapsnapshot_object_details", "details"],
  ["get_heapsnapshot_edges", "edges"],
  ["get_heapsnapshot_retainers", "retainers"],
  ["get_heapsnapshot_retaining_paths", "paths"],
  ["get_heapsnapshot_duplicate_strings", "strings"],
  ["compare_heapsnapshots", "compare"],
]);

const heapOperation = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  operation: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> => {
  const action = HEAP_ACTIONS.get(operation);
  if (!action) {
    throw new Error(`Unsupported heap operation: ${operation}`);
  }
  return passthrough(webview, instanceId, () =>
    window.snow.browserHeap(action, {
      ...args,
      ...(action === "take"
        ? { webContentsId: webview.getWebContentsId() }
        : {}),
    }),
  );
};

const screencastStart = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> =>
  passthrough(webview, instanceId, () =>
    window.snow.browserScreencastStart(webview.getWebContentsId(), {
      filePath: optionalString(args, "filePath"),
      quality: typeof args.quality === "number" ? args.quality : undefined,
      maxWidth: typeof args.maxWidth === "number" ? args.maxWidth : undefined,
      maxFrames:
        typeof args.maxFrames === "number" ? args.maxFrames : undefined,
      maxDurationMs:
        typeof args.maxDurationMs === "number" ? args.maxDurationMs : undefined,
    }),
  );

const screencastStop = async (
  webview: Electron.WebviewTag,
  instanceId: string,
): Promise<unknown> =>
  passthrough(webview, instanceId, () =>
    window.snow.browserScreencastStop(webview.getWebContentsId()),
  );

const PAGE_TOOL_REGISTRY_SNIPPET = `const registry = window.__snowPageTools;
  const entries = Array.isArray(registry) ? registry : registry && typeof registry === 'object' ? Object.values(registry) : [];`;

const listPageTools = async (
  webview: Electron.WebviewTag,
  instanceId: string,
): Promise<unknown> => {
  const tools = (await webview.executeJavaScript(`(() => {
    ${PAGE_TOOL_REGISTRY_SNIPPET}
    const out = [];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.name !== 'string' || !entry.name.trim()) continue;
      out.push({
        name: entry.name.trim(),
        description: typeof entry.description === 'string' ? entry.description.slice(0, 500) : '',
        parameters: entry.parameters && typeof entry.parameters === 'object' ? entry.parameters : null,
      });
    }
    return out;
  })()`)) as unknown[];
  return {
    ...(await currentPageMetadata(webview, instanceId)),
    tools,
    total: tools.length,
    note: "Page tools are registered by the page via window.__snowPageTools (an array or record of { name, description?, parameters?, run(args) }).",
  };
};

const callPageTool = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> => {
  const name = requiredString(args, "name");
  const params = args.params ?? null;
  const result = await webview.executeJavaScript(`(async () => {
    ${PAGE_TOOL_REGISTRY_SNIPPET}
    const target = entries.find((candidate) => candidate && typeof candidate === 'object' && candidate.name === ${JSON.stringify(name)});
    if (!target) throw new Error('Page tool not found: ' + ${JSON.stringify(name)});
    if (typeof target.run !== 'function') throw new Error('Page tool has no run() function');
    const value = await target.run(${JSON.stringify(params)});
    if (value !== undefined) {
      try { JSON.stringify(value); } catch { throw new Error('Page tool returned a non-serializable value'); }
    }
    return value === undefined ? null : value;
  })()`);
  return {
    ...(await currentPageMetadata(webview, instanceId)),
    result,
  };
};

const UPLOAD_MARKER = "data-snow-upload";

const uploadFile = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> => {
  const files = Array.isArray(args.files)
    ? args.files.filter((item): item is string => typeof item === "string")
    : [];
  if (files.length === 0) {
    throw new Error("files must be a non-empty string array");
  }
  const webContentsId = webview.getWebContentsId();
  const ref = optionalString(args, "ref");

  if (ref) {
    const backend = resolveAxRef(ref);
    if (backend === null) {
      throw new Error(
        `Ref ${ref} is not in the current snapshot. Capture a new accessibility snapshot (browser-devtools action=ax) first.`,
      );
    }
    await window.snow.browserCdpCommand(
      webContentsId,
      "DOM.setFileInputFiles",
      {
        backendNodeId: backend,
        files,
      },
    );
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      success: true,
      uploaded: files.length,
      target: { ref },
    };
  }

  // selector/text：定位并打临时标记，再经 CDP DOM 查询后注入文件。
  await locateElementTarget(
    webview,
    args,
    `if (!element.matches('input[type="file"]')) {
      throw new Error('Target element is not a file input');
    }
    element.setAttribute('${UPLOAD_MARKER}', '1');
    return {
      x: 0,
      y: 0,
      element: {
        tagName: 'input',
        id: element.id || null,
        text: describe(element).slice(0, ${TEXT_PREVIEW_LENGTH}),
      },
    };`,
  );
  try {
    const doc = (await window.snow.browserCdpCommand(
      webContentsId,
      "DOM.getDocument",
      { depth: -1, pierce: true },
    )) as { root?: { nodeId?: number } };
    const rootNodeId = doc?.root?.nodeId;
    if (typeof rootNodeId !== "number") {
      throw new Error("Failed to resolve the page document");
    }
    const query = (await window.snow.browserCdpCommand(
      webContentsId,
      "DOM.querySelector",
      { nodeId: rootNodeId, selector: `[${UPLOAD_MARKER}="1"]` },
    )) as { nodeId?: number };
    if (typeof query?.nodeId !== "number" || query.nodeId === 0) {
      throw new Error("Failed to locate the file input element");
    }
    await window.snow.browserCdpCommand(
      webContentsId,
      "DOM.setFileInputFiles",
      {
        nodeId: query.nodeId,
        files,
      },
    );
  } finally {
    await webview
      .executeJavaScript(
        `document.querySelector('[${UPLOAD_MARKER}="1"]')?.removeAttribute('${UPLOAD_MARKER}')`,
      )
      .catch(() => {});
  }
  return {
    ...(await currentPageMetadata(webview, instanceId)),
    success: true,
    uploaded: files.length,
  };
};

const historyNavigation = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  direction: "back" | "forward",
): Promise<unknown> => {
  const canGo =
    direction === "back" ? webview.canGoBack() : webview.canGoForward();
  if (!canGo) {
    throw new Error(`Cannot go ${direction}: no history entry`);
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`browser-${direction} timed out waiting for navigation`),
      );
    }, 10_000);
    const handle = (): void => {
      cleanup();
      resolve();
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      webview.removeEventListener("did-navigate", handle as EventListener);
      webview.removeEventListener(
        "did-navigate-in-page",
        handle as EventListener,
      );
      webview.removeEventListener("did-stop-loading", handle as EventListener);
    };
    webview.addEventListener("did-navigate", handle as EventListener);
    webview.addEventListener("did-navigate-in-page", handle as EventListener);
    webview.addEventListener("did-stop-loading", handle as EventListener);
    if (direction === "back") {
      webview.goBack();
    } else {
      webview.goForward();
    }
  });
  return {
    ...(await currentPageMetadata(webview, instanceId)),
    success: true,
  };
};

const screenshot = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> => {
  // 最近一次主 Frame 导航失败时，页面停留在 Chromium 错误页，截图
  // 只会返回全黑图像。此时直接返回原导航错误，不把错误页当作正常结果。
  const navigationState = getMainFrameNavigationState(instanceId);
  if (navigationState?.status === "failed") {
    throw new Error(
      `Browser screenshot unavailable: main-frame navigation to ${navigationState.url} failed with ${navigationState.errorDescription}`,
    );
  }
  const format: "png" | "jpeg" | "webp" =
    args.format === "jpeg" || args.format === "webp" ? args.format : "png";
  const quality = typeof args.quality === "number" ? args.quality : undefined;
  const filePath = optionalString(args, "filePath");
  const fullPage = args.fullPage === true;
  const selector = optionalString(args, "selector");
  const ref = optionalString(args, "ref");
  const webContentsId = webview.getWebContentsId();

  let clip: { x: number; y: number; width: number; height: number } | null =
    null;
  let elementInfo: unknown = null;
  if (ref) {
    const { objectId } = await resolveRefHandle(webview, webContentsId, ref);
    const rectInfo = (await window.snow.browserCdpCommand(
      webContentsId,
      "Runtime.callFunctionOn",
      {
        objectId,
        functionDeclaration: `function() {
          try {
            this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          } catch {}
          const rect = this.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) throw new Error('Element has no layout box');
          return {
            x: rect.left + window.scrollX,
            y: rect.top + window.scrollY,
            width: rect.width,
            height: rect.height,
            element: {
              tagName: this.tagName ? this.tagName.toLowerCase() : '',
              id: this.id || null,
              text: (this.innerText || this.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, ${TEXT_PREVIEW_LENGTH}),
            },
          };
        }`,
        returnByValue: true,
      },
    )) as {
      result?: {
        value?: {
          x?: number;
          y?: number;
          width?: number;
          height?: number;
          element?: unknown;
        };
      };
    };
    const value = rectInfo?.result?.value;
    if (
      !value ||
      typeof value.x !== "number" ||
      typeof value.y !== "number" ||
      typeof value.width !== "number" ||
      typeof value.height !== "number"
    ) {
      throw new Error(`Element for ref ${ref} could not be captured`);
    }
    clip = { x: value.x, y: value.y, width: value.width, height: value.height };
    elementInfo = value.element ?? null;
  } else if (selector) {
    const target = await locateElementTarget(
      webview,
      args,
      `const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) throw new Error('Element has no layout box');
      return {
        x: rect.left + window.scrollX,
        y: rect.top + window.scrollY,
        width: rect.width,
        height: rect.height,
        element: {
          tagName: element.tagName.toLowerCase(),
          id: element.id || null,
          text: describe(element).slice(0, ${TEXT_PREVIEW_LENGTH}),
        },
      };`,
      args.exact === true,
    );
    clip = {
      x: target.x,
      y: target.y,
      width: target.width ?? 0,
      height: target.height ?? 0,
    };
    elementInfo = target.element;
  }

  const result = await window.snow.browserCaptureScreenshot(webContentsId, {
    format,
    quality,
    fullPage,
    clip: clip ?? undefined,
    filePath,
  });
  const metadata = await currentPageMetadata(webview, instanceId);
  if (result.savedTo) {
    return {
      ...metadata,
      fullPage: fullPage || clip !== null,
      savedTo: result.savedTo,
      bytes: result.bytes,
      mimeType: result.mimeType,
      element: elementInfo,
    };
  }
  if (!result.data) {
    throw new Error("Browser screenshot did not return image data");
  }
  return {
    ...metadata,
    fullPage: fullPage || clip !== null,
    bytes: result.bytes,
    mimeType: result.mimeType,
    element: elementInfo,
    content: [
      {
        type: "text",
        text: `Browser screenshot captured: ${metadata.title || metadata.url}`,
      },
      {
        type: "image",
        data: result.data,
        mimeType: result.mimeType,
      },
    ],
  };
};

const wait = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> =>
  window.snow.browserFrameOperation(webview.getWebContentsId(), "wait", {
    ...args,
    instanceId,
  });

const pressKey = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> => {
  const key = requiredString(args, "key");
  const metadata = await currentPageMetadata(webview, instanceId);
  webview.focus();

  // 支持 "Control+a" / "Shift+ArrowDown" 形式的组合键
  const parts = key.split("+");
  const mainKey = parts.pop();
  if (!mainKey) {
    throw new Error("key must not be empty for browser-press_key");
  }
  // 按下修饰键
  for (const modifier of parts) {
    await webview.sendInputEvent({ type: "keyDown", keyCode: modifier });
  }
  await webview.sendInputEvent({ type: "keyDown", keyCode: mainKey });
  await webview.sendInputEvent({ type: "char", keyCode: mainKey });
  await webview.sendInputEvent({ type: "keyUp", keyCode: mainKey });
  // 释放修饰键
  for (const modifier of [...parts].reverse()) {
    await webview.sendInputEvent({ type: "keyUp", keyCode: modifier });
  }

  return { ...metadata, success: true, key };
};

const hover = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> => {
  const selector = optionalString(args, "selector");
  const text = optionalString(args, "text");
  const exact = args.exact === true;
  const locateScript = buildElementLocatorScript(
    selector ?? null,
    text ?? null,
    exact,
    `const rect = element.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) {
      throw new Error('Hoverable element is outside the browser viewport');
    }
    return {
      x,
      y,
      element: {
        tagName: element.tagName.toLowerCase(),
        id: element.id || null,
        text: describe(element).slice(0, ${TEXT_PREVIEW_LENGTH}),
        href: element.href || null,
      },
    };`,
  );
  const target = (await webview.executeJavaScript(locateScript)) as {
    x: number;
    y: number;
    element: unknown;
  };
  const metadata = await currentPageMetadata(webview, instanceId);
  webview.focus();
  await webview.sendInputEvent({ type: "mouseMove", x: target.x, y: target.y });
  return {
    ...metadata,
    success: true,
    element: target.element,
    position: { x: target.x, y: target.y },
  };
};

const selectOption = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
): Promise<unknown> => {
  const selector = optionalString(args, "selector");
  const text = optionalString(args, "text");
  const exact = args.exact === true;
  const values = args.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("values is required and must be a non-empty array");
  }
  const stringValues = values.map(String);

  const selectScript = buildElementLocatorScript(
    selector ?? null,
    text ?? null,
    exact,
    `if (element.tagName !== 'SELECT') {
      throw new Error('Target element is not a <select> element');
    }
    const values = ${JSON.stringify(stringValues)};
    const multiple = element.multiple;
    if (!multiple) {
      element.value = values[0];
      // 处理 value 未命中时按 option text 匹配
      if (element.selectedIndex === -1) {
        for (const option of element.options) {
          if (option.text === values[0] || option.textContent === values[0]) {
            option.selected = true;
            element.value = option.value;
            break;
          }
        }
      }
    } else {
      for (const option of element.options) {
        option.selected = values.includes(option.value) ||
          values.includes(option.text) ||
          values.includes(option.textContent);
      }
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    const selectedOptions = Array.from(element.selectedOptions).map((option) => ({
      value: option.value,
      text: option.text,
    }));
    return {
      element: {
        tagName: element.tagName.toLowerCase(),
        id: element.id || null,
        text: describe(element).slice(0, ${TEXT_PREVIEW_LENGTH}),
        multiple,
      },
      selectedOptions,
    };`,
  );
  const result = (await webview.executeJavaScript(selectScript)) as {
    element: unknown;
    selectedOptions: unknown;
  };
  const metadata = await currentPageMetadata(webview, instanceId);
  return {
    ...metadata,
    success: true,
    values: stringValues,
    element: result.element,
    selectedOptions: result.selectedOptions,
  };
};

const devtools = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  args: BrowserMcpCommandArgs,
  consoleMessages: readonly unknown[],
): Promise<unknown> => {
  const action = typeof args.action === "string" ? args.action : "snapshot";
  if (action === "ax") {
    const verbose = args.verbose === true;
    const maxNodes = typeof args.maxNodes === "number" ? args.maxNodes : 200;
    const raw = (await window.snow.browserCdpCommand(
      webview.getWebContentsId(),
      "Accessibility.getFullAXTree",
      {},
    )) as { nodes?: AxNode[] };
    const nodes = Array.isArray(raw?.nodes) ? raw.nodes : [];
    if (nodes.length === 0) {
      throw new Error(
        "Accessibility tree is empty; ensure the page is loaded and the browser debugger is available (close page DevTools if open)",
      );
    }
    const result = serializeAxTree(nodes, { verbose, maxNodes });
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      accessibility: result.tree,
      stats: {
        totalNodes: result.totalNodes,
        emitted: result.emitted,
        truncated: result.truncated,
      },
      note: "Elements are addressable via [uid=...] with browser-click ref=<uid> or browser-type ref=<uid>. Take a new snapshot after the page changes.",
    };
  }
  if (action === "trace") {
    const durationMs =
      typeof args.durationMs === "number" ? args.durationMs : 3000;
    const result = await window.snow.browserTrace(
      webview.getWebContentsId(),
      durationMs,
    );
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      trace: result,
    };
  }
  if (action === "open") {
    await window.snow.openBrowserDevTools(webview.getWebContentsId());
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      opened: true,
    };
  }
  if (action === "console") {
    const level = typeof args.level === "string" ? args.level : undefined;
    const minLevel = level !== undefined ? CONSOLE_LEVEL_MIN[level] : undefined;
    const types = Array.isArray(args.types)
      ? args.types.filter((item): item is string => typeof item === "string")
      : undefined;
    const pageIdx = typeof args.pageIdx === "number" ? args.pageIdx : undefined;
    const pageSize =
      typeof args.pageSize === "number" ? args.pageSize : undefined;
    const includePreserved = args.includePreserved === true;
    const webviewFallback = async (note?: string): Promise<unknown> => {
      const messages =
        minLevel === undefined
          ? consoleMessages
          : consoleMessages.filter((entry) => {
              const entryLevel = (entry as { level?: unknown }).level;
              return typeof entryLevel === "number" && entryLevel >= minLevel;
            });
      const total = messages.length;
      const size = pageSize ?? Math.max(total, 1);
      const paged =
        pageIdx !== undefined || pageSize !== undefined
          ? messages.slice((pageIdx ?? 0) * size, (pageIdx ?? 0) * size + size)
          : messages;
      return {
        ...(await currentPageMetadata(webview, instanceId)),
        source: "webview",
        messages: paged,
        total,
        level: level ?? "all",
        ...(note ? { note } : {}),
      };
    };
    try {
      const result = await window.snow.browserConsoleRecords(
        webview.getWebContentsId(),
        { level: minLevel, types, pageIdx, pageSize, includePreserved },
      );
      if (
        result.total === 0 &&
        consoleMessages.length > 0 &&
        !includePreserved
      ) {
        // CDP 采集刚启用（缓存为空）：退回 webview console-message 事件流。
        return webviewFallback(
          "CDP console capture just started; showing webview console-message data (no stack traces). Query again after the next messages.",
        );
      }
      let cleared: number | null = null;
      if (args.clearConsole === true) {
        const clearResult = await window.snow.browserConsoleClear(
          webview.getWebContentsId(),
        );
        cleared = clearResult.cleared;
      }
      return {
        ...(await currentPageMetadata(webview, instanceId)),
        source: "cdp",
        messages: result.messages,
        total: result.total,
        pageIdx: result.pageIdx,
        pageSize: result.pageSize,
        hasMore: result.hasMore,
        archivedGenerations: result.archivedGenerations,
        level: level ?? "all",
        ...(cleared !== null ? { cleared } : {}),
      };
    } catch {
      // CDP 不可用（如页面 DevTools 打开占用调试会话）：回退 webview console-message 数据。
      return webviewFallback(
        "CDP console capture is unavailable; falling back to the webview console-message stream (no stack traces).",
      );
    }
  }
  if (action === "console_message") {
    const messageId =
      typeof args.msgid === "number" && Number.isFinite(args.msgid)
        ? Math.floor(args.msgid)
        : null;
    if (messageId === null || messageId <= 0) {
      throw new Error("msgid is required for browser-devtools console_message");
    }
    const record = await window.snow.browserConsoleRecord(
      webview.getWebContentsId(),
      messageId,
    );
    if (record === null || record === undefined) {
      const fallback = consoleMessages[messageId - 1] ?? null;
      return {
        ...(await currentPageMetadata(webview, instanceId)),
        found: fallback !== null,
        message: fallback,
      };
    }
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      found: true,
      message: record,
    };
  }
  if (action === "network") {
    const filter = optionalString(args, "filter");
    const includeStatic = args.static === true;
    const resourceTypes = Array.isArray(args.resourceTypes)
      ? args.resourceTypes.filter(
          (item): item is string => typeof item === "string",
        )
      : undefined;
    const pageIdx = typeof args.pageIdx === "number" ? args.pageIdx : undefined;
    const pageSize =
      typeof args.pageSize === "number" ? args.pageSize : undefined;
    const includePreserved = args.includePreserved === true;
    const result = await window.snow.browserNetworkRequests(
      webview.getWebContentsId(),
      {
        filter,
        resourceTypes,
        includeStatic,
        pageIdx,
        pageSize,
        includePreserved,
      },
    );
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      requests: result.records,
      total: result.total,
      pageIdx: result.pageIdx,
      pageSize: result.pageSize,
      hasMore: result.hasMore,
      archivedGenerations: result.archivedGenerations,
      source: result.source,
      static: includeStatic,
      note: "Each request carries a numeric id (for action=network_detail) and a requestId string (for action=networkDetails, which returns full headers and bodies).",
    };
  }
  if (action === "network_detail") {
    const requestId = args.requestId;
    if (typeof requestId !== "number") {
      throw new Error(
        "requestId is required for browser-devtools network_detail",
      );
    }
    const record = await window.snow.browserNetworkRequest(requestId);
    if (!record) {
      return {
        ...(await currentPageMetadata(webview, instanceId)),
        found: false,
        requestId,
        error: `No network record found with id ${requestId}`,
      };
    }
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      found: true,
      requestId,
      request: record,
    };
  }
  if (action === "network_clear") {
    const result = await window.snow.browserNetworkClear(
      webview.getWebContentsId(),
    );
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      cleared: result.cleared,
      success: true,
    };
  }
  if (action === "networkDetails") {
    const requestId = requiredString(args, "requestId");
    const maxBodyBytes =
      typeof args.maxBodyBytes === "number" ? args.maxBodyBytes : undefined;
    const requestFilePath = optionalString(args, "requestFilePath");
    const responseFilePath = optionalString(args, "responseFilePath");
    const details = await window.snow.browserNetworkDetails(
      webview.getWebContentsId(),
      requestId,
      { maxBodyBytes, requestFilePath, responseFilePath },
    );
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      details,
    };
  }
  if (action === "networkState") {
    const state = requiredString(args, "state");
    if (state !== "online" && state !== "offline") {
      throw new Error(
        "state must be online or offline for browser-devtools networkState",
      );
    }
    const result = await window.snow.browserNetworkState(
      webview.getWebContentsId(),
      state === "offline",
    );
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      state: result.state,
    };
  }
  if (action === "route") {
    const pattern = requiredString(args, "pattern");
    const rule: BrowserRouteRule = {
      pattern,
      status: typeof args.status === "number" ? args.status : undefined,
      body: typeof args.body === "string" ? args.body : undefined,
      contentType:
        typeof args.contentType === "string" ? args.contentType : undefined,
      headers:
        args.headers !== null &&
        typeof args.headers === "object" &&
        !Array.isArray(args.headers)
          ? (args.headers as Record<string, string>)
          : undefined,
    };
    // 同一 pattern 覆盖，其余规则保留；全量提交给主进程。
    const rules = browserRouteRulesByInstance.get(instanceId) ?? [];
    const existingIndex = rules.findIndex((item) => item.pattern === pattern);
    if (existingIndex >= 0) {
      rules[existingIndex] = rule;
    } else {
      rules.push(rule);
    }
    browserRouteRulesByInstance.set(instanceId, rules);
    const result = await window.snow.browserRouteSet(
      webview.getWebContentsId(),
      rules,
    );
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      active: result.active,
      rule: { pattern },
    };
  }
  if (action === "routeClear") {
    browserRouteRulesByInstance.delete(instanceId);
    const result = await window.snow.browserRouteClear(
      webview.getWebContentsId(),
    );
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      active: result.active,
    };
  }
  if (action === "storageSave") {
    const fileName =
      typeof args.fileName === "string" && args.fileName.trim()
        ? args.fileName.trim()
        : undefined;
    const result = await window.snow.browserStorageSave(
      webview.getWebContentsId(),
      fileName,
    );
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      storage: result,
    };
  }
  if (action === "storageRestore") {
    const fileName = requiredString(args, "fileName");
    const result = await window.snow.browserStorageRestore(
      webview.getWebContentsId(),
      fileName,
    );
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      storage: result,
    };
  }
  if (action === "cookies") {
    const domain = optionalString(args, "domain");
    const showValues = args.showValues === true;
    const cookies = await window.snow.browserCookies(
      webview.getWebContentsId(),
      domain,
      showValues,
    );
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      cookies,
      total: cookies.length,
      masked: !showValues,
      ...(showValues
        ? {
            note: "WARNING: this output contains plaintext cookie values (sensitive credentials).",
          }
        : {}),
    };
  }
  if (action === "cookieDelete") {
    const name = requiredString(args, "name");
    const domain = requiredString(args, "domain");
    const result = await window.snow.browserCookieDelete(
      webview.getWebContentsId(),
      name,
      domain,
    );
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      deleted: result.deleted,
      name,
      domain,
    };
  }
  if (action === "dialog") {
    const dialogResponse = args.dialogResponse;
    if (
      dialogResponse !== null &&
      typeof dialogResponse === "object" &&
      typeof (dialogResponse as { accept?: unknown }).accept === "boolean"
    ) {
      const accept = (dialogResponse as { accept: boolean }).accept;
      const promptText =
        typeof (dialogResponse as { promptText?: unknown }).promptText ===
        "string"
          ? (dialogResponse as { promptText: string }).promptText
          : undefined;
      const responded = await window.snow.browserDialogRespond(
        webview.getWebContentsId(),
        accept,
        promptText,
      );
      return {
        ...(await currentPageMetadata(webview, instanceId)),
        responded,
      };
    }
    const dialogs = await window.snow.browserDialogs(
      webview.getWebContentsId(),
    );
    return {
      ...(await currentPageMetadata(webview, instanceId)),
      dialogs,
      pending: dialogs.length,
    };
  }

  const maxContentLength =
    typeof args.maxContentLength === "number" ? args.maxContentLength : 20_000;
  const snapshot = await webview.executeJavaScript(`(() => {
    const text = String(document.body?.innerText || '').slice(0, ${maxContentLength});
    return {
      url: location.href,
      title: document.title || '',
      readyState: document.readyState,
      contentType: document.contentType,
      characterSet: document.characterSet,
      viewport: { width: innerWidth, height: innerHeight },
      document: {
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
      },
      text,
      links: Array.from(document.links).slice(0, 100).map((link) => ({
        text: String(link.innerText || link.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 160),
        href: link.href,
      })),
    };
  })()`);
  return {
    instanceId,
    snapshot,
  };
};

export const executeBrowserMcpOperation = async (
  webview: Electron.WebviewTag,
  instanceId: string,
  operation: string,
  args: BrowserMcpCommandArgs,
  consoleMessages: readonly unknown[],
): Promise<unknown> => {
  if (
    operation === "frames" ||
    operation === "drag" ||
    (args.frameId !== undefined && args.frameId !== null)
  ) {
    return window.snow.browserFrameOperation(
      webview.getWebContentsId(),
      operation,
      args,
    );
  }
  switch (operation) {
    case "navigate":
      return navigate(webview, instanceId, args);
    case "click":
      return click(webview, instanceId, args);
    case "evaluate":
      return evaluate(webview, instanceId, args);
    case "type":
      return type(webview, instanceId, args);
    case "fill_form":
      return fillForm(webview, instanceId, args);
    case "emulate":
      return emulatePage(webview, instanceId, args);
    case "resize_page":
      return resizePage(webview, instanceId, args);
    case "performance_start_trace":
      return traceStart(webview, instanceId, args);
    case "performance_stop_trace":
      return traceStop(webview, instanceId, args);
    case "performance_analyze_insight":
      return traceInsight(webview, instanceId, args);
    case "get_css_styles":
      return cssStyles(webview, instanceId, args);
    case "audit":
      return auditPage(webview, instanceId, args);
    case "take_heapsnapshot":
    case "get_heapsnapshot_summary":
    case "query_heapsnapshot_objects":
    case "get_heapsnapshot_object_details":
    case "get_heapsnapshot_edges":
    case "get_heapsnapshot_retainers":
    case "get_heapsnapshot_retaining_paths":
    case "get_heapsnapshot_duplicate_strings":
    case "compare_heapsnapshots":
      return heapOperation(webview, instanceId, operation, args);
    case "screencast_start":
      return screencastStart(webview, instanceId, args);
    case "screencast_stop":
      return screencastStop(webview, instanceId);
    case "list_page_tools":
      return listPageTools(webview, instanceId);
    case "call_page_tool":
      return callPageTool(webview, instanceId, args);
    case "screenshot":
      return screenshot(webview, instanceId, args);
    case "wait":
      return wait(webview, instanceId, args);
    case "press_key":
      return pressKey(webview, instanceId, args);
    case "hover":
      return hover(webview, instanceId, args);
    case "select_option":
      return selectOption(webview, instanceId, args);
    case "devtools":
      return devtools(webview, instanceId, args, consoleMessages);
    case "upload-file":
      return uploadFile(webview, instanceId, args);
    case "back":
      return historyNavigation(webview, instanceId, "back");
    case "forward":
      return historyNavigation(webview, instanceId, "forward");
    default:
      throw new Error(`Unsupported browser operation: ${operation}`);
  }
};
