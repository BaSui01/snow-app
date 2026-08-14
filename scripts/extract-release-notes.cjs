#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

/**
 * 从 <mdPath>（如 RELEASE_NOTES.md / RELEASE_NOTES_ZH.md）提取 rawTag
 * （如 v0.2.2，容忍 refs/tags/ 前缀）对应的版本段落。
 * 未找到对应版本或文件不存在时返回空字符串。
 */
function extractReleaseNotes(mdPath, rawTag) {
  const tag = String(rawTag).replace(/^refs\/tags\//, "");
  if (!fs.existsSync(mdPath)) {
    return "";
  }

  const content = fs.readFileSync(mdPath, "utf8");
  const lines = content.split("\n");
  let inSection = false;
  let output = [];

  for (const line of lines) {
    // 检测版本标题行: ## v0.1.11
    if (/^##\s+v\d/.test(line)) {
      if (inSection) break; // 遇到下一个版本段，结束提取
      if (line.trim() === `## ${tag}`) {
        inSection = true;
        continue; // 跳过标题行本身
      }
    } else if (inSection) {
      output.push(line);
    }
  }

  if (!inSection) {
    return "";
  }

  // 去除尾部空行
  while (output.length > 0 && output[output.length - 1].trim() === "") {
    output.pop();
  }

  return output.join("\n").trim();
}

module.exports = { extractReleaseNotes };

// CLI 入口：node scripts/extract-release-notes.cjs <tag>
// 从 RELEASE_NOTES.md 提取并写入 release_body.md（GitHub Releases body）。
if (require.main === module) {
  const rawTag = process.argv[2];
  if (!rawTag) {
    console.error("Usage: node scripts/extract-release-notes.cjs <tag>");
    process.exit(1);
  }

  const notesFile = path.join(__dirname, "..", "RELEASE_NOTES.md");
  const outputFile = path.join(process.cwd(), "release_body.md");

  const body = extractReleaseNotes(notesFile, rawTag);
  if (!body) {
    console.warn(
      `Warning: No release notes found for tag "${rawTag}" in RELEASE_NOTES.md`
    );
  }

  // 写入空文件不阻塞流程（generate_release_notes 仍会生成自动日志）
  fs.writeFileSync(outputFile, body);
  console.log(
    `Extracted release notes for ${rawTag} (${body.length} chars) -> release_body.md`
  );
}
