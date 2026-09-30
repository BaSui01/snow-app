/**
 * Patch electron-builder (app-builder-lib) to fix Windows EPERM on directory rename.
 *
 * In app-builder-lib/out/util/electronGet.js, extractArchive locks tmpDir with proper-lockfile.
 * On Windows (NTFS), proper-lockfile holds an open file descriptor inside tmpDir, which
 * causes fs.rename(tmpDir, dir) to fail with "EPERM: operation not permitted" because the
 * directory has active locks/handles. Releasing the lock before rename (and adding a retry
 * loop for transient AV scanner file locking) resolves the issue.
 */

const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const targets = new Set();

const direct = path.join(
  projectRoot,
  "node_modules",
  "app-builder-lib",
  "out",
  "util",
  "electronGet.js",
);
if (fs.existsSync(direct)) {
  targets.add(direct);
}

const pnpmDir = path.join(projectRoot, "node_modules", ".pnpm");
if (fs.existsSync(pnpmDir)) {
  try {
    for (const item of fs.readdirSync(pnpmDir)) {
      if (item.startsWith("app-builder-lib@")) {
        const candidate = path.join(
          pnpmDir,
          item,
          "node_modules",
          "app-builder-lib",
          "out",
          "util",
          "electronGet.js",
        );
        if (fs.existsSync(candidate)) {
          targets.add(candidate);
        }
      }
    }
  } catch {
    // ignore
  }
}

const newBlock = `        await fs.rm(dir, { recursive: true, force: true });
        var __released = false;
        try {
            await release();
            __released = true;
        } catch (_) {}
        for (let __r = 0; __r < 10; __r++) {
            try {
                await fs.rename(tmpDir, dir);
                break;
            } catch (e) {
                if (__r < 9 && (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES')) {
                    await new Promise(r => setTimeout(r, 300 * (__r + 1)));
                    continue;
                }
                throw e;
            }
        }
    }
    finally {
        if (!__released) {
            await release().catch(err => builder_util_1.log.warn({ err }, "failed to release lockfile"));
        }
    }
}`;

let patchedCount = 0;
for (const file of targets) {
  try {
    let content = fs.readFileSync(file, "utf-8");
    if (content.includes("let __released = false;")) {
      continue;
    }

    // Replace previous buggy _origRelease patch if present
    const origReleaseRegex =
      /await fs\.rm\(dir,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\);[\s\S]*?finally\s*\{[\s\S]*?failed to release lockfile[\s\S]*?\}\s*\}/;
    if (origReleaseRegex.test(content)) {
      content = content.replace(origReleaseRegex, newBlock);
      fs.writeFileSync(file, content, "utf-8");
      console.log(`[patch-electron-builder] Patched ${file}`);
      patchedCount++;
      continue;
    }

    // Replace original unpatched code
    const originalRegex =
      /await fs\.rm\(dir,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\);\s*await fs\.rename\(tmpDir,\s*dir\);\s*\}\s*finally\s*\{\s*await release\(\)\.catch\([^\}]+\}\);?\s*\}/;
    if (originalRegex.test(content)) {
      content = content.replace(originalRegex, newBlock);
      fs.writeFileSync(file, content, "utf-8");
      console.log(`[patch-electron-builder] Patched ${file}`);
      patchedCount++;
    }
  } catch (err) {
    console.warn(
      `[patch-electron-builder] Error processing ${file}:`,
      err.message,
    );
  }
}

if (patchedCount === 0) {
  console.log(
    "[patch-electron-builder] No patches needed (already patched or files not found)",
  );
} else {
  console.log(`[patch-electron-builder] Done, ${patchedCount} file(s) patched`);
}
