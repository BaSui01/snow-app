const { app, BrowserWindow } = require("electron");
const http = require("node:http");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const request = (port, path, options = {}, body) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, ...options },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });

app.whenReady().then(async () => {
  try {
    let mainWindow;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      mainWindow = BrowserWindow.getAllWindows().find(
        (window) =>
          !window.isDestroyed() &&
          !window.webContents.isDestroyed() &&
          /[/\\]out[/\\]renderer[/\\]index\.html(?:$|[?#])/.test(
            decodeURIComponent(window.webContents.getURL()),
          ),
      );
      if (mainWindow) {
        const ready = await mainWindow.webContents
          .executeJavaScript(
            "Boolean(window.snow && window.snow.getRemoteControlPairingState && window.snow.rotateRemoteControlToken)",
            true,
          )
          .catch(() => false);
        if (ready) break;
      }
      mainWindow = undefined;
      await wait(250);
    }
    if (!mainWindow) throw new Error("Snow main renderer did not become ready");

    const before = await mainWindow.webContents.executeJavaScript(
      "window.snow.getRemoteControlPairingState()",
      true,
    );
    let initialLanState;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      initialLanState = await request(before.port, "/api/state", {
        headers: { "x-snow-remote-token": process.env.SNOW_REMOTE_TOKEN },
      });
      if (initialLanState.status === 200) break;
      await wait(250);
    }
    if (initialLanState?.status !== 200) {
      throw new Error(`Snow remote bridge did not become ready (${initialLanState?.status})`);
    }
    const wan = before.wan;
    if (!wan.enabled || !wan.pairingUrl) {
      throw new Error("WAN listener did not become ready");
    }
    const pairCode = new URL(wan.pairingUrl).hash.slice("#pair=".length);
    const host = new URL(wan.publicOrigin).host;
    const origin = wan.publicOrigin;
    const page = await request(wan.localPort, "/", { headers: { host } });
    const unauthorized = await request(wan.localPort, "/api/state", { headers: { host } });
    const wrongHost = await request(wan.localPort, "/", { headers: { host: "wrong.invalid" } });
    const pairBody = Buffer.from(JSON.stringify({ code: pairCode }));
    const pair = await request(wan.localPort, "/api/pair", {
      method: "POST",
      headers: { host, origin, "content-type": "application/json", "content-length": String(pairBody.length) },
    }, pairBody);
    const cookie = String(pair.headers["set-cookie"]?.[0] || "").split(";")[0];
    let state;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      state = await request(wan.localPort, "/api/state", { headers: { host, cookie } });
      if (state.status === 200) break;
      await wait(250);
    }
    const replay = await request(wan.localPort, "/api/pair", {
      method: "POST",
      headers: { host, origin, "content-type": "application/json", "content-length": String(pairBody.length) },
    }, pairBody);
    const missingOriginBody = Buffer.from("{}");
    const missingOrigin = await request(wan.localPort, "/api/abort", {
      method: "POST",
      headers: { host, cookie, "content-type": "application/json", "content-length": String(missingOriginBody.length) },
    }, missingOriginBody);

    const rotation = await mainWindow.webContents.executeJavaScript(
      `(async () => {
        const before = await window.snow.getRemoteControlPairingState();
        const after = await window.snow.rotateRemoteControlToken();
        return {
          beforeRunning: before.running,
          afterRunning: after.running,
          beforeCount: before.pairingUrls.length,
          afterCount: after.pairingUrls.length,
          generationAdvanced: after.generation === before.generation + 1,
          tokenChanged:
            before.pairingUrls.length > 0 &&
            after.pairingUrls.length > 0 &&
            before.pairingUrls[0] !== after.pairingUrls[0],
        };
      })()`,
      true,
    );
    const revoked = await request(wan.localPort, "/api/state", { headers: { host, cookie } });
    const cookieHeader = String(pair.headers["set-cookie"]?.[0] || "");
    const result = {
      ...rotation,
      wanPage: page.status === 200 && page.body.includes("pairFromFragment"),
      wanUnauthorized: unauthorized.status === 401,
      wanWrongHost: wrongHost.status === 421,
      wanPair: pair.status === 200,
      wanCookieSecure: cookieHeader.includes("Secure") && cookieHeader.includes("HttpOnly") && cookieHeader.includes("SameSite=Strict"),
          wanState: state.status === 200,
          wanStateStatus: state.status,
      wanReplayRejected: replay.status === 401,
      wanMissingOriginRejected: missingOrigin.status === 403,
      wanRevoked: revoked.status === 401,
    };
    console.log("SNOW_PAIRING_SMOKE " + JSON.stringify(result));
  } catch (error) {
    console.log(
      "SNOW_PAIRING_SMOKE " +
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
    );
  } finally {
    app.exit(0);
  }
});
