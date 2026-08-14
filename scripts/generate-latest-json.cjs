// 生成 macOS 无签名更新所需的 latest-mac.json 清单。
//
// 用法：node scripts/generate-latest-json.cjs <tag> [releaseDir]
//   例如：node scripts/generate-latest-json.cjs v0.1.12
//
// 在 release 目录中查找 Snow-App-<version>-<arch>.zip（arm64 / x64），
// 计算每个包的 SHA-256 与大小，输出 latest-mac.json：
//
// {
//   "version": "0.1.12",
//   "publishedAt": "2026-08-01T06:00:00.000Z",
//   "files": {
//     "arm64": { "url": ".../Snow-App-0.1.12-arm64.zip", "sha256": "...", "size": 12345 },
//     "x64":   { "url": ".../Snow-App-0.1.12-x64.zip",   "sha256": "...", "size": 12345 }
//   }
// }
//
// 应用主进程请求该清单比对版本、下载 zip 并校验 SHA-256 后静默替换。
//
// 同时从 RELEASE_NOTES_ZH.md 提取当前 tag 的中文发行说明，生成
// latest-zh.json（{ version, releaseNotesZh }）并随 Release 上传，
// 供应用内更新弹窗展示中文翻译（GitHub 发行页保持英文原文）。

const { createHash } = require("node:crypto");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { extractReleaseNotes } = require("./extract-release-notes.cjs");

const OWNER = "MayDay-wpf";
const REPO = "snow-app";

const tag = process.argv[2];
if (!tag) {
  console.error(
    "Usage: node scripts/generate-latest-json.cjs <tag> [releaseDir]"
  );
  process.exit(1);
}

const releaseDir = process.argv[3] ?? join(__dirname, "..", "release");
const version = tag.replace(/^v/i, "");

const files = {};

for (const arch of ["arm64", "x64"]) {
  const zipName = `Snow-App-${version}-${arch}.zip`;
  const zipPath = join(releaseDir, zipName);

  if (!existsSync(zipPath)) {
    console.warn(`[generate-latest-json] Skip missing package: ${zipName}`);
    continue;
  }

  const content = readFileSync(zipPath);
  files[arch] = {
    url: `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/${zipName}`,
    sha256: createHash("sha256").update(content).digest("hex"),
    size: content.length,
  };
  console.log(
    `[generate-latest-json] ${zipName}: sha256=${files[arch].sha256} size=${files[arch].size}`
  );
}

if (Object.keys(files).length === 0) {
  console.error(
    `[generate-latest-json] No Snow-App-${version}-*.zip found in ${releaseDir}`
  );
  process.exit(1);
}

const manifest = {
  version,
  publishedAt: new Date().toISOString(),
  files,
};

const outputPath = join(releaseDir, "latest-mac.json");
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[generate-latest-json] Written ${outputPath}`);

// 中文发行说明：从 RELEASE_NOTES_ZH.md 提取当前 tag 的段落。
// 未提供翻译时 releaseNotesZh 为 null，应用内自动回退显示英文。
const zhNotes = extractReleaseNotes(
  join(__dirname, "..", "RELEASE_NOTES_ZH.md"),
  tag
);
const zhManifest = {
  version,
  releaseNotesZh: zhNotes || null,
};
const zhOutputPath = join(releaseDir, "latest-zh.json");
writeFileSync(zhOutputPath, `${JSON.stringify(zhManifest, null, 2)}\n`);
console.log(
  `[generate-latest-json] Written ${zhOutputPath} (zh notes: ${
    zhNotes ? `${zhNotes.length} chars` : "none"
  })`
);
