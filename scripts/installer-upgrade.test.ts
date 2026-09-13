import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string): string => readFileSync(path, "utf8");

test("Windows installer lets the user choose a safe installation scope", () => {
  const packageJson = JSON.parse(read("package.json"));
  const include = read("build/installer.nsh");

  assert.equal(packageJson.build.nsis.perMachine, false);
  assert.equal(packageJson.build.nsis.selectPerMachineByDefault, false);
  assert.equal(packageJson.build.nsis.allowElevation, true);
  assert.equal(packageJson.build.nsis.include, "build/installer.nsh");
  assert.match(include, /!macro customCheckAppRunning/);
  assert.match(include, /--quit-for-update/);
  assert.match(include, /Stop-Process/);
  assert.match(include, /AddSeconds\(15\)/);
  assert.doesNotMatch(include, /!macro customInit/);
});

test("installer quit requests bypass the ordinary close confirmation", async () => {
  const { isInstallerQuitRequest } =
    await import("../src/main/app/installerQuit.ts");

  assert.equal(
    isInstallerQuitRequest("win32", ["Snow App.exe", "--quit-for-update"]),
    true,
  );
  assert.equal(isInstallerQuitRequest("win32", ["Snow App.exe"]), false);
  assert.equal(
    isInstallerQuitRequest("darwin", ["Snow App", "--quit-for-update"]),
    false,
  );
});
