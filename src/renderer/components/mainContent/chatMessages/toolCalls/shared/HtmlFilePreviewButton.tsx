import { Eye, EyeOff } from "lucide-react";
import { useI18n } from "../../../../../i18n";
import { useFileArtifactRevealed } from "../../components/ChatFileArtifactRevealContext";

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
  const open = useFileArtifactRevealed(filePath);
  if (!enabled || !HTML_FILE_RE.test(filePath)) {
    return null;
  }
  const label = open
    ? t("chat.fileArtifact.close")
    : t("markdown.html.preview");
  return (
    <button
      type="button"
      className="tcn-html-preview-btn"
      {...{ [HTML_FILE_PREVIEW_ATTR]: filePath }}
      data-preview-open={open ? "true" : undefined}
      aria-pressed={open}
      title={
        open ? t("chat.fileArtifact.close") : t("chat.fileArtifact.toggle")
      }
      aria-label={
        open ? t("chat.fileArtifact.close") : t("chat.fileArtifact.toggle")
      }
      // 兜底：不在 AiResponse 内时也不触发 summary 开合
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {open ? (
        <EyeOff size={12} aria-hidden="true" />
      ) : (
        <Eye size={12} aria-hidden="true" />
      )}
      <span>{label}</span>
    </button>
  );
};
