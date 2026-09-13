import { $ } from "./dom";

let noticeTimer: ReturnType<typeof setTimeout> | null = null;

/** 顶部浮动提示；2.2 秒后自动淡出。 */
export const showNotice = (text?: string | null, isError?: boolean): void => {
  if (noticeTimer !== null) clearTimeout(noticeTimer);
  const el = $("notice");
  el.textContent = text || "";
  el.className = "notice show" + (isError ? " error" : "");
  noticeTimer = setTimeout(() => {
    el.className = "notice";
    noticeTimer = null;
  }, 2200);
};
