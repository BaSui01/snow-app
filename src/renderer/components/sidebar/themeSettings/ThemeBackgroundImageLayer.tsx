/**
 * 背景图片层：把背景图列表铺在界面最上层，支持多图自动轮播与交叉淡化。
 *
 * 数据来源是模块级背景快照（applyBackgroundToDocument 写入），因此主题 Hook、
 * 设置面板实时预览与启动缓存三条路径都能即时驱动本组件。不透明度 / 模糊
 * 直接读取 :root 上的 CSS 变量（由同一函数维护），拖动滑块无需重渲染。
 *
 * 播放位置由 background.currentImagePath 驱动并被持久化记忆：
 * - 顺序模式：启动 / 重新开启轮播时，从上次显示的那张图继续往后播放；
 * - 随机模式：每次开始播放（启动、重新开启、切到随机）随机挑一张作为起点；
 * - 关闭轮播 / 点击缩略图固定时，当前显示的图会被记住，重启后仍显示它。
 * 每次实际切换成功后通过 persistBackgroundCurrentImagePath 节流写回后端。
 * 切换前先预加载目标图，成功后再交叉淡化，避免闪黑；窗口隐藏时跳过本轮。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ThemeCarouselOrder } from "./types";
import {
  getActiveBackground,
  subscribeActiveBackground,
} from "./backgroundLayerStore";
import {
  CAROUSEL_INTERVAL_MIN_SECS,
  persistBackgroundCurrentImagePath,
} from "./themeSettingsUtils";
import { themeBgUrl } from "../../../utils/themeBgUrl";

/** 双缓冲槽位状态：两层背景图中当前激活的槽位。 */
type LayerSlots = {
  paths: [string, string];
  active: 0 | 1;
};

/** 计算下一张图片下标：顺序循环 / 随机（避免与当前重复）。 */
const resolveNextIndex = (
  order: ThemeCarouselOrder,
  currentIndex: number,
  length: number,
): number => {
  if (length <= 0) {
    return 0;
  }
  if (order === "random" && length > 1) {
    let next = currentIndex;
    while (next === currentIndex) {
      next = Math.floor(Math.random() * length);
    }
    return next;
  }
  return (currentIndex + 1) % length;
};

/** 预加载图片（theme-bg:// 协议），加载完成 / 失败后 resolve。 */
const preloadBackgroundImage = (path: string): Promise<boolean> =>
  new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = themeBgUrl(path);
  });

