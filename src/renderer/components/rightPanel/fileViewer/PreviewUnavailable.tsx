import { Check, Copy, ExternalLink, FileX, FolderOpen } from "lucide-react";
import { useState } from "react";

import type { FilePreviewKind, FilePreviewReason } from "../../../../preload";
import { useI18n } from "../../../i18n";
import { formatSize } from "./formatSize";

export type PreviewUnavailableInfo = {
  reason: FilePreviewReason;
  kind: FilePreviewKind | "";
  size: number | null;
  limit?: number;
  signature?: string;
  detail?: string;
};

type PreviewUnavailableProps = PreviewUnavailableInfo & {
  fileName: string;
  filePath: string;
  /** 本地文件才提供「用系统应用打开」与「在文件夹中显示」。 */
  local: boolean;
};

/** OLE 复合文档文件头：Access .mdb、旧版或加密的 Office 文档都使用该容器。 */
const OLE_SIGNATURE = "D0 CF 11 E0 A1 B1 1A E1";

const extensionOf = (fileName: string): string => {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot + 1).toUpperCase() : "";
};

/** 不可预览面板：本地化原因 + 文件信息 + 可操作出口，原始错误折叠展示。 */
export function PreviewUnavailable({
  fileName,
  filePath,
  local,
  reason,
  kind,
  size,
  limit,
  signature,
  detail,
}: PreviewUnavailableProps): React.JSX.Element {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);

  const reasonText =
    reason === "format_mismatch" && kind
      ? t(`rightPanel.filePreview.mismatch.${kind}`)
      : t(`rightPanel.filePreview.reason.${reason}`);
  const extension = extensionOf(fileName);
  const isOle = Boolean(signature?.startsWith(OLE_SIGNATURE));

  const handleOpen = (): void => {
    setOpenError(null);
    void window.snow
      .openPathWithSystemApp(filePath)
      .then((error) => {
        if (error) setOpenError(error);
      })
      .catch((error: unknown) => {
        setOpenError(error instanceof Error ? error.message : String(error));
      });
  };

  const handleReveal = (): void => {
    void window.snow.showItemInFolder(filePath).catch((error: unknown) => {
      setOpenError(error instanceof Error ? error.message : String(error));
    });
  };

  const handleCopyPath = (): void => {
    void window.snow.writeClipboardText(filePath).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="file-preview-unavailable">
      <div className="file-preview-unavailable-head">
        <FileX size={22} />
        <span className="file-preview-unavailable-reason">{reasonText}</span>
      </div>
      <dl className="file-preview-meta">
        <dt>{t("rightPanel.filePreview.fieldName")}</dt>
        <dd>{fileName}</dd>
        {size != null ? (
          <>
            <dt>{t("rightPanel.filePreview.fieldSize")}</dt>
            <dd>{formatSize(size)}</dd>
          </>
        ) : null}
        {extension ? (
          <>
            <dt>{t("rightPanel.filePreview.fieldType")}</dt>
            <dd>{extension}</dd>
          </>
        ) : null}
        {reason === "too_large" && limit ? (
          <>
            <dt>{t("rightPanel.filePreview.fieldLimit")}</dt>
            <dd>{formatSize(limit)}</dd>
          </>
        ) : null}
        {signature ? (
          <>
            <dt>{t("rightPanel.filePreview.fieldSignature")}</dt>
            <dd className="file-preview-mono">{signature}</dd>
          </>
        ) : null}
        {isOle ? (
          <>
            <dt>{t("rightPanel.filePreview.fieldDetected")}</dt>
            <dd>{t("rightPanel.filePreview.oleContainer")}</dd>
          </>
        ) : null}
        <dt>{t("rightPanel.filePreview.fieldPath")}</dt>
        <dd className="file-preview-mono file-preview-path">{filePath}</dd>
      </dl>
      {detail ? (
        <details className="file-preview-detail">
          <summary>{t("rightPanel.filePreview.rawError")}</summary>
          <pre>{detail}</pre>
        </details>
      ) : null}
      <div className="file-preview-actions">
        {local ? (
          <>
            <button
              type="button"
              className="file-preview-action"
              onClick={handleOpen}
            >
              <ExternalLink size={13} />
              <span>{t("rightPanel.filePreview.openWithSystemApp")}</span>
            </button>
            <button
              type="button"
              className="file-preview-action"
              onClick={handleReveal}
            >
              <FolderOpen size={13} />
              <span>{t("rightPanel.filePreview.showInFolder")}</span>
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="file-preview-action"
          onClick={handleCopyPath}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span>{t("rightPanel.copyPath")}</span>
        </button>
      </div>
      {openError ? (
        <div className="file-preview-action-error">
          {t("sidebar.openWithSystemAppError")}: {openError}
        </div>
      ) : null}
    </div>
  );
}
