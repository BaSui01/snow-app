import {
  Copy,
  ExternalLink,
  Loader2,
  Trash2,
} from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../../i18n";
import { ContextMenu } from "../../common/ContextMenu";
import { Modal } from "../../common/Modal";

export type ImagePreviewState = {
  url: string;
  x: number;
  y: number;
};

export type TextSnippetPreviewState = {
  content: string;
  summary: string;
  x: number;
  y: number;
};

export type TextSnippetEditorState = {
  chip: HTMLElement;
  content: string;
  summary: string;
};

export type WebChipMenuState = {
  x: number;
  y: number;
  chip: HTMLElement;
  url: string;
};

export type ChipDetailsState = {
  rows: { label: string; value: string }[];
  content?: string;
  x: number;
  y: number;
};

export type ConversationPreviewState = {
  emoji?: string;
  title: string;
  /** null = 加载中；字符串 = 发送时实际注入的渲染内容 */
  content: string | null;
  /** 加载失败标记 */
  failed?: boolean;
  x: number;
  y: number;
};

type InputOverlayLayerProps = {
  imagePreview: ImagePreviewState | null;
  setImagePreview: Dispatch<SetStateAction<ImagePreviewState | null>>;
  imageLightbox: string | null;
  setImageLightbox: Dispatch<SetStateAction<string | null>>;
  textSnippetPreview: TextSnippetPreviewState | null;
  textSnippetEditor: TextSnippetEditorState | null;
  setTextSnippetEditor: Dispatch<
    SetStateAction<TextSnippetEditorState | null>
  >;
  webChipMenu: WebChipMenuState | null;
  setWebChipMenu: Dispatch<SetStateAction<WebChipMenuState | null>>;
  chipDetails: ChipDetailsState | null;
  conversationPreview: ConversationPreviewState | null;
  cancelHideImagePreview: () => void;
  scheduleHideImagePreview: () => void;
  cancelHideTextSnippetPreview: () => void;
  scheduleHideTextSnippetPreview: () => void;
  cancelHideChipDetails: () => void;
  scheduleHideChipDetails: () => void;
  cancelHideConversationPreview: () => void;
  scheduleHideConversationPreview: () => void;
  handleTextSnippetEditorDelete: () => void;
  handleTextSnippetEditorSave: () => void;
  syncContent: () => void;
  onOpenWebChip: (url: string) => void;
};

