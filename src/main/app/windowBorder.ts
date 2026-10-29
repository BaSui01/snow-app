import type { BrowserWindow } from "electron";
import { native } from "../native/nativeBridge";
import { isWindows } from "./constants";

/**
 * Windows 11 会给每个顶层窗口绘制一圈 1px 边框，颜色默认取自系统个性化里的
 * 强调色，无边框窗口（frame: false）同样会被画上。这里通过
 * DwmSetWindowAttribute(DWMWA_BORDER_COLOR) 把它固定为应用统一的边框色，
 * 使窗口外观不受系统颜色设置影响。
 *
 * 窗口激活状态 / 最大化状态变化后 DWM 会重新计算边框颜色，因此这些时机需要
 * 重新应用。Windows 10 及更早版本不支持该属性，调用失败时静默忽略。
 */

/** 固定的边框色 rgb(58, 58, 58)（COLORREF，0x00BBGGRR）。 */
const BORDER_COLOR = 0x003a3a3a;

/** 读取窗口原生句柄（HWND）的数值形式。 */
const readNativeHandle = (win: BrowserWindow): number => {
  const buffer = win.getNativeWindowHandle();
  // Windows 上句柄为指针宽度：64 位 8 字节、32 位 4 字节。
  return buffer.length >= 8
    ? Number(buffer.readBigInt64LE(0))
    : buffer.readUInt32LE(0);
};

/** 把窗口外边框固定为浅灰色，并在窗口状态变化后重新应用。 */
export const bindWindowBorderColor = (win: BrowserWindow): void => {
  if (!isWindows) {
    return;
  }

  const apply = (): void => {
    if (win.isDestroyed()) {
      return;
    }
    native
      .setWindowBorderColor(readNativeHandle(win), BORDER_COLOR)
      .catch(() => {
        // 原生模块不可用（开发环境未构建）或系统不支持该属性时忽略。
      });
  };

  apply();
  win.on("focus", apply);
  win.on("blur", apply);
  win.on("maximize", apply);
  win.on("unmaximize", apply);
  win.on("restore", apply);
  win.on("show", apply);
};
