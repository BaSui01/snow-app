import { useEffect } from "react";
import { EditContextMenu } from "./EditContextMenu";
import { useEditContextMenu } from "../../hooks/useEditContextMenu";

/** 只有文本类 input 适用编辑菜单（checkbox / radio / range 等交回原生行为）。 */
const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
]);

/** 可编辑元素：input / textarea / contentEditable（chip 等 contenteditable=false 不算）。 */
const EDITABLE_SELECTOR =
  "input, textarea, [contenteditable]:not([contenteditable='false'])";

/**
 * 命中可编辑元素时返回该元素，否则返回 null。
 *
 * point 为右键位置：元素必须真的覆盖该点。终端等库会把辅助 textarea 放在屏幕外
 * 承载键盘输入，它们有自己的右键行为，不能被当作可编辑元素接管。
 */
export const resolveEditableTarget = (
  node: EventTarget | null,
  point?: { x: number; y: number },
): HTMLElement | null => {
  if (!(node instanceof Element)) {
    return null;
  }
  const target = node.closest<HTMLElement>(EDITABLE_SELECTOR);
  if (!target || target.hasAttribute("disabled")) {
    return null;
  }
  if (
    target instanceof HTMLInputElement &&
    !TEXT_INPUT_TYPES.has(target.type)
  ) {
    return null;
  }
  if (point) {
    const rect = target.getBoundingClientRect();
    if (
      point.x < rect.left ||
      point.x > rect.right ||
      point.y < rect.top ||
      point.y > rect.bottom
    ) {
      return null;
    }
  }
  return target;
};

/**
 * 全局编辑右键菜单宿主：每个渲染进程窗口挂一个（主窗口 / 独立面板窗口 / 宠物窗口）。
 *
 * 在 document 上以冒泡阶段监听 contextmenu，因此元素自带的右键菜单（React 的
 * onContextMenu 挂在根容器上，先于 document 执行）仍优先：它们一旦
 * preventDefault（如输入区的网页引用 chip 菜单），这里就不再接管。其余情况下
 * 命中 input / textarea / contentEditable 时统一弹出剪切 / 复制 / 粘贴 / 全选，
 * 因此全项目输入框无需各自绑定。
 */
export const GlobalEditContextMenu = (): React.JSX.Element | null => {
  const { editMenu, openEditMenuForElement, runEditCommand, closeEditMenu } =
    useEditContextMenu();

  useEffect(() => {
    const handleContextMenu = (event: MouseEvent): void => {
      if (event.defaultPrevented) {
        return;
      }
      const point = { x: event.clientX, y: event.clientY };
      const target = resolveEditableTarget(event.target, point);
      if (!target) {
        return;
      }
      event.preventDefault();
      openEditMenuForElement(target, point.x, point.y);
    };
    document.addEventListener("contextmenu", handleContextMenu);
    return () => {
      document.removeEventListener("contextmenu", handleContextMenu);
    };
  }, [openEditMenuForElement]);

  if (!editMenu) {
    return null;
  }

  return (
    <EditContextMenu
      menu={editMenu}
      onCommand={runEditCommand}
      onClose={closeEditMenu}
    />
  );
};
