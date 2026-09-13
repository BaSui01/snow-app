import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import puppeteer from "puppeteer-core";

const root = process.cwd();
const token = crypto.randomBytes(32).toString("base64url");
const port = Number(process.env.SNOW_SMOKE_PORT || 8797);
const packagedExecutable = process.env.SNOW_SMOKE_EXECUTABLE;
const screenshotDirectory = process.env.SNOW_SMOKE_SCREENSHOT_DIR;
const executable =
  packagedExecutable ||
  path.join(root, "node_modules", "electron", "dist", "electron.exe");
const userDataArgument =
  "--user-data-dir=" +
  path.join(root, ".snow", "electron-user-data-phase-bc-" + port);
const child = spawn(
  executable,
  packagedExecutable ? [userDataArgument] : [".", userDataArgument],
  {
    cwd: root,
    env: {
      ...process.env,
      SNOW_REMOTE_TOKEN: token,
      SNOW_REMOTE_HOST: "127.0.0.1",
      SNOW_REMOTE_PORT: String(port),
    },
    stdio: packagedExecutable ? ["ignore", "pipe", "pipe"] : "ignore",
  },
);

let packagedOutput = "";
const capturePackagedOutput = (chunk) => {
  packagedOutput = (packagedOutput + chunk.toString("utf8")).slice(-8_000);
};
child.stdout?.on("data", capturePackagedOutput);
child.stderr?.on("data", capturePackagedOutput);

const request = (pathname, options = {}, body) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: pathname, ...options },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const bytes = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            body: bytes.toString("utf8"),
            bytes,
            contentType: res.headers["content-type"] || "",
          });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });

const uploadHeaders = (kind, mimeType, name, length) => ({
  "x-snow-remote-token": token,
  "x-snow-attachment-kind": kind,
  "x-snow-file-name": encodeURIComponent(name),
  "content-type": mimeType,
  "content-length": String(length),
});

