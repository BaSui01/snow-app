/**
 * 应用内置桌面宠物的安装与去重。
 *
 * 内置宠物包位于 `resources/pets/*.zip`（打包后由 electron-builder
 * extraResources 复制到 `resourcesPath/pets`，即 asar 之外的实体文件），
 * 首次安装、应用升级或内置包内容变化时调用 Rust 后端解压安装到
 * `~/.snowapp/pets/{id}/`；解压、校验、落盘全部在 Rust 侧的
 * spawn_blocking 中完成，不阻塞 Electron 主进程。
 *
 * 去重策略：
 * - 安装目标是手动安装 / Codex App / Petdex 共用的 id 命名空间，
 *   Rust 的 install_pet_from_zip 会覆盖 `~/.snowapp/pets/{id}/` 下的旧目录，
 *   老用户提前装过同名宠物不会产生重复条目（list_installed_pets 按
 *   snow > codex > petdex 优先级按 id 去重）。
 * - 内置宠物以 builtin=true 安装，Rust 侧标记为内置：不可卸载，也不能被
 *   手动安装的同 id 包覆盖。
 * - 标记文件 `~/.snowapp/builtin-pets.json` 记录「应用版本 + 各 zip 指纹 +
 *   已安装的内置宠物 id」。标记匹配且这些宠物仍以内置身份存在时直接跳过；
 *   升级、内置包变化或宠物目录丢失时重新安装。
 */
import { app } from "electron";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BUILTIN_PETS_DIR } from "../app/constants";
import type { NativeBridge } from "../native/types";
import { loadPetSettings, savePetSettings } from "./petSettings";
import { snowLog } from "../../utils/snowLogger";

/** 应用自有数据目录名（~/.snowapp）。 */
const APP_DATA_DIR_NAME = ".snowapp";
/** 内置宠物安装标记文件名（位于 ~/.snowapp/ 下）。 */
const MARKER_FILE_NAME = "builtin-pets.json";

/** 标记内容：应用版本 + 全部内置包指纹 + 已安装的内置宠物 id。 */
type BuiltinPetsMarker = {
  version: string;
  signature: string;
  ids: string[];
};

const markerFilePath = (): string =>
  join(homedir(), APP_DATA_DIR_NAME, MARKER_FILE_NAME);

/** 单个内置包指纹：字节数 + 修改时间（打包后为真实文件，stat 可用）。 */
const archiveFingerprint = (file: string): string => {
  try {
    const stat = statSync(file);
    return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return "-";
  }
};

/** 读取已有标记；缺失或损坏时返回 null（视为需要重新安装）。 */
const readMarker = (): BuiltinPetsMarker | null => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(markerFilePath(), "utf8"));
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const { version, signature, ids } = parsed as Record<string, unknown>;
    if (
      typeof version !== "string" ||
      typeof signature !== "string" ||
      !Array.isArray(ids)
    ) {
      return null;
    }
    return {
      version,
      signature,
      ids: ids.filter((id): id is string => typeof id === "string"),
    };
  } catch {
    return null;
  }
};

/** 标记中记录的内置宠物是否都仍以内置身份存在（缺失时需要补装）。 */
const builtinPetsPresent = async (
  native: NativeBridge,
  ids: string[],
): Promise<boolean> => {
  const installed = await native.listInstalledPets();
  return ids.every((id) =>
    installed.some((pet) => pet.id === id && pet.builtin),
  );
};

/**
 * 安装随应用打包的内置宠物包。调用方需保证存储已就绪
 * （installPetFromZip 经 native 代理门控，会在存储就绪后执行）。
 */
export const ensureBuiltinPets = async (
  native: NativeBridge,
): Promise<void> => {
  let archives: string[];
  try {
    archives = readdirSync(BUILTIN_PETS_DIR, { withFileTypes: true })
      .filter(
        (entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".zip"),
      )
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    // 打包时资源缺失不应阻断启动，记录后跳过。
    snowLog.warn({
      module: "app/pets",
      func: "ensureBuiltinPets",
      message: "Builtin pets source dir not found, skipping install",
      context: BUILTIN_PETS_DIR,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (archives.length === 0) {
    return;
  }

  const version = app.getVersion();
  const signature = archives
    .map(
      (name) => `${name}=${archiveFingerprint(join(BUILTIN_PETS_DIR, name))}`,
    )
    .join("|");

  const marker = readMarker();
  if (
    marker &&
    marker.version === version &&
    marker.signature === signature &&
    (await builtinPetsPresent(native, marker.ids))
  ) {
    return;
  }

  let installedIds: string[] = [];
  let failed = 0;
  for (const name of archives) {
    try {
      const manifest = await native.installPetFromZip(
        join(BUILTIN_PETS_DIR, name),
        true,
      );
      installedIds.push(manifest.id);
    } catch (error) {
      failed++;
      snowLog.warn({
        module: "app/pets",
        func: "ensureBuiltinPets",
        message: `Failed to install builtin pet package: ${name}`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // 全部失败时不写标记，留待下次启动重试。
  if (installedIds.length === 0) {
    return;
  }

  // 尚未选择宠物时，把首个内置宠物设为激活项（与手动安装语义一致）。
  try {
    const settings = await loadPetSettings(native);
    if (!settings.activePetId) {
      await savePetSettings(native, {
        ...settings,
        activePetId: installedIds[0],
      });
    }
  } catch (error) {
    snowLog.warn({
      module: "app/pets",
      func: "ensureBuiltinPets",
      message: "Failed to activate builtin pet",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const file = markerFilePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ version, signature, ids: installedIds }),
      "utf8",
    );
  } catch (error) {
    snowLog.warn({
      module: "app/pets",
      func: "ensureBuiltinPets",
      message: "Failed to write builtin pets marker",
      error: error instanceof Error ? error.message : String(error),
    });
  }

  snowLog.info({
    module: "app/pets",
    func: "ensureBuiltinPets",
    message: `Builtin pets installed (${installedIds.length} installed, ${failed} failed)`,
    context: `${BUILTIN_PETS_DIR} (version ${version})`,
  });
};
