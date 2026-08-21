import type { ReactNode } from "react";

import { isMacOS } from "../../utils/shortcutUtils";

/**
 * 系统文件管理器图标（内联 SVG）：
 * - macOS：访达（Finder），取自 IconPark mac-finder（Apache 2.0，svgrepo 387985），
 *   调整为官方蓝色并去除黑色描边
 * - Windows：资源管理器黄色文件夹
 * - 其他平台：沿用资源管理器文件夹样式
 */

type FileManagerIconProps = {
  size?: number;
};

type SvgProps = {
  children: ReactNode;
  size: number;
  viewBox: string;
};

const Svg = ({ size, viewBox, children }: SvgProps): React.JSX.Element => (
  <svg
    className="ide-icon"
    height={size}
    viewBox={viewBox}
    width={size}
    xmlns="http://www.w3.org/2000/svg"
  >
    {children}
  </svg>
);

/** macOS 访达：蓝底圆角方块 + 白色双面笑脸 */
export const FinderIcon = ({
  size = 16,
}: FileManagerIconProps): React.JSX.Element => (
  <Svg size={size} viewBox="0 0 48 48">
    <path
      d="M44 38V10C44 8.9 43.1 8 42 8H6C4.9 8 4 8.9 4 10v28c0 1.1.9 2 2 2h36c1.1 0 2-.9 2-2Z"
      fill="#0a84ff"
    />
    <path
      d="M25 8c0 0-5 10-4 17h6l1 15"
      fill="none"
      stroke="#fff"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="4"
    />
    <path d="M30 8H18" stroke="#0a5fcf" strokeLinecap="round" strokeWidth="4" />
    <path
      d="M34 40H22"
      stroke="#0a5fcf"
      strokeLinecap="round"
      strokeWidth="4"
    />
    <path
      d="M34 16v2M14 16v2"
      stroke="#fff"
      strokeLinecap="round"
      strokeWidth="4"
    />
    <path
      d="M13 29c0 0 4.2 3 11 3s11-3 11-3"
      fill="none"
      stroke="#fff"
      strokeLinecap="round"
      strokeWidth="4"
    />
  </Svg>
);

/** Windows 资源管理器：黄色文件夹 */
export const ExplorerIcon = ({
  size = 16,
}: FileManagerIconProps): React.JSX.Element => (
  <Svg size={size} viewBox="0 0 24 24">
    <path
      d="M3.5 7.75A1.75 1.75 0 0 1 5.25 6h3.55c.46 0 .9.18 1.23.51l1.21 1.21c.33.33.77.51 1.23.51H18.5a2 2 0 0 1 2 2v.52H3.5V7.75Z"
      fill="#e8a33d"
    />
    <path
      d="M3.5 10.25h17a.75.75 0 0 1 .75.75v4.75A2.75 2.75 0 0 1 18.5 18.5h-13a2.75 2.75 0 0 1-2.75-2.75V11a.75.75 0 0 1 .75-.75Z"
      fill="#f8c14d"
    />
    <path d="M3.5 13h17v1.4H3.5z" fill="#ffdd85" opacity="0.85" />
  </Svg>
);

/** 按当前平台渲染对应文件管理器图标 */
export const FileManagerIcon = (
  props: FileManagerIconProps,
): React.JSX.Element =>
  isMacOS() ? <FinderIcon {...props} /> : <ExplorerIcon {...props} />;
