/**
 * 桌面宠物系统 IPC 处理器。
 *
 * 主窗口设置界面：安装（zip 文件对话框）/ 列表 / 卸载 / 启用 / 选择 / 缩放。
 * 宠物窗口：拉取配置、拖拽位置、右键收起。
 */
import { dialog, ipcMain } from "electron";
import type { NativeBridge } from "../../native/types";
import {
  PET_SCALE_MAX,
  PET_SCALE_MIN,
  loadPetSettings,
  petSettingCodes,
  savePetSetting,
} from "../../pets/petSettings";
import {
  getCurrentPetConfig,
  refreshPetWindow,
  reportPetTurnEnded,
  reportPetTurnStarted,
} from "../../pets/petWindow";

export const registerPetHandlers = (native: NativeBridge): void => {
  // ── 主窗口设置界面 ─────────────────────────────────────────────────

  ipcMain.handle("pets:install-zip", async () => {
    const selection = await dialog.showOpenDialog({
      title: "Install Codex Pet Package",
      buttonLabel: "Install",
      filters: [
        { name: "Codex Pet Package", extensions: ["zip"] },
      ],
      properties: ["openFile"],
    });
    if (selection.canceled || selection.filePaths.length === 0) {
      return null;
    }

    const zipPath = selection.filePaths[0];
    const manifest = await native.installPetFromZip(zipPath);

    // 若尚未选择宠物，新安装的宠物自动设为激活。
    const settings = await loadPetSettings(native);
    if (!settings.activePetId) {
      await savePetSetting(native, petSettingCodes.activeId, manifest.id);
    }

    await refreshPetWindow(native);
    return manifest;
  });

  ipcMain.handle("pets:list", () => native.listInstalledPets());

  ipcMain.handle("pets:uninstall", async (_event, petId: unknown) => {
    if (typeof petId !== "string" || !petId.trim()) {
      throw new Error("Pet id is required");
    }

    await native.uninstallPet(petId.trim());

    // 卸载的是当前激活宠物时清空激活项并收起窗口。
    const settings = await loadPetSettings(native);
    if (settings.activePetId === petId.trim()) {
      await savePetSetting(native, petSettingCodes.activeId, "");
    }
    await refreshPetWindow(native);
  });

  ipcMain.handle("pets:get-settings", () => loadPetSettings(native));

  ipcMain.handle("pets:set-enabled", async (_event, enabled: unknown) => {
    if (typeof enabled !== "boolean") {
      throw new Error("Enabled flag must be a boolean");
    }
    await savePetSetting(native, petSettingCodes.enabled, enabled ? "1" : "0");
    await refreshPetWindow(native);
    return loadPetSettings(native);
  });

  ipcMain.handle("pets:set-active", async (_event, petId: unknown) => {
    if (typeof petId !== "string") {
      throw new Error("Pet id must be a string");
    }
    await savePetSetting(native, petSettingCodes.activeId, petId.trim());
    await refreshPetWindow(native);
    return loadPetSettings(native);
  });

  ipcMain.handle("pets:set-scale", async (_event, scale: unknown) => {
    const value = typeof scale === "number" ? scale : Number.NaN;
    if (!Number.isFinite(value)) {
      throw new Error("Scale must be a number");
    }
    const clamped = Math.min(PET_SCALE_MAX, Math.max(PET_SCALE_MIN, value));
    await savePetSetting(native, petSettingCodes.scale, String(clamped));
    await refreshPetWindow(native);
    return loadPetSettings(native);
  });

  // ── 宠物窗口 ───────────────────────────────────────────────────────

  ipcMain.handle("pets:get-config", () => getCurrentPetConfig());

  // AI 回合级联动：整条 agent loop 开始/彻底结束时由渲染层通知，
  // 使宠物在回合期间保持 running、仅在真正完成时 waving。
  ipcMain.on("pets:turn-start", () => {
    reportPetTurnStarted();
  });
  ipcMain.on("pets:turn-end", (_event, failed: unknown) => {
    reportPetTurnEnded(failed === true);
  });
};
