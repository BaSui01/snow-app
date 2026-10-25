import { useCallback, useRef, useState } from "react";
import type { SnowEditCommand } from "../../preload/modules/systemApi";

/** 右键编辑菜单的坐标与各命令可用性（不可用的命令在菜单里置灰）。 */
export type EditMenuState = {
  x: number;
  y: number;
  availability: Record<SnowEditCommand, boolean>;
};

export type EditContextMenuApi = {
  editMenu: EditMenuState | null;
  /** 在指定的可编辑元素上打开菜单（x / y 为 viewport 坐标）。 */
  openEditMenuForElement: (target: HTMLElement, x: number, y: number) => void;
  /** 执行菜单命令：先聚焦并还原右键时的选区，再交主进程派发真实编辑命令。 */
  runEditCommand: (command: SnowEditCommand) => void;
  closeEditMenu: () => void;
};

/** 编辑命令桥：主窗口 / 独立面板窗口是 window.snow，宠物窗口只有 window.petBridge。 */
type EditBridge = {
  hasClipboardContent: () => Promise<boolean>;
  runEditCommand: (command: SnowEditCommand) => Promise<void>;
};

const resolveEditBridge = (): EditBridge | undefined =>
  (window.snow as EditBridge | undefined) ?? window.petBridge;

const isTextControl = (
  el: HTMLElement,
): el is HTMLInputElement | HTMLTextAreaElement =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;

/** 目标元素内容是否为空（「全选」的禁用依据）。 */
const isTargetEmpty = (el: HTMLElement): boolean => {
  if (isTextControl(el)) {
    return el.value.length === 0;
  }
  // contentEditable：剥掉零宽占位字符后仍有文字，或含有图片（如备忘里的截图）
  // 才算有内容。
  const text = (el.textContent ?? "").replace(/\u200B/g, "").trim();
  return text.length === 0 && el.querySelector("img") === null;
};

/**
 * 可编辑元素的右键菜单状态与命令执行（剪切 / 复制 / 粘贴 / 全选）。
 *
 * 应用未提供原生编辑菜单，且渲染进程的 document.execCommand("paste") 受
 * 剪贴板读取权限限制，命令统一交主进程执行（IPC edit:command）；各命令是否
 * 可用在打开菜单时判定，不可用的自动置灰。
 *
 * 目标元素由调用方传入（见 common/GlobalEditContextMenu），本 hook 只管状态与
 * 命令，整个窗口共用一个实例。
 */
export const useEditContextMenu = (): EditContextMenuApi => {
  const [editMenu, setEditMenu] = useState<EditMenuState | null>(null);
  // 右键命中的元素与当时的选区/光标：菜单项点击会先夺走焦点，执行命令前
  // 必须还原，否则 focus() 会让 Chromium 在行首新建光标，命令落到错误位置。
  const targetRef = useRef<HTMLElement | null>(null);
  const textSelectionRef = useRef<{ start: number; end: number } | null>(null);
  const rangeRef = useRef<Range | null>(null);

  const closeEditMenu = useCallback(() => {
    setEditMenu(null);
  }, []);

  const openEditMenuForElement = useCallback(
    (target: HTMLElement, x: number, y: number) => {
      targetRef.current = target;
      textSelectionRef.current = null;
      rangeRef.current = null;

      let hasSelection = false;
      if (isTextControl(target)) {
        const start = target.selectionStart ?? 0;
        const end = target.selectionEnd ?? 0;
        textSelectionRef.current = { start, end };
        hasSelection = end > start;
      } else {
        const selection = window.getSelection();
        const range =
          selection && selection.rangeCount > 0
            ? selection.getRangeAt(0)
            : null;
        if (range && target.contains(range.commonAncestorContainer)) {
          rangeRef.current = range.cloneRange();
          hasSelection = !range.collapsed;
        }
      }

      setEditMenu({
        x,
        y,
        availability: {
          // 无选区时剪切/复制无意义（对齐原生编辑菜单）。
          cut: hasSelection,
          copy: hasSelection,
          // 粘贴可用性取决于系统剪贴板，异步确认后再放开（先置灰避免误报）。
          paste: false,
          selectAll: !isTargetEmpty(target),
        },
      });
      void resolveEditBridge()
        ?.hasClipboardContent()
        .then((hasContent) => {
          setEditMenu((prev) =>
            prev
              ? {
                  ...prev,
                  availability: { ...prev.availability, paste: hasContent },
                }
              : prev,
          );
        })
        .catch(() => {});
    },
    [],
  );

  const runEditCommand = useCallback((command: SnowEditCommand) => {
    setEditMenu(null);
    const target = targetRef.current;
    if (!target) {
      return;
    }
    // 点击菜单项已把焦点移到菜单上：先聚焦目标元素并还原右键时的选区/光标。
    target.focus({ preventScroll: true });
    if (isTextControl(target)) {
      const selection = textSelectionRef.current;
      if (selection) {
        target.setSelectionRange(selection.start, selection.end);
      }
    } else {
      const range = rangeRef.current;
      if (
        range &&
        range.startContainer.isConnected &&
        range.endContainer.isConnected
      ) {
        const selection = window.getSelection();
        if (selection) {
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }
    }
    void resolveEditBridge()
      ?.runEditCommand(command)
      .catch(() => {});
  }, []);

  return { editMenu, openEditMenuForElement, runEditCommand, closeEditMenu };
};
