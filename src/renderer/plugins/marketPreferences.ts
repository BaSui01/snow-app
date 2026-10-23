/** 插件市场的界面偏好（localStorage，纯前端） */

const HIDE_INSTALLED_KEY = "snow:plugin-market:hide-installed";

export const readMarketHideInstalled = (): boolean => {
  try {
    return window.localStorage.getItem(HIDE_INSTALLED_KEY) === "1";
  } catch {
    return false;
  }
};

export const writeMarketHideInstalled = (value: boolean): void => {
  try {
    window.localStorage.setItem(HIDE_INSTALLED_KEY, value ? "1" : "0");
  } catch {
    // 存储不可用时忽略，仅影响下次打开
  }
};
