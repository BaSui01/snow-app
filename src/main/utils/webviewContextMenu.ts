import { app, BrowserWindow, clipboard, Menu, type MenuItemConstructorOptions } from "electron";

let installed = false;

/**
 * 为嵌入式浏览器（<webview> guest 页面）安装右键菜单。
 *
 * 背景：Electron 的 <webview> 标签默认没有右键菜单（不像 Chrome 内置
 * 浏览器菜单），必须监听 guest webContents 的 `context-menu` 事件并手动
 * 用 Menu.popup 弹出，否则浏览器里右键没有任何反应。
 *
 * 菜单项按上下文动态生成：
 *   - 可编辑区域：剪切 / 复制 / 粘贴（依据 editFlags）
 *   - 链接上：复制链接地址
 *   - 图片上：复制图片地址
 *   - 导航：后退 / 前进 / 刷新（按历史记录启用/禁用）
 *   - 全选、检查元素（DevTools）
 */
export const installWebviewContextMenu = (): void => {
  if (installed) {
    return;
  }
  installed = true;

  app.on("web-contents-created", (_event, contents) => {
    if (contents.getType() !== "webview") {
      return;
    }

    contents.on("context-menu", (_event, params) => {
      const template: MenuItemConstructorOptions[] = [];

      // 编辑组：仅当目标可编辑/有选区时显示。
      const editItems: MenuItemConstructorOptions[] = [];
      if (params.editFlags.canCut) {
        editItems.push({ role: "cut", label: "剪切" });
      }
      if (params.editFlags.canCopy) {
        editItems.push({ role: "copy", label: "复制" });
      }
      if (params.editFlags.canPaste) {
        editItems.push({ role: "paste", label: "粘贴" });
      }
      if (editItems.length > 0) {
        template.push(...editItems, { type: "separator" });
      }

      // 链接：复制地址。
      if (params.linkURL) {
        template.push({
          label: "复制链接地址",
          click: () => clipboard.writeText(params.linkURL),
        });
        template.push({ type: "separator" });
      }

      // 图片：复制地址。
      if (params.srcURL && params.mediaType === "image") {
        template.push({
          label: "复制图片地址",
          click: () => clipboard.writeText(params.srcURL),
        });
        template.push({ type: "separator" });
      }

      // 导航组。
      template.push(
        {
          label: "后退",
          enabled: contents.canGoBack(),
          click: () => contents.goBack(),
        },
        {
          label: "前进",
          enabled: contents.canGoForward(),
          click: () => contents.goForward(),
        },
        { role: "reload", label: "刷新" },
        { type: "separator" },
        { role: "selectAll", label: "全选" },
        { type: "separator" },
        {
          label: "检查元素",
          click: () => contents.inspectElement(params.x, params.y),
        }
      );

      // popup 挂到宿主窗口（webview guest 的 hostWebContents 对应主窗口）。
      const hostWindow = contents.hostWebContents
        ? BrowserWindow.fromWebContents(contents.hostWebContents)
        : undefined;
      Menu.buildFromTemplate(template).popup({ window: hostWindow ?? undefined });
    });
  });
};
