const { spawn } = require("node:child_process");
const {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
} = require("node:fs");
const path = require("node:path");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const PREVIEW_ROOT = path.join(PROJECT_ROOT, ".preview");
const SHARED_DIRS = ["native", "resources", "docs", "deploy", "node_modules"];

const removeDir = (target) => {
  try {
    rmSync(target, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 200,
    });
  } catch (error) {
    console.warn(`[preview] failed to remove ${target}: ${error.message}`);
  }
};

const createSnapshot = () => {
  const outDir = path.join(PROJECT_ROOT, "out");
  if (!existsSync(path.join(outDir, "main", "index.js"))) {
    console.error("[preview] out/main/index.js not found, run the build first");
    process.exit(1);
  }

  const snapshotDir = path.join(PREVIEW_ROOT, `run-${Date.now()}`);
  mkdirSync(snapshotDir, { recursive: true });
  cpSync(outDir, path.join(snapshotDir, "out"), { recursive: true });
  copyFileSync(
    path.join(PROJECT_ROOT, "package.json"),
    path.join(snapshotDir, "package.json"),
  );

  for (const name of SHARED_DIRS) {
    const target = path.join(PROJECT_ROOT, name);
    if (existsSync(target)) {
      symlinkSync(target, path.join(snapshotDir, name), "junction");
    }
  }
  return snapshotDir;
};

const pruneSnapshots = (currentDir) => {
  if (!existsSync(PREVIEW_ROOT)) {
    return;
  }
  const current = path.resolve(currentDir);
  const stale = readdirSync(PREVIEW_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(PREVIEW_ROOT, entry.name))
    .filter((dir) => path.resolve(dir) !== current)
    .sort((a, b) => b.localeCompare(a));
  for (const dir of stale.slice(1)) {
    removeDir(dir);
  }
};

const snapshotDir = createSnapshot();
pruneSnapshots(snapshotDir);

console.log(
  `[preview] snapshot ${path.relative(PROJECT_ROOT, snapshotDir)} is frozen for this session`,
);
console.log("[preview] source changes take effect after restarting preview");

const child = spawn(require("electron"), [snapshotDir], {
  cwd: PROJECT_ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "production",
    NODE_ENV_ELECTRON_VITE: "production",
  },
});

let finalized = false;
const finalize = (code) => {
  if (finalized) {
    return;
  }
  finalized = true;
  removeDir(snapshotDir);
  process.exit(code);
};

child.on("error", (error) => {
  console.error(`[preview] failed to launch electron: ${error.message}`);
  finalize(1);
});

child.on("close", (code) => {
  finalize(code ?? 1);
});