const png = Buffer.alloc(24);
Buffer.from("89504e470d0a1a0a", "hex").copy(png);
png.write("IHDR", 12, "ascii");
png.writeUInt32BE(2, 16);
png.writeUInt32BE(3, 20);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const stopPackagedSmokeTree = () => {
  if (!packagedExecutable || process.platform !== "win32") return;
  const powershellNeedle = userDataArgument.replace(/'/g, "''");
  const command = [
    `$needle = '${powershellNeedle}'`,
    "$ids = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) } | Select-Object -ExpandProperty ProcessId)",
    "$ids | ConvertTo-Json -Compress",
  ].join("; ");
  let ids = [];
  try {
    const output = execFileSync("pwsh.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    if (output) {
      const parsed = JSON.parse(output);
      ids = Array.isArray(parsed) ? parsed : [parsed];
    }
  } catch {
    // The direct child kill below remains the fallback for unpacked builds.
  }
  for (const id of ids) {
    if (!Number.isInteger(id) || id === process.pid) continue;
    try {
      execFileSync("taskkill.exe", ["/PID", String(id), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // A process can exit between discovery and taskkill.
    }
  }
};

const verifyInstallerQuitHandshake = async () => {
  if (!packagedExecutable || process.platform !== "win32") return false;

  const quitRequester = spawn(
    executable,
    [userDataArgument, "--quit-for-update"],
    {
      cwd: root,
      env: process.env,
      stdio: "ignore",
      windowsHide: true,
    },
  );

  let portReleased = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await request("/api/state", {
        headers: { "x-snow-remote-token": token },
      });
    } catch {
      portReleased = true;
      break;
    }
    await wait(250);
  }

  if (quitRequester.exitCode === null) quitRequester.kill();
  return portReleased;
};

try {
  let state;
  let stableContext = "";
  let stableContextReads = 0;
  for (let attempt = 0; attempt < 45; attempt += 1) {
    try {
      state = await request("/api/state", {
        headers: { "x-snow-remote-token": token },
      });
      if (state.status === 200) {
        const snapshot = JSON.parse(state.body);
        const context = JSON.stringify([
          snapshot.workspace?.directoryId ?? null,
          snapshot.activeConversationId ?? null,
        ]);
        stableContextReads = context === stableContext ? stableContextReads + 1 : 1;
        stableContext = context;
        if (stableContextReads >= 3) break;
      }
    } catch {}
    await wait(350);
  }
  if (!state || state.status !== 200 || stableContextReads < 3) {
    if (packagedOutput.trim()) {
      console.error("PACKAGED_OUTPUT_TAIL=" + packagedOutput.trim());
    }
    throw new Error("isolated renderer did not become ready");
  }

  const unauthorized = await request(
    "/api/attachments",
    { method: "POST", headers: { "content-type": "image/png" } },
    png,
  );
  const image = await request(
    "/api/attachments",
    {
      method: "POST",
      headers: uploadHeaders("image", "image/png", "phone.png", png.length),
    },
    png,
  );
  const fileBytes = Buffer.from("phase-c-file");
  const file = await request(
    "/api/attachments",
    {
      method: "POST",
      headers: uploadHeaders(
        "file",
        "text/plain",
        "notes.txt",
        fileBytes.length,
      ),
    },
    fileBytes,
  );
  const fake = Buffer.from("not-an-image");
  const spoofed = await request(
    "/api/attachments",
    {
      method: "POST",
      headers: uploadHeaders("image", "image/png", "fake.png", fake.length),
    },
    fake,
  );
  const imageBody = JSON.parse(image.body);
  const fileBody = JSON.parse(file.body);
  const smokeText = "isolated attachment smoke " + token.slice(0, 8);
  const sendPayload = Buffer.from(
    JSON.stringify({
      text: smokeText,
      attachmentIds: [imageBody.id, fileBody.id],
      requestId: "smoke-attachment-send-1",
    }),
  );
  const sendOptions = {
    method: "POST",
    headers: {
      "x-snow-remote-token": token,
      "content-type": "application/json",
      "content-length": String(sendPayload.length),
    },
  };
  const send = await request("/api/send", sendOptions, sendPayload);
  const replay = await request("/api/send", sendOptions, sendPayload);
  const afterSend = await request("/api/state", {
    headers: { "x-snow-remote-token": token },
  });
  const afterSendState = JSON.parse(afterSend.body);
  const attachmentMessages = afterSendState.messages.filter(
    (message) => message.role === "user" && message.content.includes(smokeText),
  );
  const attachmentMessage = attachmentMessages.at(-1);
  const imageBlock = attachmentMessage?.contentBlocks?.find(
    (block) => block.type === "image",
  );
  const fileBlock = attachmentMessage?.contentBlocks?.find(
    (block) => block.type === "file",
  );
  const attachmentsInState =
    attachmentMessages.length === 1 &&
    Boolean(attachmentMessage) &&
    attachmentMessage.content === smokeText &&
    !afterSend.body.includes("@@image:") &&
    !afterSend.body.includes("@@file:") &&
    !afterSend.body.includes("data:image/") &&
    imageBlock?.name === "image.png" &&
    typeof imageBlock?.source === "string" &&
    fileBlock?.name === "notes.txt" &&
    !("path" in fileBlock);
  const messageImage = imageBlock?.source
    ? await request(imageBlock.source, {
        headers: { "x-snow-remote-token": token },
      })
    : null;
  const unauthorizedMessageImage = imageBlock?.source
    ? await request(imageBlock.source)
    : null;
  const imageLoadsOnDemand =
    messageImage?.status === 200 &&
    messageImage.contentType === "image/png" &&
    messageImage.bytes.equals(png) &&
    unauthorizedMessageImage?.status === 401;
  const skills = await request("/api/skills", {
    headers: { "x-snow-remote-token": token },
  });
  const unauthorizedSkills = await request("/api/skills");
  const skillsBody = skills.status === 200 ? JSON.parse(skills.body) : null;
  const skillsReadIsSafe =
    skills.status === 200 &&
    unauthorizedSkills.status === 401 &&
    Array.isArray(skillsBody?.skills) &&
    skillsBody.skills.every(
      (skill) =>
        typeof skill.id === "string" &&
        typeof skill.name === "string" &&
        typeof skill.enabled === "boolean" &&
        !("path" in skill),
    );
  const mcp = await request("/api/mcp", {
    headers: { "x-snow-remote-token": token },
  });
  const unauthorizedMcp = await request("/api/mcp");
  const permissions = await request("/api/permissions", { headers: { "x-snow-remote-token": token } });
  const unauthorizedPermissions = await request("/api/permissions");
  const permissionsBody = permissions.status === 200 ? JSON.parse(permissions.body) : null;
  const permissionsReadIsSafe = permissions.status === 200 && unauthorizedPermissions.status === 401 && Array.isArray(permissionsBody?.projectApprovedTools) && Array.isArray(permissionsBody?.globalApprovedTools) && typeof permissionsBody?.readonlyToolCount === "number" && typeof permissionsBody?.yolo === "boolean";
  const role = await request("/api/role", { headers: { "x-snow-remote-token": token } });
  const unauthorizedRole = await request("/api/role");
  const roleBody = role.status === 200 ? JSON.parse(role.body) : null;
  const roleReadIsSafe = role.status === 200 && unauthorizedRole.status === 401 && ["project", "ssh", "global", "none"].includes(roleBody?.source) && typeof roleBody?.exists === "boolean" && typeof roleBody?.characterCount === "number" && typeof roleBody?.preview === "string" && roleBody?.editable === false && !("path" in roleBody);
  const review = await request("/api/review", { headers: { "x-snow-remote-token": token } });
  const unauthorizedReview = await request("/api/review");
  const reviewBody = review.status === 200 ? JSON.parse(review.body) : null;
  const reviewReadIsSafe = review.status === 200 && unauthorizedReview.status === 401 && typeof reviewBody?.available === "boolean" && typeof reviewBody?.currentBranch === "string" && typeof reviewBody?.stagedCount === "number" && typeof reviewBody?.unstagedCount === "number" && typeof reviewBody?.untrackedCount === "number" && typeof reviewBody?.remote === "boolean" && !("path" in reviewBody);
  const mcpBody = mcp.status === 200 ? JSON.parse(mcp.body) : null;
  const forbiddenMcpKeys = new Set([
    "inputSchemaJson",
    "error",
    "path",
    "env",
    "headers",
    "config",
  ]);
  const hasForbiddenMcpKey = (value) => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(hasForbiddenMcpKey);
    return Object.entries(value).some(
      ([key, child]) => forbiddenMcpKeys.has(key) || hasForbiddenMcpKey(child),
    );
  };
  const mcpReadIsSafe =
    mcp.status === 200 &&
    unauthorizedMcp.status === 401 &&
    typeof mcpBody?.directoryId === "string" &&
    Array.isArray(mcpBody?.servers) &&
    mcpBody.servers.every(
      (server) =>
        typeof server.id === "string" &&
        typeof server.name === "string" &&
        typeof server.enabled === "boolean" &&
        Array.isArray(server.tools) &&
        server.tools.every(
          (tool) =>
            typeof tool.name === "string" &&
            typeof tool.enabled === "boolean",
        ),
    ) &&
    !hasForbiddenMcpKey(mcpBody);
  const changes = await request("/api/changes", {
    headers: { "x-snow-remote-token": token },
  });
  const unauthorizedChanges = await request("/api/changes");
  const changesBody = changes.status === 200 ? JSON.parse(changes.body) : null;
  const changesReadIsSafe =
    changes.status === 200 &&
    unauthorizedChanges.status === 401 &&
    (changesBody?.conversationId === null || typeof changesBody?.conversationId === "string") &&
    Array.isArray(changesBody?.changes) &&
    changesBody.changes.every(
      (change) =>
        typeof change.path === "string" &&
        !/[A-Za-z]:[\\\\/]/.test(change.path) &&
        !change.path.startsWith("/") &&
        ["create", "edit", "delete"].includes(change.kind) &&
        ["main", "sub"].includes(change.agent) &&
        typeof change.timestamp === "number" &&
        !("diff" in change) &&
        !("output" in change),
    );
  const page = await request("/?token=" + encodeURIComponent(token));
  const pageHasPickers =
    page.body.includes('id="imagePicker"') &&
    page.body.includes('id="filePicker"');
  const pageHasMobilePanels =
    page.body.includes('id="skillsPanel"') &&
    page.body.includes('id="mcpPanel"') &&
    page.body.includes('id="permissionsPanel"') &&
    page.body.includes('id="rolePanel"') &&
    page.body.includes('id="reviewPanel"') &&
    page.body.includes('id="themePanel"') &&
    page.body.includes('data-theme-choice="system"') &&
    page.body.includes('data-theme-choice="light"') &&
    page.body.includes('data-theme-choice="dark"');
  const browserExecutable = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ].find(existsSync);
  let mobileUiBehavior = false;
  let mcpUiLoaded = false;
  let viewportChecks = [];
  let viewportQaPassed = false;
  let commandPanelsQa = false;
  let skillsDetailsQa = false;
  let p4ContentQa = false;
  let panelFocusQa = false;
  let actionMenuQa = false;
  let themeControlsQa = false;
  if (browserExecutable) {
    const browser = await puppeteer.launch({
      executablePath: browserExecutable,
      headless: true,
      args: ["--no-first-run", "--disable-background-networking"],
    });
    try {
      const mobile = await browser.newPage();
      await mobile.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
      await mobile.goto(
        `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`,
        { waitUntil: "domcontentloaded" },
      );
      await mobile.waitForSelector("#actionButton:not([disabled])", { timeout: 10_000 });
      await mobile.evaluate(() => document.querySelector("#plusButton")?.click());
      await mobile.click('[data-action="theme"]');
      await mobile.waitForFunction(
        () => document.querySelector("#themePanel")?.classList.contains("open"),
      );
      await wait(250);
      const panelFocusState = await mobile.evaluate(() => ({
        activeId: document.activeElement?.id || "",
        activeClass: document.activeElement?.className || "",
        closeExists: Boolean(document.querySelector("#themePanel .panel-close")),
        panelOpen: document.querySelector("#themePanel")?.classList.contains("open") === true,
      }));
      const panelFocused = String(panelFocusState.activeClass).includes("panel-close");
      await mobile.evaluate(() => document.querySelector("#themePanel .panel-close")?.click());
      await mobile.waitForFunction(() => !document.querySelector("#themePanel")?.classList.contains("open"));
      const focusReturned = await mobile.evaluate(() => document.activeElement?.id === "plusButton");
      panelFocusQa = panelFocused && focusReturned;
      await wait(250);
      await mobile.evaluate(() => document.querySelector("#plusButton")?.click());
      await mobile.click('[data-action="theme"]');
      await mobile.waitForFunction(() => document.querySelector("#themePanel")?.classList.contains("open"));
      await mobile.evaluate(() => document.querySelector('[data-theme-choice="light"]')?.click());
      const lightControls = await mobile.evaluate(() => {
        let mark = document.querySelector(".empty-mark");
        if (!mark) {
          mark = document.createElement("div");
          mark.className = "empty-mark";
          mark.hidden = true;
          document.body.appendChild(mark);
        }
        const colors = (selector) => {
          const style = getComputedStyle(document.querySelector(selector));
          return [style.backgroundColor, style.color];
        };
        const action = document.querySelector("#actionButton");
        const normal = colors("#actionButton");
        action.classList.add("stop");
        const stop = colors("#actionButton");
        action.classList.remove("stop");
        action.disabled = true;
        const disabled = colors("#actionButton");
        action.disabled = false;
        return { normal, stop, disabled, plus: colors("#plusButton"), mark: colors(".empty-mark"), close: colors("#themePanel .panel-close") };
      });
      await mobile.evaluate(() => document.querySelector('[data-theme-choice="dark"]')?.click());
      const darkControls = await mobile.evaluate(() => {
        let mark = document.querySelector(".empty-mark");
        if (!mark) {
          mark = document.createElement("div");
          mark.className = "empty-mark";
          mark.hidden = true;
          document.body.appendChild(mark);
        }
        const colors = (selector) => {
          const style = getComputedStyle(document.querySelector(selector));
          return [style.backgroundColor, style.color];
        };
        return { normal: colors("#actionButton"), plus: colors("#plusButton"), mark: colors(".empty-mark"), close: colors("#themePanel .panel-close") };
      });
      themeControlsQa =
        [...Object.values(lightControls), ...Object.values(darkControls)].every(
          ([background, foreground]) => background !== foreground && foreground !== "rgb(0, 0, 0)",
        ) &&
        lightControls.normal.join("|") !== darkControls.normal.join("|") &&
        lightControls.mark.join("|") !== darkControls.mark.join("|");
      await mobile.evaluate(() => document.querySelector('[data-theme-choice="light"]')?.click());
      const lightSelected = await mobile.evaluate(() => ({
        theme: document.documentElement.dataset.theme,
        saved: localStorage.getItem("snowRemoteTheme"),
        overflow: document.documentElement.scrollWidth > window.innerWidth,
      }));
      await mobile.reload({ waitUntil: "domcontentloaded" });
      const lightRestored = await mobile.evaluate(
        () => document.documentElement.dataset.theme === "light",
      );
      await mobile.evaluate(() => document.querySelector("#plusButton")?.click());
      await mobile.click('[data-action="skills"]');
      await mobile.waitForFunction(
        () =>
          document.querySelector("#skillsPanel")?.classList.contains("open") &&
          !document.querySelector("#skillsList")?.textContent?.includes("正在加载"),
        { timeout: 15_000 },
      );
      const skillsVisible = await mobile.evaluate(
        () => document.querySelector("#skillsPanel")?.classList.contains("open") === true,
      );
      const skillsDetails = await mobile.evaluate(async () => {
        const response = await fetch("/api/skills", { credentials: "same-origin" });
        const body = await response.json();
        const skills = Array.isArray(body.skills) ? body.skills : [];
        return {
          status: response.status,
          detailNodes: document.querySelectorAll("#skillsList .skill-detail").length,
          safeShape: skills.every(
            (skill) =>
              Array.isArray(skill.allowedTools) &&
              !Object.prototype.hasOwnProperty.call(skill, "path") &&
              !Object.prototype.hasOwnProperty.call(skill, "content"),
          ),
          count: skills.length,
        };
      });
      skillsDetailsQa =
        skillsDetails.status === 200 &&
        skillsDetails.safeShape &&
        (skillsDetails.count === 0 || skillsDetails.detailNodes === skillsDetails.count);
      await mobile.evaluate(() => document.querySelector("#remotePanelScrim")?.click());
      await mobile.waitForFunction(
        () => !document.querySelector("#skillsPanel")?.classList.contains("open"),
      );
      await mobile.evaluate(() => document.querySelector("#plusButton")?.click());
      await mobile.waitForFunction(
        () => document.querySelector("#actionSheet")?.classList.contains("open"),
        { timeout: 2_000 },
      );
      await mobile.evaluate(() => document.querySelector('[data-action="mcp"]')?.click());
      await mobile.waitForFunction(
        () => document.querySelector("#mcpPanel")?.classList.contains("open"),
        { timeout: 2_000 },
      );
      await mobile.waitForFunction(
        () =>
          document.querySelector("#mcpPanel")?.classList.contains("open") &&
          !document.querySelector("#mcpList")?.textContent?.includes("正在加载"),
        { timeout: 15_000 },
      );
      const mcpUi = await mobile.evaluate(() => ({
        visible: document.querySelector("#mcpPanel")?.classList.contains("open") === true,
        failed: document.querySelector("#mcpList")?.textContent?.includes("加载失败") === true,
      }));
      mcpUiLoaded = mcpUi.visible && !mcpUi.failed;
      const panelCommands = [["permissions", "permissionsPanel", "permissionsList"], ["role", "rolePanel", "roleList"], ["sensitive-commands", "sensitivePanel", "sensitiveList"], ["codebase", "codebasePanel", "codebaseList"], ["review", "reviewPanel", "reviewList"]];
      const panelResults = [];
      for (const [command, panel, content] of panelCommands) {
        await mobile.evaluate(() => document.querySelector("#remotePanelScrim")?.click());
        await mobile.evaluate(() => document.querySelector("#plusButton")?.click());
        await mobile.waitForFunction(() => document.querySelector("#actionSheet")?.classList.contains("open"), { timeout: 2_000 });
        await mobile.evaluate(() => document.querySelector('[data-action="commands"]')?.click());
        await mobile.waitForFunction(() => document.querySelector("#commandPanel")?.classList.contains("open"), { timeout: 2_000 });
        const registry = await mobile.evaluate((commandId) => {
          const item = document.querySelector(`[data-command="${commandId}"]`);
          return { exists: Boolean(item), disabled: item instanceof HTMLButtonElement ? item.disabled : false };
        }, command);
        if (!registry.exists) {
          panelResults.push({ command, ...registry, ok: false });
          continue;
        }
        if (registry.disabled) {
          const stayedClosed = await mobile.evaluate((panelId) => !document.querySelector(`#${panelId}`)?.classList.contains("open"), panel);
          panelResults.push({ command, ...registry, stayedClosed, ok: stayedClosed });
          continue;
        }
        await mobile.evaluate((commandId) => { const item = document.querySelector(`[data-command="${commandId}"]`); if (item instanceof HTMLElement) item.click(); }, command);
        await mobile.waitForFunction((panelId) => document.querySelector("#" + panelId)?.classList.contains("open"), { timeout: 3_000 }, panel);
        await mobile.waitForFunction((contentId) => !document.querySelector("#" + contentId)?.textContent?.includes("正在加载"), { timeout: 15_000 }, content);
        panelResults.push(await mobile.evaluate((panelId, contentId) => ({ command: panelId, open: document.querySelector("#" + panelId)?.classList.contains("open") === true, settled: !document.querySelector("#" + contentId)?.textContent?.includes("正在加载"), ok: document.querySelector("#" + panelId)?.classList.contains("open") === true && !document.querySelector("#" + contentId)?.textContent?.includes("正在加载") }), panel, content));
      }
      commandPanelsQa = panelResults.length === panelCommands.length && panelResults.every((item) => item.ok === true);
      if (!commandPanelsQa) console.log("COMMAND_PANELS_DIAG=" + JSON.stringify(panelResults));
      for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1100, height: 760 }]) {
        await mobile.setViewport({ ...viewport, deviceScaleFactor: 1 });
        await mobile.evaluate(() => {
          if (document.querySelector(".remote-panel.open")) document.querySelector("#remotePanelScrim")?.click();
          if (document.querySelector("#actionSheet")?.classList.contains("open")) document.querySelector("#actionBackdrop")?.click();
        });
        await mobile.evaluate(() => document.querySelector("#plusButton")?.click());
        await mobile.waitForFunction(() => document.querySelector("#actionSheet")?.classList.contains("open"), { timeout: 2_000 });
        const menu = await mobile.evaluate(async () => {
          const sheet = document.querySelector("#actionSheet");
          const trigger = document.querySelector("#plusButton");
          const items = Array.from(sheet.querySelectorAll("[data-action]"));
          const hits = [];
          for (const item of items) {
            sheet.scrollTop = Math.max(0, item.offsetTop - (sheet.clientHeight - item.offsetHeight) / 2);
            await new Promise((resolve) => requestAnimationFrame(resolve));
            const rect = item.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest("[data-action]");
            const sheetRect = sheet.getBoundingClientRect();
            hits.push({ action: item.getAttribute("data-action"), hit: hit?.getAttribute("data-action") || null, top: rect.top, bottom: rect.bottom, offsetTop: item.offsetTop, scrollTop: sheet.scrollTop, sheetTop: sheetRect.top, sheetBottom: sheetRect.bottom });
          }
          const rect = sheet.getBoundingClientRect();
          const triggerRect = trigger.getBoundingClientRect();
          return {
            count: items.length,
            allHit: hits.every((item) => item.action === item.hit),
            failedHits: hits.filter((item) => item.action !== item.hit),
            bounded: rect.top >= 0 && rect.bottom <= triggerRect.top,
            overflowY: getComputedStyle(sheet).overflowY,
            inlineMaxHeight: sheet.style.maxHeight,
            computedMaxHeight: getComputedStyle(sheet).maxHeight,
            scrollable: sheet.scrollHeight > sheet.clientHeight,
          };
        });
        await mobile.evaluate(() => document.querySelector("#actionBackdrop")?.click());
        await mobile.waitForFunction(() => !document.querySelector("#actionSheet")?.classList.contains("open"), { timeout: 2_000 });
        viewportChecks.push(await mobile.evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
          overflow: document.documentElement.scrollWidth > window.innerWidth,
          composer: Boolean(document.querySelector(".composer")),
          panelScrim: Boolean(document.querySelector("#remotePanelScrim")),
          actionClosed: !document.querySelector("#actionSheet")?.classList.contains("open"),
        })).then((shape) => ({ ...shape, menu })));
      }
      actionMenuQa = viewportChecks.every((item) => item.menu.count === 11 && item.menu.allHit && item.menu.bounded && item.menu.overflowY === "auto") && viewportChecks.some((item) => item.width > item.height && item.menu.scrollable);
      viewportQaPassed = viewportChecks.every((item) => !item.overflow && item.composer && item.panelScrim && item.actionClosed) && actionMenuQa;
      const fixture = {
        workspace: null, activeConversationId: "fixture-conversation", isStreaming: false, isAborting: false,
        isCompacting: false, compactionError: null, attentionRequired: false, pendingAuthorizations: [], pendingQuestions: [],
        conversations: [], modes: { plan: false, goal: false, worktree: false, workflow: false, yolo: false, lite: false },
        chatInput: { conversationId: "fixture-conversation", isSubAgentConversation: false, isLoadingApiConfig: false, selectedModel: "fixture", displayModel: "fixture", modelIds: [], selectedApiProfile: "fixture", apiProfileNames: [], requestMethod: "responses", thinkingValue: "", thinkingOptions: [], responsesFastModeEnabled: false, maxContextTokens: null, tokenUsage: null, commands: [] },
        messages: [
          { id: "fixture-user", role: "user", content: "", timestamp: new Date().toISOString(), status: "sent", contentBlocks: [
            { type: "text", text: "请检查" }, { type: "file", name: "notes.md", isDirectory: false },
            { type: "reference", kind: "quote", label: "引用片段", detail: "来自隔离夹具" },
            { type: "image", name: "fixture.png", source: "/api/message-images/fixture-user/0" },
          ] },
          { id: "fixture-assistant", role: "assistant", model: "fixture", thinking: "逐项检查内容", thinkingDurationMs: 1200, timestamp: new Date().toISOString(), status: "sent", content: "## 结果\n\n正文 **加粗**\n\n| 项目 | 状态 |\n| --- | --- |\n| 安全 | 通过 |\n\n> 隔离引用\n\n```js\nconst safe = true;\n```", toolCalls: [{ interactionId: "fixture-tool", name: "fixture-tool", status: "completed", arguments: "{\"ok\":true}", result: "完成" }] },
          { id: "fixture-error", role: "tool", content: "工具失败：<script>alert(1)</script>", timestamp: new Date().toISOString(), status: "error" },
        ],
      };
      let servedFixture = fixture;
      const fixturePage = await browser.newPage();
      await fixturePage.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
      await fixturePage.setRequestInterception(true);
      fixturePage.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/state") {
          void request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(servedFixture) });
        } else {
          void request.continue();
        }
      });
      await fixturePage.goto(`http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`, { waitUntil: "domcontentloaded" });
      await fixturePage.waitForFunction(() => document.querySelectorAll(".message").length >= 3, { timeout: 5_000 });
      const fixtureShape = await fixturePage.evaluate(() => ({
        heading: Boolean(document.querySelector(".markdown h2")), code: Boolean(document.querySelector(".markdown pre code")),
        table: Boolean(document.querySelector(".table-wrap table")), quote: Boolean(document.querySelector(".markdown blockquote")),
        thinking: Boolean(document.querySelector(".thinking")), tool: Boolean(document.querySelector(".tool.completed")),
        file: Boolean(document.querySelector(".remote-attachment")), image: Boolean(document.querySelector(".remote-image")),
        escaped: !document.querySelector(".tool-card script"),
      }));
      p4ContentQa = Object.values(fixtureShape).every(Boolean);
      if (screenshotDirectory) {
        mkdirSync(screenshotDirectory, { recursive: true });
        servedFixture = {
          ...fixture,
          chatInput: {
            ...fixture.chatInput,
            selectedModel: "gpt-5.6",
            displayModel: "GPT-5.6",
            thinkingValue: "high",
          },
          messages: [
            {
              id: "showcase-user",
              role: "user",
              content: "请检查项目状态，并总结这次手机远控修复。",
              timestamp: new Date().toISOString(),
              status: "sent",
            },
            {
              id: "showcase-assistant",
              role: "assistant",
              model: "GPT-5.6",
              thinking: "正在核对安装器、远控服务和移动页面……",
              thinkingDurationMs: 1800,
              timestamp: new Date().toISOString(),
              status: "sent",
              content: "## 检查完成\n\n- 手机浏览器可控制电脑上的真实 Snow 会话\n- 支持文字、图片和文件附件\n- 支持模型、推理强度、计划模式与权限面板\n- 局域网扫码即可连接，也支持自有域名 HTTPS\n\n> 会话仍保存在电脑端，手机无需安装额外 App。",
              toolCalls: [],
            },
          ],
        };
        await fixturePage.evaluate(() => localStorage.setItem("snowRemoteTheme", "dark"));
        await fixturePage.reload({ waitUntil: "domcontentloaded" });
        await fixturePage.waitForFunction(
          () => document.querySelectorAll(".message").length === 2,
          { timeout: 5_000 },
        );
        await wait(300);
        await fixturePage.screenshot({
          path: path.join(screenshotDirectory, "mobile-conversation.png"),
          fullPage: false,
        });
        await fixturePage.evaluate(() => document.querySelector("#plusButton")?.click());
        await fixturePage.waitForFunction(
          () => document.querySelector("#actionSheet")?.classList.contains("open"),
          { timeout: 2_000 },
        );
        await fixturePage.evaluate(() => window.scrollTo(0, 0));
        await fixturePage.screenshot({
          path: path.join(screenshotDirectory, "mobile-actions.png"),
          fullPage: false,
        });
      }
      await fixturePage.close();
      mobileUiBehavior =
        lightSelected.theme === "light" &&
        lightSelected.saved === "light" &&
        !lightSelected.overflow &&
        lightRestored &&
        skillsVisible &&
        skillsDetailsQa &&
        p4ContentQa &&
        panelFocusQa &&
        actionMenuQa &&
        themeControlsQa &&
        mcpUiLoaded &&
        commandPanelsQa &&
        viewportQaPassed;
    } finally {
      await browser.close();
    }
  }

  const installerQuitQa = await verifyInstallerQuitHandshake();

  console.log(
    [
      "STATE=" + state.status,
      "UNAUTHORIZED_UPLOAD=" + unauthorized.status,
      "IMAGE_UPLOAD=" + image.status,
      "FILE_UPLOAD=" + file.status,
      "SPOOFED_IMAGE=" + spoofed.status,
      "ATTACHMENT_SEND=" + send.status,
      "IDEMPOTENT_REPLAY=" + replay.status,
      "ATTACHMENTS_IN_STATE=" + attachmentsInState,
      "IMAGE_ON_DEMAND=" + imageLoadsOnDemand,
      "SKILLS_READ_SAFE=" + skillsReadIsSafe,
      "MCP_READ_SAFE=" + mcpReadIsSafe,
      "PERMISSIONS_READ_SAFE=" + permissionsReadIsSafe,
      "ROLE_READ_SAFE=" + roleReadIsSafe,
      "REVIEW_READ_SAFE=" + reviewReadIsSafe,
      "CHANGES_READ_SAFE=" + changesReadIsSafe,
      "CHANGES_STATUS=" + changes.status + "/" + unauthorizedChanges.status,
      "CHANGES_BODY=" + String(changes.body).slice(0, 100),
      "MCP_UI_LOADED=" + mcpUiLoaded,
      "SKILLS_DETAILS_QA=" + skillsDetailsQa,
      "P4_CONTENT_QA=" + p4ContentQa,
      "PANEL_FOCUS_QA=" + panelFocusQa,
      "ACTION_MENU_QA=" + actionMenuQa,
      "THEME_CONTROLS_QA=" + themeControlsQa,
      "COMMAND_PANELS_QA=" + commandPanelsQa,
      "PAGE_PICKERS=" + pageHasPickers,
      "PAGE_MOBILE_PANELS=" + pageHasMobilePanels,
      "MOBILE_UI_BEHAVIOR=" + mobileUiBehavior,
      "VIEWPORT_QA=" + (typeof viewportQaPassed === "boolean" ? viewportQaPassed : false),
      "VIEWPORT_QA_DETAILS=" + JSON.stringify(viewportChecks ?? []),
      "INSTALLER_QUIT_QA=" + installerQuitQa,
    ].join(" "),
  );
} finally {
  if (child.exitCode === null) child.kill();
  stopPackagedSmokeTree();
  await wait(1500);
  console.log("CHILD_EXITED=" + (child.exitCode !== null || child.killed));
}

