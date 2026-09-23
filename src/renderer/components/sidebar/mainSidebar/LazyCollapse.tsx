import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { useI18n } from "../../../i18n";
import { SidebarCollapse } from "./SidebarCollapse";

type LazyCollapseProps = {
  open: boolean;
  /** 真实内容工厂：折叠状态下不会被调用 */
  renderContent: () => React.ReactNode;
};

/**
 * 按需渲染的折叠面板：折叠后不保留内容 DOM（避免长列表在拖动面板宽度时
 * 反复重排），展开时先渲染 loading 占位并播放高度过渡，过渡结束后再渲染
 * 真实内容（子代理列表 / Workflow 节点树）。
 */
export function LazyCollapse({
  open,
  renderContent,
}: LazyCollapseProps): React.JSX.Element | null {
  const { t } = useI18n();
  // isMounted：内容 DOM 是否保留；isExpanded：是否已应用展开态（驱动高度过渡）；
  // isContentReady：是否已渲染真实内容（否则为 loading 占位）
  const [isMounted, setIsMounted] = useState(open);
  const [isExpanded, setIsExpanded] = useState(open);
  const [isContentReady, setIsContentReady] = useState(open);

  // 展开时当帧先挂载 0 高度骨架（loading 占位），保证后续存在过渡起点
  if (open && !isMounted) {
    setIsMounted(true);
    setIsContentReady(false);
  }

  // 骨架挂载后延迟两帧再应用展开态：同一帧内修改样式会被浏览器合并成一次，过渡不会生效
  useEffect(() => {
    if (!open || !isMounted || isExpanded) {
      return;
    }
    let innerFrame = 0;
    const outerFrame = window.requestAnimationFrame(() => {
      innerFrame = window.requestAnimationFrame(() => setIsExpanded(true));
    });
    return () => {
      window.cancelAnimationFrame(outerFrame);
      window.cancelAnimationFrame(innerFrame);
    };
  }, [open, isMounted, isExpanded]);

  // 骨架阶段就被收起（没有过渡可播放）：直接卸载
  useEffect(() => {
    if (open || !isMounted || isExpanded) {
      return;
    }
    setIsMounted(false);
    setIsContentReady(false);
  }, [open, isMounted, isExpanded]);

  const handleTransitionEnd = (): void => {
    if (open) {
      setIsContentReady(true);
      return;
    }
    setIsMounted(false);
    setIsExpanded(false);
    setIsContentReady(false);
  };

  if (!isMounted) {
    return null;
  }

  return (
    <SidebarCollapse
      open={open && isExpanded}
      onTransitionEnd={handleTransitionEnd}
    >
      {isContentReady ? (
        renderContent()
      ) : (
        <span className="sidebar-collapse-loading">
          <Loader2 size={12} className="spin" />
          {t("sidebar.loadingPanel", { defaultValue: "Loading..." })}
        </span>
      )}
    </SidebarCollapse>
  );
}
