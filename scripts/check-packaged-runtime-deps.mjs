import { existsSync } from "node:fs";
import path from "node:path";
import { statFile } from "@electron/asar";

const asarPath = path.resolve(
  process.argv[2] ?? "release/win-unpacked/resources/app.asar",
);

if (!existsSync(asarPath)) {
  throw new Error(`Packaged app archive not found: ${asarPath}`);
}

// These packages are loaded by puppeteer-core at main-process startup. A
// package can appear healthy while still crashing immediately if a packaging
// workflow follows an external node_modules junction and omits transitive deps.
const requiredPackageJsonFiles = [
  "puppeteer-core/package.json",
  "@puppeteer/browsers/package.json",
  "chromium-bidi/package.json",
  "ws/package.json",
];

const missing = requiredPackageJsonFiles.filter((relativePath) => {
  try {
    statFile(asarPath, path.join("node_modules", relativePath));
    return false;
  } catch {
    return true;
  }
});

if (missing.length > 0) {
  throw new Error(
    `Packaged runtime dependencies are missing: ${missing.join(", ")}`,
  );
}

console.log(
  `packaged runtime dependencies: OK (${requiredPackageJsonFiles.length})`,
);
