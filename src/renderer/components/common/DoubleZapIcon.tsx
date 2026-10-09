import type { SVGProps } from "react";

/**
 * 双闪电图标（24x24 viewBox，笔画风格与 lucide 一致）。
 * lucide 只有单闪电 `Zap`，这里用于区分 Fast（单闪电）与 UltraFast（双闪电）。
 */
type DoubleZapIconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
};

export function DoubleZapIcon({
  size = 16,
  className,
  strokeWidth = 2,
  ...rest
}: DoubleZapIconProps): React.JSX.Element {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      {...rest}
    >
      <path d="M9.2 3 2.4 13.6h2.6l.7 7.9 5.2-12.2H8.3Z" />
      <path d="M19.9 3 13.1 13.6h2.6l.7 7.9 5.2-12.2H19Z" />
    </svg>
  );
}
