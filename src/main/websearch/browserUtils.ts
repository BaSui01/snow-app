/** 浏览器查找工具（对齐 Snow CLI 的 browser.utils.ts，无 WSL 分支）。 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";

/**
 * 校验路径是否是当前平台的可执行文件（对齐 Snow CLI）：
 * - Windows 仅接受 .exe / .bat
 * - macOS/Linux 拒绝 .exe / .bat（跨平台路径必是无效二进制）
 */
export function isExecutableForPlatform(filePath: string): boolean {
  const os = platform();
  const lower = filePath.toLowerCase();

  if (os === "win32") {
    return lower.endsWith(".exe") || lower.endsWith(".bat");
  }

  // Linux 和 macOS：Windows 的 .exe / .bat 永远不是有效的本机二进制
  if (lower.endsWith(".exe") || lower.endsWith(".bat")) {
    return false;
  }

  // Linux 上 /mnt/<drive>/ 路径指向 Windows 文件系统（WSL），
  // 即使没有 .exe 后缀也是 Windows 二进制
  if (os === "linux" && /^\/mnt\/[a-z]\//i.test(filePath)) {
    return false;
  }

  return true;
}

/** 查找系统安装的 Chrome/Edge/Chromium 可执行文件路径。 */
export function findBrowserExecutable(): string | null {
  const os = platform();
  const paths: string[] = [];

  if (os === "win32") {
    // Windows: 优先 Edge（系统自带），再 Chrome。
    // 注意路径分隔符必须是单个反斜杠，双反斜杠会导致 puppeteer 启动失败。
    paths.push(
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      `${process.env["LOCALAPPDATA"] ?? ""}\\Google\\Chrome\\Application\\chrome.exe`
    );
  } else if (os === "darwin") {
    paths.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    );
  } else {
    // Linux
    const binPaths = [
      "google-chrome",
      "chromium",
      "chromium-browser",
      "microsoft-edge",
    ];
    for (const bin of binPaths) {
      try {
        const path = execSync(`which ${bin}`, { encoding: "utf8" }).trim();
        if (path) {
          return path;
        }
      } catch {
        // 继续尝试下一个
      }
    }
  }

  for (const path of paths) {
    if (path && existsSync(path)) {
      return path;
    }
  }

  return null;
}
