import { useCallback, useRef, useState } from "react";
import type {
  Dispatch,
  RefObject,
  SetStateAction,
} from "react";
import { useI18n } from "../../../i18n";
import {
  type ChipDetailsState,
  type ImagePreviewState,
  type TextSnippetEditorState,
  type TextSnippetPreviewState,
  type WebChipMenuState,
} from "./InputOverlayLayer";
import {
  base64ToUtf8,
  buildTextSnippetSummary,
  createTextSnippetChipHtml,
  type ChangeTag,
  type CommitTag,
  type TextSnippetTag,
} from "./fileTagUtils";
import { rightPanelEvents } from "../../rightPanel/rightPanelEvents";

type UseChipInteractionsOptions = {
  textareaRef: RefObject<HTMLDivElement | null>;
  syncContent: () => void;
};

export type ChipInteractionsResult = {
  imagePreview: ImagePreviewState | null;
  setImagePreview: Dispatch<SetStateAction<ImagePreviewState | null>>;
  imageLightbox: string | null;
  setImageLightbox: Dispatch<SetStateAction<string | null>>;
  textSnippetPreview: TextSnippetPreviewState | null;
  textSnippetEditor: TextSnippetEditorState | null;
  setTextSnippetEditor: Dispatch<SetStateAction<TextSnippetEditorState | null>>;
  webChipMenu: WebChipMenuState | null;
  setWebChipMenu: Dispatch<SetStateAction<WebChipMenuState | null>>;
  chipDetails: ChipDetailsState | null;
  showImagePreview: (event: React.MouseEvent<HTMLDivElement>) => void;
  scheduleHideImagePreview: () => void;
  cancelHideImagePreview: () => void;
  showTextSnippetPreview: (event: React.MouseEvent<HTMLDivElement>) => void;
  scheduleHideTextSnippetPreview: () => void;
  cancelHideTextSnippetPreview: () => void;
  showChipDetails: (event: React.MouseEvent<HTMLDivElement>) => void;
  scheduleHideChipDetails: () => void;
  cancelHideChipDetails: () => void;
  handleChipRemove: (event: React.MouseEvent<HTMLDivElement>) => void;
  handleTextSnippetClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  handleWebChipClick: (event: React.MouseEvent<HTMLDivElement>) => void;
  handleWebChipContextMenu: (event: React.MouseEvent<HTMLDivElement>) => void;
  handleTextSnippetEditorDelete: () => void;
  handleTextSnippetEditorSave: () => void;
};

