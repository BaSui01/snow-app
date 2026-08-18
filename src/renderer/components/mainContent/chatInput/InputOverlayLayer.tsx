import {
  Copy,
  ExternalLink,
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
  cancelHideImagePreview: () => void;
  scheduleHideImagePreview: () => void;
  cancelHideTextSnippetPreview: () => void;
  scheduleHideTextSnippetPreview: () => void;
  cancelHideChipDetails: () => void;
  scheduleHideChipDetails: () => void;
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
  cancelHideImagePreview,
  scheduleHideImagePreview,
  cancelHideTextSnippetPreview,
  scheduleHideTextSnippetPreview,
  cancelHideChipDetails,
  scheduleHideChipDetails,
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