export function ThemeBackgroundImageLayer(): React.JSX.Element | null {
  const background = useSyncExternalStore(
    subscribeActiveBackground,
    getActiveBackground,
  );
  // 双缓冲：两层各持一张图，active 槽常驻显示；切图时先给非 active 槽换上
  // 目标图再翻转 active，由 CSS transition 完成交叉淡化。
  const [slots, setSlots] = useState<LayerSlots>({
    paths: ["", ""],
    active: 0,
  });
  const slotsRef = useRef(slots);
  const imagePathsRef = useRef<string[]>([]);
  slotsRef.current = slots;

  const imagePaths = background?.imagePaths ?? [];
  imagePathsRef.current = imagePaths;
  // 以内容为依赖键，捕获列表编辑（增删 / 重排）而不受数组引用变化影响。
  const imagePathsKey = imagePaths.join("\n");

  const enabled =
    Boolean(background?.enabled) &&
    background?.source === "image" &&
    imagePaths.length > 0;
  // 供预加载完成回调判断：背景在加载期间被关闭时，放弃这次切换（不翻转槽位、不写位置）。
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const carouselActive =
    enabled && Boolean(background?.carouselEnabled) && imagePaths.length >= 2;
  const carouselIntervalSecs = background?.carouselIntervalSecs ?? 0;
  const carouselOrder: ThemeCarouselOrder =
    background?.carouselOrder ?? "sequential";
  // 期望显示的图片：优先持久化的当前图（必须仍在列表中），否则回退首张。
  const rawCurrentImagePath = background?.currentImagePath ?? "";
  const desiredPath = imagePaths.includes(rawCurrentImagePath)
    ? rawCurrentImagePath
    : (imagePaths[0] ?? "");

  /**
   * 切换显示到目标图：先预加载，成功后翻转槽位并持久化「当前显示图」。
   * 预加载期间列表可能变化，加载完成后再次确认目标仍在列表中。
   */
  const switchToPath = useCallback((target: string): void => {
    if (!target) {
      return;
    }
    if (slotsRef.current.paths[slotsRef.current.active] === target) {
      return;
    }
    void preloadBackgroundImage(target).then((loaded) => {
      if (
        !loaded ||
        !enabledRef.current ||
        !imagePathsRef.current.includes(target)
      ) {
        // 加载失败 / 背景已被关闭 / 目标已被移除：放弃本次切换，保持当前画面。
        return;
      }
      const latest = slotsRef.current;
      if (latest.paths[latest.active] === target) {
        return;
      }
      const nextSlot: 0 | 1 = latest.active === 0 ? 1 : 0;
      const nextPaths: [string, string] = [latest.paths[0], latest.paths[1]];
      nextPaths[nextSlot] = target;
      setSlots({ paths: nextPaths, active: nextSlot });
      // 记录当前显示图（节流持久化），供下次启动续播 / 固定恢复。
      persistBackgroundCurrentImagePath(target);
    });
  }, []);

  const wasCarouselActiveRef = useRef(false);
  const previousOrderRef = useRef<ThemeCarouselOrder>(carouselOrder);

  // 显示决策（单一入口）：
  // 1) 默认显示持久化的当前图（或列表首张）；
  // 2) 随机模式「开始播放」时（启动 / 重新开启轮播 / 切到随机）随机起播；
  // 3) 列表编辑导致当前图失效时回退到列表首张。
  useEffect(() => {
    if (!enabled) {
      wasCarouselActiveRef.current = false;
      previousOrderRef.current = carouselOrder;
      return;
    }
    const startedNow = carouselActive && !wasCarouselActiveRef.current;
    const orderChangedToRandom =
      carouselActive &&
      carouselOrder === "random" &&
      previousOrderRef.current !== "random";
    wasCarouselActiveRef.current = carouselActive;
    previousOrderRef.current = carouselOrder;

    const paths = imagePathsRef.current;
    const current = slotsRef.current;
    const displayed = current.paths[current.active];
    let target = desiredPath;
    if (
      (startedNow || orderChangedToRandom) &&
      carouselOrder === "random" &&
      paths.length >= 2
    ) {
      const currentIndex = displayed
        ? Math.max(0, paths.indexOf(displayed))
        : 0;
      target =
        paths[resolveNextIndex("random", currentIndex, paths.length)] ?? "";
    }
    if (!target || displayed === target) {
      return;
    }
    switchToPath(target);
    // imagePathsKey 捕获列表内容变化；carouselActive / carouselOrder 捕获起播与模式切换。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    desiredPath,
    imagePathsKey,
    carouselActive,
    carouselOrder,
    switchToPath,
  ]);

  // 轮播定时器：仅在开启轮播且图片数量 >= 2 时运行。
  useEffect(() => {
    if (!carouselActive) {
      return;
    }
    const intervalMs =
      Math.max(CAROUSEL_INTERVAL_MIN_SECS, carouselIntervalSecs) * 1000;
    const timer = window.setInterval(() => {
      // 窗口隐藏（最小化 / 切到其他桌面）时跳过本轮，恢复可见后继续。
      if (document.visibilityState === "hidden") {
        return;
      }
      const paths = imagePathsRef.current;
      if (paths.length < 2) {
        return;
      }
      const currentPath = slotsRef.current.paths[slotsRef.current.active];
      const currentIndex = Math.max(0, paths.indexOf(currentPath));
      const nextIndex = resolveNextIndex(
        carouselOrder,
        currentIndex,
        paths.length,
      );
      switchToPath(paths[nextIndex]);
    }, intervalMs);
    return () => {
      window.clearInterval(timer);
    };
  }, [carouselActive, carouselIntervalSecs, carouselOrder, switchToPath]);

  if (!enabled) {
    return null;
  }

  return (
    <div className="theme-bg-image-layer" aria-hidden="true">
      <div
        className={`theme-bg-image-slot${slots.active === 0 ? " active" : ""}`}
        style={
          slots.paths[0]
            ? { backgroundImage: `url("${themeBgUrl(slots.paths[0])}")` }
            : undefined
        }
      />
      <div
        className={`theme-bg-image-slot${slots.active === 1 ? " active" : ""}`}
        style={
          slots.paths[1]
            ? { backgroundImage: `url("${themeBgUrl(slots.paths[1])}")` }
            : undefined
        }
      />
    </div>
  );
}
