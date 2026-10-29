/**
 * 默认宠物头像：取内置宠物 idle 首帧，抠图后按不透明包围盒裁出顶部正方形（头部）。
 */
import { useEffect, useState } from "react";
import type { PetManifest } from "../../../preload/types/pets";
import { themeBgUrl } from "../../utils/themeBgUrl";

const AVATAR_SIZE = 96;
const ALPHA_THRESHOLD = 8;

const avatarCache = new Map<string, Promise<string | null>>();
let defaultPetPromise: Promise<PetManifest | null> | null = null;

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load pet spritesheet"));
    image.src = src;
  });

const cropHeadAvatar = (
  image: HTMLImageElement,
  columns: number,
  rows: number,
): string | null => {
  const frameWidth = Math.floor(image.naturalWidth / columns);
  const frameHeight = Math.floor(image.naturalHeight / rows);
  if (frameWidth <= 0 || frameHeight <= 0) {
    return null;
  }
  const frame = document.createElement("canvas");
  frame.width = frameWidth;
  frame.height = frameHeight;
  const ctx = frame.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return null;
  }
  ctx.drawImage(
    image,
    0,
    0,
    frameWidth,
    frameHeight,
    0,
    0,
    frameWidth,
    frameHeight,
  );
  const imageData = ctx.getImageData(0, 0, frameWidth, frameHeight);
  const data = imageData.data;
  let minX = frameWidth;
  let minY = frameHeight;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < frameHeight; y += 1) {
    for (let x = 0; x < frameWidth; x += 1) {
      const i = (y * frameWidth + x) * 4;
      // 品红背景抠图，与 prepareSpritesheet 一致
      if (data[i] > 180 && data[i + 1] < 90 && data[i + 2] > 180) {
        data[i + 3] = 0;
        continue;
      }
      if (data[i + 3] > ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) {
    return null;
  }
  ctx.putImageData(imageData, 0, 0);

  const boxWidth = maxX - minX + 1;
  const boxHeight = maxY - minY + 1;
  const side = Math.min(boxWidth, boxHeight);
  const sourceX = minX + (boxWidth - side) / 2;

  const output = document.createElement("canvas");
  output.width = AVATAR_SIZE;
  output.height = AVATAR_SIZE;
  const outCtx = output.getContext("2d");
  if (!outCtx) {
    return null;
  }
  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = "high";
  const padding = Math.round(AVATAR_SIZE * 0.06);
  outCtx.drawImage(
    frame,
    sourceX,
    minY,
    side,
    side,
    padding,
    padding,
    AVATAR_SIZE - padding * 2,
    AVATAR_SIZE - padding * 2,
  );
  return output.toDataURL("image/png");
};

/** 生成指定宠物的头像 data URL（按精灵图路径缓存）。 */
export const loadPetAvatar = (
  manifest: PetManifest,
): Promise<string | null> => {
  const cached = avatarCache.get(manifest.spritesheetPath);
  if (cached) {
    return cached;
  }
  const columns = manifest.columns > 0 ? manifest.columns : 8;
  const rows = manifest.rows > 0 ? manifest.rows : 9;
  const task = loadImage(themeBgUrl(manifest.spritesheetPath))
    .then((image) => cropHeadAvatar(image, columns, rows))
    .catch(() => null);
  avatarCache.set(manifest.spritesheetPath, task);
  return task;
};

/** 默认宠物：优先内置宠物，其次第一个已安装宠物；未就绪时不缓存以便重试。 */
const resolveDefaultPet = (): Promise<PetManifest | null> => {
  if (!defaultPetPromise) {
    defaultPetPromise = window.snow
      .listInstalledPets()
      .then((pets) => pets.find((pet) => pet.builtin) ?? pets[0] ?? null)
      .catch(() => null)
      .then((pet) => {
        if (!pet) {
          defaultPetPromise = null;
        }
        return pet;
      });
  }
  return defaultPetPromise;
};

/** 默认宠物头像（加载中或无宠物时为 null）。 */
export const useDefaultPetAvatar = (enabled = true): string | null => {
  const [avatar, setAvatar] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    void resolveDefaultPet()
      .then((pet) => (pet ? loadPetAvatar(pet) : null))
      .then((url) => {
        if (!cancelled) {
          setAvatar(url);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return avatar;
};
