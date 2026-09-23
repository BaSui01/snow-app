type SidebarCollapseProps = {
  open: boolean;
  children: React.ReactNode;
  /** 自身高度过渡（展开/收起动画）播放结束时回调 */
  onTransitionEnd?: () => void;
};

export function SidebarCollapse({
  open,
  children,
  onTransitionEnd,
}: SidebarCollapseProps): React.JSX.Element {
  return (
    <div
      className={`sidebar-collapse${open ? " is-open" : ""}`}
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        onTransitionEnd?.();
      }}
    >
      <div className="sidebar-collapse-inner">{children}</div>
    </div>
  );
}
