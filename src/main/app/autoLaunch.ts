import { app } from "electron";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

// Linux 无 setLoginItemSettings，走 XDG autostart .desktop 文件
const linuxDesktopFile = (): string =>
  path.join(
    process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"),
    "autostart",
    "snow-app.desktop",
  );

const linuxExecPath = (): string => process.env.APPIMAGE || process.execPath;

/** 读取开机自启状态（以系统实际注册为准）。 */
export async function getAutoLaunchEnabled(): Promise<boolean> {
  if (process.platform === "linux") {
    try {
      const content = await readFile(linuxDesktopFile(), "utf8");
      return !/^X-GNOME-Autostart-enabled=false$/m.test(content);
    } catch {
      return false;
    }
  }
  return app.getLoginItemSettings().openAtLogin;
}

/** 设置开机自启，返回设置后的实际状态。 */
export async function setAutoLaunchEnabled(enabled: boolean): Promise<boolean> {
  if (process.platform === "linux") {
    const file = linuxDesktopFile();
    if (enabled) {
      await mkdir(path.dirname(file), { recursive: true });
      const content = [
        "[Desktop Entry]",
        "Type=Application",
        `Name=${app.getName()}`,
        `Exec="${linuxExecPath()}"`,
        "Terminal=false",
        "X-GNOME-Autostart-enabled=true",
        "",
      ].join("\n");
      await writeFile(file, content, "utf8");
    } else {
      await unlink(file).catch(() => undefined);
    }
    return getAutoLaunchEnabled();
  }
  app.setLoginItemSettings({ openAtLogin: enabled });
  return getAutoLaunchEnabled();
}
