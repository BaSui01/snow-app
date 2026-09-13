import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";

const root = process.cwd();
const port = 8798;
const wanPort = 8800;
const entry = path.join(
  root,
  "scripts",
  "electron-remote-pairing-smoke-entry.mjs",
);
const child = spawn(
  path.join(root, "node_modules", "electron", "dist", "electron.exe"),
  [
    entry,
    "--user-data-dir=" + path.join(root, ".snow", "electron-user-data-pairing"),
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      SNOW_REMOTE_TOKEN: crypto.randomBytes(32).toString("base64url"),
      SNOW_REMOTE_HOST: "127.0.0.1",
      SNOW_REMOTE_PORT: String(port),
      SNOW_REMOTE_PUBLIC_ORIGIN: "https://snow.example.test",
      SNOW_REMOTE_WAN_PORT: String(wanPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let settled = false;
let buffered = "";
let stderrTail = "";
const timeout = setTimeout(() => {
  if (settled) return;
  settled = true;
  child.kill();
  console.error("PAIRING_SMOKE_TIMEOUT");
  process.exitCode = 1;
}, 30_000);

child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderrTail = (stderrTail + chunk).slice(-2_000);
});
child.stdout.on("data", (chunk) => {
  buffered = (buffered + chunk).slice(-8_000);
  const line = buffered
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith("SNOW_PAIRING_SMOKE "));
  if (!line || settled) return;
  settled = true;
  clearTimeout(timeout);
  const result = JSON.parse(line.slice("SNOW_PAIRING_SMOKE ".length));
  if (
    result.error ||
    !result.beforeRunning ||
    !result.afterRunning ||
    result.beforeCount < 1 ||
    result.afterCount < 1 ||
    !result.generationAdvanced ||
    !result.tokenChanged ||
    !result.wanPage ||
    !result.wanUnauthorized ||
    !result.wanWrongHost ||
    !result.wanPair ||
    !result.wanCookieSecure ||
    !result.wanState ||
    !result.wanReplayRejected ||
    !result.wanMissingOriginRejected ||
    !result.wanRevoked
  ) {
    console.error("PAIRING_SMOKE_FAILED " + JSON.stringify(result));
    process.exitCode = 1;
  } else {
    console.log(
      "PAIRING_SMOKE_OK running=true urls=" +
        result.afterCount +
        " generationAdvanced=true tokenChanged=true wanSecurity=true",
    );
  }
});

child.on("exit", (code) => {
  clearTimeout(timeout);
  if (!settled) {
    console.error(
      "PAIRING_SMOKE_EXITED_WITHOUT_RESULT code=" +
        code +
        (stderrTail ? " stderr=" + stderrTail.trim() : ""),
    );
    process.exitCode = 1;
  }
});
