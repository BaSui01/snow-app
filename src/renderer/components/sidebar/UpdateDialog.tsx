import { Download, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { useI18n } from "../../i18n";
import type { UpdateStatus } from "../../../preload";
import { Modal } from "../common/Modal";
import { MarkdownBlock } from "../mainContent/chatMessages/components/markdownRenderer";

const INITIAL_UPDATE_STATUS: UpdateStatus = {
  available: false,
  version: null,
  downloading: false,
  progress: 0,
  downloaded: false,
  error: null,
  releaseNotes: null,
  releaseNotesZh: null,
};

type UpdateDialogProps = {
  open: boolean;
  onClose: () => void;
};

/**
 * 渲染层事件：请求打开更新弹窗。
 * 弹窗实例常驻侧边栏（MainSidebarContent），设置面板等其他入口
 * 通过 dispatch 该事件打开弹窗，避免多实例与状态重复。
 */
export const OPEN_UPDATE_DIALOG_EVENT = "app:open-update-dialog";

/**
 * 将 HTML 格式的发行说明转换为可渲染的 markdown/纯文本。
 *
 * 部分发布源的 releaseNotes 是 HTML（而非 markdown），而项目 markdown
 * 渲染器配置了 html: false（HTML 会被转义成代码文本显示）。这里先用
 * DOMParser 解析：内联标签转 markdown 符号、块级元素补换行、剥离标签，
 * 再交给 MarkdownBlock 正常渲染。
 */
const htmlToMarkdown = (html: string): string => {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  if (!body) {
    return html;
  }

  // 内联样式 → markdown 符号
  for (const anchor of Array.from(body.querySelectorAll("a"))) {
    const href = anchor.getAttribute("href");
    const text = anchor.textContent?.trim() ?? "";
    if (href && text && !/\s|[)]/.test(href)) {
      anchor.replaceWith(`[${text}](${href})`);
    }
  }
  for (const code of Array.from(body.querySelectorAll("code"))) {
    const text = code.textContent ?? "";
    if (text) {
      code.replaceWith(`\`${text}\``);
    }
  }
  for (const strong of Array.from(
    body.querySelectorAll("strong, b")
  )) {
    const text = strong.textContent ?? "";
    if (text) {
      strong.replaceWith(`**${text}**`);
    }
  }
  for (const em of Array.from(body.querySelectorAll("em, i"))) {
    const text = em.textContent ?? "";
    if (text) {
      em.replaceWith(`*${text}*`);
    }
  }

  // 块级元素与 <br> 后补换行，保留段落结构
  const blockSelector =
    "br, p, div, li, h1, h2, h3, h4, h5, h6, blockquote, pre, tr, ul, ol, table, hr";
  for (const node of Array.from(body.querySelectorAll(blockSelector))) {
    node.insertAdjacentText("afterend", "\n");
  }

  return (body.textContent ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

/** 检测字符串是否包含 HTML 标签（决定是否需要 HTML → markdown 转换）。 */
const containsHtmlTags = (text: string): boolean =>
  /<\/?[a-z][^>]*>/i.test(text);

/**
 * 更新弹窗：展示新版本发行说明与下载进度。
 *
 * 下载由主进程执行，弹窗关闭不影响下载（侧边栏/设置面板的进度
 * 入口依然保留）。重新打开时通过 getUpdateStatus() 恢复最新状态，
 * 并与 onUpdateStatusChanged 推送保持同步。
 */
export function UpdateDialog({
  open,
  onClose,
}: UpdateDialogProps): React.JSX.Element {
  const { locale, t } = useI18n();
  const [updateStatus, setUpdateStatus] =
    useState<UpdateStatus>(INITIAL_UPDATE_STATUS);
  const [currentVersion, setCurrentVersion] = useState("");
  // 发行说明语言：默认按应用语言选择（中文环境优先中文翻译）
  const [notesLang, setNotesLang] = useState<"zh" | "en">(() =>
    locale.startsWith("zh") ? "zh" : "en"
  );

  useEffect(() => {
    window.snow
      .getUpdateStatus()
      .then(setUpdateStatus)
      .catch(() => undefined);
    window.snow
      .getAppVersion()
      .then(setCurrentVersion)
      .catch(() => undefined);
    const unsubscribe = window.snow.onUpdateStatusChanged(setUpdateStatus);
    return () => {
      unsubscribe();
    };
  }, []);

  const handleDownload = (): void => {
    void window.snow.downloadUpdate();
  };

  const handleInstall = (): void => {
    void window.snow.installUpdate();
  };

  const {
    available,
    version,
    downloading,
    progress,
    downloaded,
    error,
    releaseNotes,
    releaseNotesZh,
  } = updateStatus;

  const showDownloadAction = available && !downloading && !downloaded;
  const showProgress = available && downloading;
  const newVersionLabel = version ? `v${version}` : "";
  // 有中文翻译时允许切换语言；否则固定显示英文
  const hasZhNotes = Boolean(releaseNotesZh);
  const activeNotesLang = hasZhNotes ? notesLang : "en";
  const activeNotes =
    activeNotesLang === "zh" && releaseNotesZh ? releaseNotesZh : releaseNotes;

  return (
    <Modal
      open={open}
      title={t("settings.updateDialogTitle", {
        defaultValue: "Update available",
      })}
      description={
        currentVersion || newVersionLabel
          ? t("settings.updateDialogFromTo", {
              values: {
                current: currentVersion ? `v${currentVersion}` : "",
                next: newVersionLabel,
              },
              defaultValue: "{{current}} → {{next}}",
            })
          : undefined
      }
      closeLabel={t("settings.updateDialogClose", {
        defaultValue: "Close update dialog",
      })}
      onClose={onClose}
      size="medium"
      className="update-dialog"
      footer={
        <>
          {showDownloadAction && (
            <button
              type="button"
              className="update-dialog-primary-btn"
              onClick={handleDownload}
            >
              {error ? (
                <RefreshCw size={14} strokeWidth={1.8} />
              ) : (
                <Download size={14} strokeWidth={1.8} />
              )}
              <span>
                {t(
                  error
                    ? "settings.updateDialogRetry"
                    : "settings.updateDialogDownload",
                  {
                    defaultValue: error
                      ? "Retry download"
                      : "Download now",
                  }
                )}
              </span>
            </button>
          )}
          {downloaded && (
            <button
              type="button"
              className="update-dialog-primary-btn"
              onClick={handleInstall}
            >
              <RefreshCw size={14} strokeWidth={1.8} />
              <span>
                {t("settings.updateDialogRestart", {
                  defaultValue: "Restart to update",
                })}
              </span>
            </button>
          )}
          {showProgress && (
            <span className="update-dialog-background-hint">
              <LoaderCircle
                size={13}
                strokeWidth={1.8}
                className="tool-call-icon-spinning"
                aria-hidden="true"
              />
              <span>
                {t("settings.updateDialogDownloadingHint", {
                  defaultValue:
                    "Downloading continues in the background. You can close this window.",
                })}
              </span>
            </span>
          )}
        </>
      }
    >
      {showProgress && (
        <div className="update-dialog-progress" role="status">
          <div className="update-dialog-progress-info">
            <LoaderCircle
              size={13}
              strokeWidth={1.8}
              className="tool-call-icon-spinning"
              aria-hidden="true"
            />
            <span>
              {t("settings.updateDialogDownloading", {
                values: { percent: progress },
                defaultValue: `Downloading ${progress}%`,
              })}
            </span>
          </div>
          <div className="update-dialog-progress-bar">
            <div
              className="update-dialog-progress-fill"
              style={{
                width: `${Math.min(100, Math.max(0, progress))}%`,
              }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="update-dialog-error" role="alert">
          {error}
        </div>
      )}

      <div className="update-dialog-notes-title">
        <span>
          {t("settings.updateDialogNotesTitle", {
            defaultValue: "Release notes",
          })}
        </span>
        {hasZhNotes && (
          <div
            className="update-dialog-lang-switch"
            role="group"
            aria-label="Release notes language"
          >
            <button
              type="button"
              className={activeNotesLang === "zh" ? "active" : ""}
              onClick={() => setNotesLang("zh")}
            >
              中文
            </button>
            <button
              type="button"
              className={activeNotesLang === "en" ? "active" : ""}
              onClick={() => setNotesLang("en")}
            >
              English
            </button>
          </div>
        )}
      </div>
      {activeNotes ? (
        <div className="update-dialog-notes">
          <MarkdownBlock
            className="update-dialog-notes-markdown"
            content={
              containsHtmlTags(activeNotes)
                ? htmlToMarkdown(activeNotes)
                : activeNotes
            }
          />
        </div>
      ) : (
        <div className="update-dialog-no-notes">
          {t("settings.updateDialogNoNotes", {
            defaultValue: "No release notes for this version.",
          })}
        </div>
      )}
    </Modal>
  );
}