export const InputOverlayLayer = ({
  imagePreview,
  setImagePreview,
  imageLightbox,
  setImageLightbox,
  textSnippetPreview,
  textSnippetEditor,
  setTextSnippetEditor,
  webChipMenu,
  setWebChipMenu,
  chipDetails,
  conversationPreview,
  cancelHideImagePreview,
  scheduleHideImagePreview,
  cancelHideTextSnippetPreview,
  scheduleHideTextSnippetPreview,
  cancelHideChipDetails,
  scheduleHideChipDetails,
  cancelHideConversationPreview,
  scheduleHideConversationPreview,
  handleTextSnippetEditorDelete,
  handleTextSnippetEditorSave,
  syncContent,
  onOpenWebChip,
}: InputOverlayLayerProps): React.JSX.Element => {
  const { t } = useI18n();

  return (
    <>
      {imagePreview &&
        createPortal(
          <div
            className="image-chip-preview"
            style={{
              left: imagePreview.x,
              top: imagePreview.y,
              transform: "translate(-50%, calc(-100% - 8px))",
            }}
            onMouseEnter={cancelHideImagePreview}
            onMouseLeave={scheduleHideImagePreview}
            onClick={() => {
              setImageLightbox(imagePreview.url);
              setImagePreview(null);
            }}
          >
            <img src={imagePreview.url} alt="preview" />
          </div>,
          document.body
        )}
      {imageLightbox &&
        createPortal(
          <div
            className="image-lightbox-overlay"
            onClick={() => setImageLightbox(null)}
          >
            <img src={imageLightbox} alt="fullscreen" />
          </div>,
          document.body
        )}
      {textSnippetPreview &&
        createPortal(
          <div
            className="text-snippet-preview"
            style={{
              left: textSnippetPreview.x,
              top: textSnippetPreview.y,
              transform: "translate(-50%, calc(-100% - 8px))",
            }}
            onMouseEnter={cancelHideTextSnippetPreview}
            onMouseLeave={scheduleHideTextSnippetPreview}
          >
            <pre className="text-snippet-preview-content">
              {textSnippetPreview.content}
            </pre>
          </div>,
          document.body
        )}
      {chipDetails &&
        createPortal(
          <div
            className="chip-details-preview"
            style={{
              left: chipDetails.x,
              top: chipDetails.y,
              transform: "translate(-50%, calc(-100% - 8px))",
            }}
            onMouseEnter={cancelHideChipDetails}
            onMouseLeave={scheduleHideChipDetails}
          >
            <div className="chip-details-preview-rows">
              {chipDetails.rows.map((row) => (
                <div className="chip-details-preview-row" key={row.label}>
                  <span className="chip-details-preview-label">
                    {row.label}
                  </span>
                  <span className="chip-details-preview-value">
                    {row.value}
                  </span>
                </div>
              ))}
            </div>
            {chipDetails.content && (
              <pre className="chip-details-preview-content">
                {chipDetails.content}
              </pre>
            )}
          </div>,
          document.body
        )}
      {conversationPreview &&
        createPortal(
          <div
            className="conversation-chip-preview"
            style={{
              left: conversationPreview.x,
              top: conversationPreview.y,
              transform: "translate(-50%, calc(-100% - 8px))",
            }}
            onMouseEnter={cancelHideConversationPreview}
            onMouseLeave={scheduleHideConversationPreview}
          >
            <div className="conversation-chip-preview-header">
              <span className="conversation-chip-preview-title">
                {conversationPreview.emoji ? (
                  <span className="conversation-chip-preview-emoji">
                    {conversationPreview.emoji}
                  </span>
                ) : null}
                <span className="conversation-chip-preview-name">
                  {conversationPreview.title ||
                    t("chatInput.conversationPreviewUntitled", {
                      defaultValue: "未命名会话",
                    })}
                </span>
              </span>
              <span className="conversation-chip-preview-badge">
                {t("chatInput.conversationPreviewBadge", {
                  defaultValue: "引用上下文",
                })}
              </span>
            </div>
            {conversationPreview.content === null ? (
              <div className="conversation-chip-preview-status">
                <Loader2
                  size={13}
                  className="conversation-chip-preview-spinner"
                  aria-hidden="true"
                />
                {t("chatInput.conversationPreviewLoading", {
                  defaultValue: "正在加载会话内容…",
                })}
              </div>
            ) : conversationPreview.failed ? (
              <div className="conversation-chip-preview-status error">
                {t("chatInput.conversationPreviewFailed", {
                  defaultValue: "会话内容加载失败",
                })}
              </div>
            ) : conversationPreview.content.trim() ? (
              <pre className="conversation-chip-preview-content">
                {conversationPreview.content}
              </pre>
            ) : (
              <div className="conversation-chip-preview-status">
                {t("chatInput.conversationPreviewEmpty", {
                  defaultValue: "该会话暂无可注入的内容",
                })}
              </div>
            )}
            <div className="conversation-chip-preview-footer">
              {t("chatInput.conversationPreviewHint", {
                defaultValue:
                  "发送时实际注入的上下文（已清洗思考与工具细节，并按预算裁剪）",
              })}
            </div>
          </div>,
          document.body
        )}
      {textSnippetEditor &&
        createPortal(
          <Modal
            open={true}
            title={t("chatInput.textSnippetEditorTitle")}
            description={t("chatInput.textSnippetEditorDescription", {
              values: { count: textSnippetEditor.content.length },
            })}
            closeLabel={t("common.cancel")}
            onClose={() => setTextSnippetEditor(null)}
            size="large"
            footer={
              <div className="text-snippet-editor-footer">
                <button
                  type="button"
                  className="text-snippet-editor-btn danger"
                  onClick={handleTextSnippetEditorDelete}
                >
                  {t("common.delete")}
                </button>
                <div className="text-snippet-editor-footer-right">
                  <button
                    type="button"
                    className="text-snippet-editor-btn secondary"
                    onClick={() => setTextSnippetEditor(null)}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    type="button"
                    className="text-snippet-editor-btn primary"
                    onClick={handleTextSnippetEditorSave}
                  >
                    {t("common.confirm")}
                  </button>
                </div>
              </div>
            }
          >
            <div className="text-snippet-editor-body">
              <textarea
                className="text-snippet-editor-textarea"
                value={textSnippetEditor.content}
                onChange={(event) =>
                  setTextSnippetEditor((prev) =>
                    prev ? { ...prev, content: event.target.value } : prev
                  )
                }
                rows={16}
              />
            </div>
          </Modal>,
          document.body
        )}
      {webChipMenu && (
        <ContextMenu
          x={webChipMenu.x}
          y={webChipMenu.y}
          items={[
            {
              id: "web-chip-open",
              label: t("chatInput.webChipOpen", {
                defaultValue: "打开页面",
              }),
              icon: <ExternalLink size={13} strokeWidth={1.8} />,
              onClick: () => {
                onOpenWebChip(webChipMenu.url);
                setWebChipMenu(null);
              },
            },
            {
              id: "web-chip-copy-link",
              label: t("chatInput.webChipCopyLink", {
                defaultValue: "复制链接",
              }),
              icon: <Copy size={13} strokeWidth={1.8} />,
              onClick: () => {
                void window.snow.writeClipboardText(webChipMenu.url).catch(
                  () => {}
                );
                setWebChipMenu(null);
              },
            },
            {
              id: "web-chip-remove",
              label: t("chatInput.webChipRemove", {
                defaultValue: "移除引用",
              }),
              icon: <Trash2 size={13} strokeWidth={1.8} />,
              onClick: () => {
                webChipMenu.chip.remove();
                setWebChipMenu(null);
                syncContent();
              },
            },
          ]}
          onClose={() => setWebChipMenu(null)}
        />
      )}
    </>
  );
};
