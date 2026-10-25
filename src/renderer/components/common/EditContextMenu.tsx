import { CircleCheck, ClipboardPaste, Copy, Scissors } from "lucide-react";
import { useI18n } from "../../i18n";
import type { EditMenuState } from "../../hooks/useEditContextMenu";
import type { SnowEditCommand } from "../../../preload/modules/systemApi";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

type EditContextMenuProps = {
  menu: EditMenuState;
  onCommand: (command: SnowEditCommand) => void;
  onClose: () => void;
};

/**
 * 可编辑元素（输入框 / textarea / contentEditable）的右键菜单：
 * 剪切 / 复制 / 粘贴 / 全选，命令是否可用由 useEditContextMenu 判定，
 * 不可用的自动置灰。
 */
export const EditContextMenu = ({
  menu,
  onCommand,
  onClose,
}: EditContextMenuProps): React.JSX.Element => {
  const { t } = useI18n();
  const items: ContextMenuItem[] = [
    {
      id: "cut",
      label: t("common.cut"),
      icon: <Scissors size={13} strokeWidth={1.8} />,
      disabled: !menu.availability.cut,
      onClick: () => onCommand("cut"),
    },
    {
      id: "copy",
      label: t("common.copy"),
      icon: <Copy size={13} strokeWidth={1.8} />,
      disabled: !menu.availability.copy,
      onClick: () => onCommand("copy"),
    },
    {
      id: "paste",
      label: t("common.paste"),
      icon: <ClipboardPaste size={13} strokeWidth={1.8} />,
      disabled: !menu.availability.paste,
      onClick: () => onCommand("paste"),
    },
    {
      id: "selectAll",
      label: t("common.selectAll"),
      icon: <CircleCheck size={13} strokeWidth={1.8} />,
      separator: true,
      disabled: !menu.availability.selectAll,
      onClick: () => onCommand("selectAll"),
    },
  ];

  return <ContextMenu x={menu.x} y={menu.y} items={items} onClose={onClose} />;
};
