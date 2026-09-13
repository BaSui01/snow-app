import { app } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Electron derives app.getAppPath() from this custom smoke entry's directory.
// Production starts from the project package, so restore that same root here;
// otherwise nativeBridge looks for scripts/native/index.cjs and falls back.
app.getAppPath = () => process.cwd();

await import("./electron-remote-pairing-smoke-hook.cjs");
await import(
  pathToFileURL(path.join(process.cwd(), "out", "main", "index.js")).href
);
