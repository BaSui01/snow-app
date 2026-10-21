import { Eye } from "lucide-react";
import { useI18n } from "../../../../../i18n";

/** AiResponse 按该属性捕获点击并切换对应 HTML 文件卡片。 */
export const HTML_FILE_PREVIEW_ATTR = "data-html-file-preview";

const HTML_FILE_RE = /\.html?$/i;

type HtmlFilePreviewButtonProps = {
  filePath: string;
  /** 仅写入成功后显示。 */
  enabled: boolean;
};

export const HtmlFilePreviewButton = ({
  filePath,
  enabled,
}: HtmlFilePreviewButtonProps): React.JSX.Element | null => {
  const { t } = useI18n();
  if (!enabled || !HTML_FILE_RE.test(filePath)) {
    return null;
  }
  return (
    <button
      type="button"
      className="tcn-html-preview-btn"
      {...{ [HTML_FILE_PREVIEW_ATTR]: filePath }}
      title={t("chat.fileArtifact.toggle")}
      aria-label={t("chat.fileArtifact.toggle")}
      // 兜底：不在 AiResponse 内时也不触发 summary 开合
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <Eye size={12} aria-hidden="true" />
      <span>{t("markdown.html.preview")}</span>
    </button>
  );
};
