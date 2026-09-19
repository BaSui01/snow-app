#!/usr/bin/env node
"use strict";

/**
 * 发布前校验：更新清单（latest*.yml / latest-mac.json）引用的安装包名，
 * 必须与 release 目录里真实存在的文件名逐字一致。
 *
 * 背景（Linux AppImage 更新 404）：electron-builder 的 AppImage 默认文件名由
 * productName 拼出来，productName "Snow App" 含空格，磁盘上落成
 * "Snow App-0.4.2.AppImage"；写 latest-linux.yml 时 electron-builder 按 GitHub
 * 安全字符规则把空格换成 "-"（Snow-App-0.4.2.AppImage），而文件上传到 GitHub
 * Release 后 GitHub 会把空格改写成 "."（Snow.App-0.4.2.AppImage）。客户端照着
 * yml 里的名字下载就 404。AppImage 现已显式指定 artifactName
 * （Snow-App-${version}.${ext}），本校验负责在发布前拦住同类命名漂移。
 *
 * 用法：node scripts/verify-update-manifests.cjs [releaseDir]
 */

const { existsSync, readdirSync, readFileSync, statSync } = require("node:fs");
const { basename, join, resolve } = require("node:path");

const releaseDir = resolve(process.argv[2] || join(__dirname, "..", "release"));

// GitHub Release 只保留这些字符，其余字符会被重写成 "." 或 "-"
const GITHUB_SAFE_NAME = /^[0-9A-Za-z._-]+$/;

function fail(message) {
  console.error(`[verify-update-manifests] ${message}`);
  process.exit(1);
}

if (!existsSync(releaseDir) || !statSync(releaseDir).isDirectory()) {
  fail(`Release directory not found: ${releaseDir}`);
}

const presentFiles = new Set(
  readdirSync(releaseDir).filter((name) =>
    statSync(join(releaseDir, name)).isFile(),
  ),
);

// yml 清单：收集 files[].url 与顶层 path 引用的文件名
function collectYmlReferences(content) {
  const refs = [];
  for (const raw of content.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const match = /^(?:\s*-\s*url|\s*path):\s*(.+)$/.exec(line);
    if (match) {
      refs.push(basename(match[1].trim().replace(/^["']|["']$/g, "")));
    }
  }
  return [...new Set(refs)];
}

// json 清单（如 latest-mac.json）：只在声明了 files 时校验
function collectJsonReferences(content) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    fail(`Invalid JSON manifest: ${error.message}`);
  }
  const files = parsed && typeof parsed === "object" ? parsed.files : null;
  if (files == null || typeof files !== "object") {
    return null;
  }
  const refs = [];
  for (const entry of Object.values(files)) {
    if (entry && typeof entry.url === "string") {
      refs.push(basename(entry.url));
    }
  }
  return [...new Set(refs)];
}

const manifests = [];
for (const name of readdirSync(releaseDir)) {
  if (/^latest.*\.yml$/.test(name)) {
    manifests.push({
      name,
      refs: collectYmlReferences(readFileSync(join(releaseDir, name), "utf8")),
    });
  } else if (/^latest.*\.json$/.test(name)) {
    const refs = collectJsonReferences(
      readFileSync(join(releaseDir, name), "utf8"),
    );
    if (refs != null) {
      manifests.push({ name, refs });
    }
  }
}

if (manifests.length === 0) {
  fail(
    `No update manifest (latest*.yml / latest*.json) found in ${releaseDir}`,
  );
}

const problems = [];
for (const manifest of manifests) {
  if (manifest.refs.length === 0) {
    problems.push(`${manifest.name}: declares no file reference`);
    continue;
  }
  for (const ref of manifest.refs) {
    if (!GITHUB_SAFE_NAME.test(ref)) {
      problems.push(
        `${manifest.name}: "${ref}" contains characters GitHub rewrites on upload`,
      );
    }
    if (!presentFiles.has(ref)) {
      problems.push(
        `${manifest.name}: references "${ref}" but no such file exists in the release directory`,
      );
    }
  }
  console.log(
    `[verify-update-manifests] ${manifest.name}: ${manifest.refs.length} reference(s) checked`,
  );
}

if (problems.length > 0) {
  fail(`Update manifest / asset mismatch:\n  - ${problems.join("\n  - ")}`);
}

console.log(
  "[verify-update-manifests] All update manifests match the packaged files.",
);