export const useChipInteractions = ({
  textareaRef,
  syncContent,
}: UseChipInteractionsOptions): ChipInteractionsResult => {
  const { t } = useI18n();
  const [imagePreview, setImagePreview] = useState<ImagePreviewState | null>(
    null
  );
  const imagePreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const [imageLightbox, setImageLightbox] = useState<string | null>(null);
  const [textSnippetPreview, setTextSnippetPreview] =
    useState<TextSnippetPreviewState | null>(null);
  const textSnippetPreviewTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const [textSnippetEditor, setTextSnippetEditor] =
    useState<TextSnippetEditorState | null>(null);
  const [webChipMenu, setWebChipMenu] = useState<WebChipMenuState | null>(
    null
  );
  const [chipDetails, setChipDetails] = useState<ChipDetailsState | null>(null);
  const chipDetailsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );

  const showImagePreview = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      const chip = target.closest(
        "[data-image-tag='true']"
      ) as HTMLElement | null;
      if (!chip) {
        if (imagePreviewTimerRef.current) {
          clearTimeout(imagePreviewTimerRef.current);
          imagePreviewTimerRef.current = null;
        }
        setImagePreview(null);
        return;
      }
      const dataUrl = chip.dataset.imageDataUrl;
      if (!dataUrl) {
        if (imagePreviewTimerRef.current) {
          clearTimeout(imagePreviewTimerRef.current);
          imagePreviewTimerRef.current = null;
        }
        setImagePreview(null);
        return;
      }
      if (imagePreviewTimerRef.current) {
        clearTimeout(imagePreviewTimerRef.current);
        imagePreviewTimerRef.current = null;
      }
      const rect = chip.getBoundingClientRect();
      const halfW = 328 / 2;
      const clampedX = Math.max(
        halfW + 4,
        Math.min(rect.left + rect.width / 2, window.innerWidth - halfW - 4)
      );
      setImagePreview({ url: dataUrl, x: clampedX, y: rect.top });
    },
    []
  );

  const handleChipRemove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      const removeBtn = target.closest("[data-chip-remove='true']");
      if (!removeBtn) {
        return;
      }
      const chip = removeBtn.closest(".file-chip");
      if (chip && textareaRef.current?.contains(chip)) {
        chip.remove();
        syncContent();
      }
    },
    [syncContent, textareaRef]
  );

  const scheduleHideImagePreview = useCallback(() => {
    imagePreviewTimerRef.current = setTimeout(() => {
      setImagePreview(null);
    }, 200);
  }, []);

  const cancelHideImagePreview = useCallback(() => {
    if (imagePreviewTimerRef.current) {
      clearTimeout(imagePreviewTimerRef.current);
      imagePreviewTimerRef.current = null;
    }
  }, []);

  const showTextSnippetPreview = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      const chip = target.closest(
        "[data-text-snippet-tag='true']"
      ) as HTMLElement | null;
      if (!chip) {
        if (textSnippetPreviewTimerRef.current) {
          clearTimeout(textSnippetPreviewTimerRef.current);
          textSnippetPreviewTimerRef.current = null;
        }
        setTextSnippetPreview(null);
        return;
      }
      const rawData = chip.dataset.textSnippetData;
      if (!rawData) {
        if (textSnippetPreviewTimerRef.current) {
          clearTimeout(textSnippetPreviewTimerRef.current);
          textSnippetPreviewTimerRef.current = null;
        }
        setTextSnippetPreview(null);
        return;
      }
      let parsed: { content?: string; summary?: string };
      try {
        parsed = JSON.parse(rawData) as { content?: string; summary?: string };
      } catch {
        if (textSnippetPreviewTimerRef.current) {
          clearTimeout(textSnippetPreviewTimerRef.current);
          textSnippetPreviewTimerRef.current = null;
        }
        setTextSnippetPreview(null);
        return;
      }
      if (textSnippetPreviewTimerRef.current) {
        clearTimeout(textSnippetPreviewTimerRef.current);
        textSnippetPreviewTimerRef.current = null;
      }
      const rect = chip.getBoundingClientRect();
      const halfW = 440 / 2;
      const clampedX = Math.max(
        halfW + 4,
        Math.min(rect.left + rect.width / 2, window.innerWidth - halfW - 4)
      );
      setTextSnippetPreview({
        content: parsed.content ?? "",
        summary: parsed.summary ?? "text",
        x: clampedX,
        y: rect.top,
      });
    },
    []
  );

  const scheduleHideTextSnippetPreview = useCallback(() => {
    textSnippetPreviewTimerRef.current = setTimeout(() => {
      setTextSnippetPreview(null);
    }, 200);
  }, []);

  const cancelHideTextSnippetPreview = useCallback(() => {
    if (textSnippetPreviewTimerRef.current) {
      clearTimeout(textSnippetPreviewTimerRef.current);
      textSnippetPreviewTimerRef.current = null;
    }
  }, []);

  const handleTextSnippetClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (target.closest("[data-chip-remove='true']")) {
        return;
      }
      const chip = target.closest(
        "[data-text-snippet-tag='true']"
      ) as HTMLElement | null;
      if (!chip || !textareaRef.current?.contains(chip)) {
        return;
      }
      const rawData = chip.dataset.textSnippetData;
      if (!rawData) {
        return;
      }
      try {
        const parsed = JSON.parse(rawData) as {
          content?: string;
          summary?: string;
        };
        setTextSnippetEditor({
          chip,
          content: parsed.content ?? "",
          summary:
            parsed.summary ?? buildTextSnippetSummary(parsed.content ?? ""),
        });
      } catch {
        // Ignore malformed data
      }
    },
    [textareaRef]
  );

  const handleWebChipClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (target.closest("[data-chip-remove='true']")) {
        return;
      }
      const chip = target.closest(
        "[data-web-tag='true']"
      ) as HTMLElement | null;
      if (!chip || !textareaRef.current?.contains(chip)) {
        return;
      }
      const rawData = chip.dataset.webData;
      if (!rawData) {
        return;
      }
      try {
        const parsed = JSON.parse(rawData) as { url?: string };
        if (parsed.url) {
          rightPanelEvents.emit("open-browser-tab", { url: parsed.url });
        }
      } catch {
        // Ignore malformed data
      }
    },
    [textareaRef]
  );

  const handleWebChipContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (target.closest("[data-chip-remove='true']")) {
        return;
      }
      const chip = target.closest(
        "[data-web-tag='true']"
      ) as HTMLElement | null;
      if (!chip || !textareaRef.current?.contains(chip)) {
        return;
      }
      const rawData = chip.dataset.webData;
      if (!rawData) {
        return;
      }
      try {
        const parsed = JSON.parse(rawData) as { url?: string };
        if (!parsed.url) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        setWebChipMenu({
          x: event.clientX,
          y: event.clientY,
          chip,
          url: parsed.url,
        });
      } catch {
        // Ignore malformed data
      }
    },
    [textareaRef]
  );

  const handleTextSnippetEditorSave = useCallback(() => {
    if (!textSnippetEditor) {
      return;
    }
    const { chip, content, summary } = textSnippetEditor;
    const trimmedSummary = summary.trim() || buildTextSnippetSummary(content);
    const tag: TextSnippetTag = {
      content,
      summary: trimmedSummary,
      charCount: content.length,
    };
    const fragment = document
      .createRange()
      .createContextualFragment(createTextSnippetChipHtml(tag));
    const newChip = fragment.firstChild as HTMLElement | null;
    if (newChip) {
      chip.replaceWith(newChip);
    }
    setTextSnippetEditor(null);
    syncContent();
  }, [syncContent, textSnippetEditor]);

  const handleTextSnippetEditorDelete = useCallback(() => {
    if (!textSnippetEditor) {
      return;
    }
    textSnippetEditor.chip.remove();
    setTextSnippetEditor(null);
    syncContent();
  }, [syncContent, textSnippetEditor]);

  const showChipDetails = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      const chip = target.closest(
        "[data-file-tag='true'],[data-commit-tag='true'],[data-change-tag='true'],[data-review-tag='true'],[data-element-tag='true'],[data-web-tag='true']"
      ) as HTMLElement | null;
      const clear = (): void => {
        if (chipDetailsTimerRef.current) {
          clearTimeout(chipDetailsTimerRef.current);
          chipDetailsTimerRef.current = null;
        }
        setChipDetails(null);
      };
      if (!chip) {
        clear();
        return;
      }
      const rows: { label: string; value: string }[] = [];
      let content: string | undefined;
      try {
        if (chip.dataset.fileTag === "true") {
          const path = chip.dataset.filePath ?? "";
          const isDir = chip.dataset.fileIsDir === "true";
          const lines = chip.dataset.fileLines;
          rows.push({
            label: t(isDir ? "chatInput.chipDetailsFolder" : "chatInput.chipDetailsFile"),
            value: path,
          });
          if (lines) {
            rows.push({ label: t("chatInput.chipDetailsLines"), value: lines });
          }
        } else if (chip.dataset.commitTag === "true") {
          const data = JSON.parse(
            chip.dataset.commitData ?? "{}"
          ) as Partial<CommitTag>;
          rows.push({ label: t("chatInput.chipDetailsCommit"), value: data.shortHash ?? "" });
          rows.push({ label: t("chatInput.chipDetailsAuthor"), value: data.author ?? "" });
          if (data.date) {
            rows.push({ label: t("chatInput.chipDetailsDate"), value: data.date });
          }
          if (data.repoPath) {
            rows.push({ label: t("chatInput.chipDetailsRepo"), value: data.repoPath });
          }
          if (data.message) {
            content = data.message;
          }
        } else if (chip.dataset.changeTag === "true") {
          const data = JSON.parse(
            chip.dataset.changeData ?? "{}"
          ) as Partial<ChangeTag>;
          const sectionLabel =
            data.section === "staged"
              ? t("chatInput.chipDetailsStaged")
              : t("chatInput.chipDetailsUnstaged");
          rows.push({
            label: t("chatInput.chipDetailsSection"),
            value: data.status ? `${sectionLabel} · ${data.status}` : sectionLabel,
          });
          rows.push({ label: t("chatInput.chipDetailsPath"), value: data.path ?? "" });
          if (data.repoPath) {
            rows.push({ label: t("chatInput.chipDetailsRepo"), value: data.repoPath });
          }
        } else if (chip.dataset.reviewTag === "true") {
          const data = JSON.parse(
            chip.dataset.reviewData ?? "{}"
          ) as {
            prompt?: string;
            summary?: string;
            charCount?: number;
            branch?: string;
            repoPath?: string;
          };
          rows.push({ label: t("chatInput.chipDetailsSummary"), value: data.summary ?? "" });
          if (typeof data.charCount === "number") {
            rows.push({ label: t("chatInput.chipDetailsChars"), value: String(data.charCount) });
          }
          if (data.branch) {
            rows.push({ label: t("chatInput.chipDetailsBranch"), value: data.branch });
          }
          if (data.repoPath) {
            rows.push({ label: t("chatInput.chipDetailsRepo"), value: data.repoPath });
          }
          if (data.prompt) {
            content = base64ToUtf8(data.prompt);
          }
        } else if (chip.dataset.elementTag === "true") {
          const data = JSON.parse(
            chip.dataset.elementData ?? "{}"
          ) as {
            url?: string;
            tag?: string;
            label?: string;
            text?: string;
            note?: string;
          };
          rows.push({ label: t("chatInput.chipDetailsTag"), value: data.label ?? "" });
          if (data.tag) {
            rows.push({ label: t("chatInput.chipDetailsType"), value: data.tag });
          }
          if (data.url) {
            rows.push({ label: t("chatInput.chipDetailsUrl"), value: data.url });
          }
          if (data.note) {
            rows.push({ label: t("chatInput.chipDetailsNote"), value: base64ToUtf8(data.note) });
          }
          if (data.text) {
            content = base64ToUtf8(data.text);
          }
        } else if (chip.dataset.webTag === "true") {
          const data = JSON.parse(
            chip.dataset.webData ?? "{}"
          ) as { url?: string; title?: string };
          rows.push({ label: t("chatInput.chipDetailsUrl"), value: data.url ?? "" });
          if (data.title) {
            rows.push({ label: t("chatInput.chipDetailsTitle"), value: data.title });
          }
        }
      } catch {
        clear();
        return;
      }
      if (rows.length === 0) {
        clear();
        return;
      }
      if (chipDetailsTimerRef.current) {
        clearTimeout(chipDetailsTimerRef.current);
        chipDetailsTimerRef.current = null;
      }
      const rect = chip.getBoundingClientRect();
      const halfW = 420 / 2;
      const clampedX = Math.max(
        halfW + 4,
        Math.min(rect.left + rect.width / 2, window.innerWidth - halfW - 4)
      );
      setChipDetails({ rows, content, x: clampedX, y: rect.top });
    },
    [t]
  );

  const scheduleHideChipDetails = useCallback(() => {
    chipDetailsTimerRef.current = setTimeout(() => {
      setChipDetails(null);
    }, 200);
  }, []);

  const cancelHideChipDetails = useCallback(() => {
    if (chipDetailsTimerRef.current) {
      clearTimeout(chipDetailsTimerRef.current);
      chipDetailsTimerRef.current = null;
    }
  }, []);

  return {
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
    showImagePreview,
    scheduleHideImagePreview,
    cancelHideImagePreview,
    showTextSnippetPreview,
    scheduleHideTextSnippetPreview,
    cancelHideTextSnippetPreview,
    showChipDetails,
    scheduleHideChipDetails,
    cancelHideChipDetails,
    handleChipRemove,
    handleTextSnippetClick,
    handleWebChipClick,
    handleWebChipContextMenu,
    handleTextSnippetEditorDelete,
    handleTextSnippetEditorSave,
  };
};
