const legacyCopy = (text: string): boolean => {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-9999px";
  area.style.top = "0";
  document.body.append(area);
  area.select();
  area.setSelectionRange(0, area.value.length);
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  area.remove();
  return copied;
};

/**
 * 复制文本到剪贴板。
 *
 * 手机远控经 LAN 走 http 访问，页面不是安全上下文，navigator.clipboard
 * 通常不可用；此时退回 execCommand("copy") 的旧通道（与 unlock.ts 的
 * 粘贴读取同一思路）。
 */
export const copyTextToClipboard = async (text: string): Promise<boolean> => {
  const clipboard = navigator.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      return legacyCopy(text);
    }
  }
  return legacyCopy(text);
};
