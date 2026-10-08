import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  LocateFixed,
  Pencil,
  Send,
  Trash2,
  X,
} from "lucide-react";
import type {
  FileReviewAnnotationRecord,
  FileReviewTextAnchor,
} from "../../../preload";
import { useI18n } from "../../i18n";
import { writeBackToChatInput } from "../mainContent/chatInput/chatInputDraftBridge";
import {
  encodeAnnotationTag,
  type AnnotationTag,
} from "../mainContent/chatInput/fileTagUtils";
import {
  GitConfirmBubble,
  type GitConfirmAnchor,
} from "./git/GitConfirmBubble";
import { useFileReviewAnnotations } from "./useFileReviewAnnotations";
import {
  hashFileReviewText,
  parseFileReviewAnchor,
  resolveFileReviewAnchor,
  type FileReviewDraftAnchor,
  type FileReviewLocation,
} from "./fileViewer/fileReviewAnchors";
import type { LineIndex } from "./fileViewer/codeText";
import "./fileViewer/fileReview.css";

type Translate = ReturnType<typeof useI18n>["t"];
type ResolvedReview = {
  record: FileReviewAnnotationRecord;
  anchor: FileReviewTextAnchor | null;
  location: FileReviewLocation | null;
};

export type FileReviewHighlight = {
  location: FileReviewLocation;
  colorIndex: number;
};

export const FILE_REVIEW_HIGHLIGHT_COLOR_COUNT = 6;

const messageFor = (
  filePath: string,
  item: ResolvedReview,
  t: Translate,
): string => {
  const anchor = item.anchor;
  const location = item.location;
  const lines =
    location && (location.status === "exact" || location.status === "relocated")
      ? location
      : anchor;
  const where = lines
    ? t("fileReview.lines", {
        values: { from: lines.startLine, to: lines.endLine },
      })
    : t("fileReview.invalid");
  const status = location
    ? t(`fileReview.${location.status}`)
    : t("fileReview.invalid");
  const representation =
    anchor?.representation === "extracted-text"
      ? t("fileReview.extracted")
      : t("fileReview.source");
  const quote =
    anchor?.quote
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n") ?? "";
  return `${where} · ${representation} · ${status}\n${quote}\n${item.record.content}`;
};

/**
 * 单条标注编码为专用 annotation 标签：行号取「已定位/已重定位」的位置，
 * 未定位时退回锚点；标注正文与引用原文随标签一起发送给 AI。
 */
const annotationTagFor = (filePath: string, item: ResolvedReview): string => {
  const lines =
    item.location &&
    (item.location.status === "exact" || item.location.status === "relocated")
      ? item.location
      : item.anchor;
  const tag: AnnotationTag = {
    filePath,
    startLine: lines?.startLine ?? 0,
    endLine: lines?.endLine ?? 0,
    quote: item.anchor?.quote ?? "",
    content: item.record.content,
    representation: item.anchor?.representation ?? "source",
  };
  return encodeAnnotationTag(tag);
};

function FileReviewCard({
  item,
  pending,
  filePath,
  highlightColorIndex,
  onToggleLocate,
  onUpdate,
  onDelete,
}: {
  item: ResolvedReview;
  pending: boolean;
  filePath: string;
  highlightColorIndex: number | null;
  onToggleLocate: (id: string, location: FileReviewLocation) => void;
  onUpdate: (id: string, content: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.record.content);
  const [deleteAnchor, setDeleteAnchor] = useState<GitConfirmAnchor | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const location = item.location;
  const canLocate =
    location?.status === "exact" || location?.status === "relocated";
  const lines = canLocate ? location : item.anchor;
  const locateLabel = t(
    highlightColorIndex != null ? "fileReview.unlocate" : "fileReview.locate",
  );
  const byteLength = new TextEncoder().encode(draft.trim()).length;
  const text = `${t("fileReview.messageHeader", { values: { path: filePath } })}\n\n${messageFor(filePath, item, t)}`;
  useEffect(() => {
    setDraft(item.record.content);
  }, [item.record.content]);

  const save = async (): Promise<void> => {
    if (!draft.trim() || byteLength > 8192 || pending) return;
    if (await onUpdate(item.record.annotationId, draft)) setEditing(false);
  };
  return (
    <article className="diff-comment-card file-review-card">
      <div className="diff-comment-card-head">
        <span className="diff-comment-card-meta">
          {lines
            ? t("fileReview.lines", {
                values: { from: lines.startLine, to: lines.endLine },
              })
            : t("fileReview.invalid")}
        </span>
        <span
          className={`file-review-status ${canLocate ? "matched" : "warning"}`}
        >
          {!canLocate ? <AlertTriangle size={11} /> : null}
          {location
            ? t(`fileReview.${location.status}`)
            : t("fileReview.invalid")}
        </span>
        <span className="diff-comment-card-actions">
          <button
            className={`diff-comment-icon-btn${
              highlightColorIndex != null
                ? ` file-review-hl-${highlightColorIndex} is-active`
                : ""
            }`}
            type="button"
            title={locateLabel}
            aria-label={locateLabel}
            aria-pressed={highlightColorIndex != null}
            disabled={!canLocate}
            onClick={() => {
              if (location && canLocate) {
                onToggleLocate(item.record.annotationId, location);
              }
            }}
          >
            <LocateFixed size={12} />
          </button>
          <button
            className="diff-comment-icon-btn"
            type="button"
            title={t("diffComments.copy")}
            aria-label={t("diffComments.copy")}
            onClick={() => {
              void navigator.clipboard
                .writeText(text)
                .then(() => setCopied(true))
                .catch((e: unknown) => setError(String(e)));
            }}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
          <button
            className="diff-comment-icon-btn"
            type="button"
            title={t("diffComments.send")}
            aria-label={t("diffComments.send")}
            onClick={() => {
              const written = writeBackToChatInput(
                annotationTagFor(filePath, item),
              );
              setSent(written);
              if (!written) setError(t("fileReview.inputUnavailable"));
            }}
          >
            {sent ? <Check size={12} /> : <Send size={12} />}
          </button>
          <button
            className="diff-comment-icon-btn"
            type="button"
            title={t("diffComments.edit")}
            aria-label={t("diffComments.edit")}
            disabled={pending}
            onClick={() => setEditing(!editing)}
          >
            <Pencil size={12} />
          </button>
          <button
            className="diff-comment-icon-btn danger"
            type="button"
            title={t("diffComments.delete")}
            aria-label={t("diffComments.delete")}
            disabled={pending}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setDeleteAnchor({
                left: rect.left,
                right: rect.right,
                bottom: rect.bottom,
              });
            }}
          >
            <Trash2 size={12} />
          </button>
        </span>
      </div>
      <blockquote className="file-review-quote">
        {item.anchor?.quote ?? t("fileReview.invalid")}
      </blockquote>
      {editing ? (
        <div className="diff-comment-card-editor" data-local-shortcuts>
          <textarea
            className="diff-comment-composer-input"
            aria-label={t("diffComments.edit")}
            rows={3}
            value={draft}
            disabled={pending}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Escape") {
                e.stopPropagation();
                setEditing(false);
                setDraft(item.record.content);
              }
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                e.stopPropagation();
                void save();
              }
            }}
          />
          {byteLength > 8192 ? (
            <p className="file-review-error">{t("fileReview.contentLimit")}</p>
          ) : null}
          <div className="diff-comment-composer-actions">
            <button
              className="diff-comment-action-btn"
              type="button"
              disabled={pending}
              onClick={() => {
                setEditing(false);
                setDraft(item.record.content);
              }}
            >
              {t("diffComments.cancel")}
            </button>
            <button
              className="diff-comment-action-btn primary"
              type="button"
              disabled={pending || !draft.trim() || byteLength > 8192}
              onClick={() => void save()}
            >
              {t("diffComments.submit")}
            </button>
          </div>
        </div>
      ) : (
        <div className="diff-comment-card-body">{item.record.content}</div>
      )}
      {error ? (
        <p className="file-review-error" role="alert">
          {error}
        </p>
      ) : null}
      {deleteAnchor ? (
        <GitConfirmBubble
          anchor={deleteAnchor}
          message={t("fileReview.confirmDelete")}
          confirmLabel={t("common.delete")}
          cancelLabel={t("common.cancel")}
          confirmDisabled={pending}
          onConfirm={() => {
            setDeleteAnchor(null);
            void onDelete(item.record.annotationId);
          }}
          onCancel={() => setDeleteAnchor(null)}
        />
      ) : null}
    </article>
  );
}

export function FileReviewPanel({
  sourceKey,
  filePath,
  index,
  representation,
  selection,
  highlights,
  onCancelSelection,
  onToggleLocate,
  onClose,
}: {
  sourceKey: string;
  filePath: string;
  index: LineIndex;
  representation: FileReviewTextAnchor["representation"];
  selection: FileReviewDraftAnchor | null;
  highlights: Record<string, FileReviewHighlight>;
  onCancelSelection: () => void;
  onToggleLocate: (id: string, location: FileReviewLocation) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const review = useFileReviewAnnotations(sourceKey, filePath);
  const [hash, setHash] = useState<{ text: string; value: string } | null>(
    null,
  );
  const [hashError, setHashError] = useState("");
  const [draft, setDraft] = useState("");
  const [sent, setSent] = useState(false);
  const [localError, setLocalError] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const current = useRef({ text: index.text, selection });
  current.current = { text: index.text, selection };
  const sourceHash = hash?.text === index.text ? hash.value : "";
  const byteLength = new TextEncoder().encode(draft.trim()).length;
  useEffect(() => {
    let cancelled = false;
    setHashError("");
    void hashFileReviewText(index.text)
      .then((value) => {
        if (!cancelled) setHash({ text: index.text, value });
      })
      .catch((e: unknown) => {
        if (!cancelled) setHashError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [index.text]);
  useEffect(() => {
    setDraft("");
    setLocalError("");
    textareaRef.current?.focus();
  }, [selection]);
  const resolved = useMemo<ResolvedReview[]>(
    () =>
      review.records.map((record) => {
        const anchor = parseFileReviewAnchor(record.anchorJson);
        return {
          record,
          anchor,
          location:
            anchor && sourceHash
              ? resolveFileReviewAnchor(
                  anchor,
                  index,
                  sourceHash,
                  representation,
                )
              : null,
        };
      }),
    [review.records, sourceHash, index, representation],
  );
  const selectionValid =
    selection !== null &&
    selection.representation === representation &&
    index.text.slice(selection.start, selection.end) === selection.quote &&
    index.text.slice(
      Math.max(0, selection.start - selection.before.length),
      selection.start,
    ) === selection.before &&
    index.text.slice(selection.end, selection.end + selection.after.length) ===
      selection.after;
  const save = async (): Promise<void> => {
    if (
      !selection ||
      !selectionValid ||
      !sourceHash ||
      !draft.trim() ||
      byteLength > 8192 ||
      review.pending ||
      review.loading
    )
      return;
    const captured = selection;
    const text = index.text;
    const success = await review.create(
      JSON.stringify({ ...selection, sourceHash }),
      draft,
    );
    if (
      success &&
      current.current.text === text &&
      current.current.selection === captured
    )
      onCancelSelection();
  };
  return (
    <section className="file-review-panel" aria-label={t("fileReview.title")}>
      <div className="file-review-panel-head">
        <strong>
          {t("fileReview.title")}{" "}
          <span className="file-review-count">{review.records.length}</span>
        </strong>
        <div className="file-review-panel-actions">
          <button
            className="diff-comment-icon-btn"
            type="button"
            title={t("fileReview.sendAll")}
            aria-label={t("fileReview.sendAll")}
            disabled={review.loading || !sourceHash || resolved.length === 0}
            onClick={() => {
              // 每条标注一个专用标签：输入框中呈现为多个 chip，发送时由后端
              // 展开为「文件:行号 + 引用原文 + 标注正文」的可读文本。
              const encoded = resolved
                .map((item) => annotationTagFor(filePath, item))
                .join("\n");
              const written = writeBackToChatInput(encoded);
              setSent(written);
              if (!written) setLocalError(t("fileReview.inputUnavailable"));
            }}
          >
            {sent ? <Check size={13} /> : <Send size={13} />}
          </button>
          <button
            className="diff-comment-icon-btn"
            type="button"
            title={t("fileReview.close")}
            aria-label={t("fileReview.close")}
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <p className="file-review-hint">
        {t(
          representation === "extracted-text"
            ? "fileReview.extractedHint"
            : "fileReview.hint",
        )}
      </p>
      {review.error || hashError || localError ? (
        <p className="file-review-error" role="alert">
          {review.error || hashError || localError}
        </p>
      ) : null}
      <div className="file-review-panel-scroll">
        {selection ? (
          <div
            className="diff-comment-composer file-review-composer"
            data-local-shortcuts
          >
            <div className="diff-comment-composer-target">
              {t("fileReview.lines", {
                values: { from: selection.startLine, to: selection.endLine },
              })}
            </div>
            <blockquote className="file-review-quote">
              {selection.quote}
            </blockquote>
            <textarea
              ref={textareaRef}
              className="diff-comment-composer-input"
              rows={3}
              aria-label={t("fileReview.add")}
              placeholder={t("diffComments.placeholder")}
              value={draft}
              disabled={review.pending}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Escape") {
                  e.stopPropagation();
                  onCancelSelection();
                }
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  e.stopPropagation();
                  void save();
                }
              }}
            />
            {!selectionValid ? (
              <p className="file-review-error">
                {t("fileReview.selectionChanged")}
              </p>
            ) : null}
            {byteLength > 8192 ? (
              <p className="file-review-error">
                {t("fileReview.contentLimit")}
              </p>
            ) : null}
            <div className="diff-comment-composer-actions">
              <button
                className="diff-comment-action-btn"
                type="button"
                disabled={review.pending}
                onClick={onCancelSelection}
              >
                {t("diffComments.cancel")}
              </button>
              <button
                className="diff-comment-action-btn primary"
                type="button"
                disabled={
                  !selectionValid ||
                  !sourceHash ||
                  review.loading ||
                  review.pending ||
                  !draft.trim() ||
                  byteLength > 8192
                }
                onClick={() => void save()}
              >
                {t("diffComments.submit")}
              </button>
            </div>
          </div>
        ) : null}
        {review.loading || (!sourceHash && !hashError) ? (
          <p className="file-review-hint">{t("fileReview.loading")}</p>
        ) : resolved.length === 0 ? (
          <p className="file-review-empty">{t("fileReview.empty")}</p>
        ) : (
          resolved.map((item) => (
            <FileReviewCard
              key={item.record.annotationId}
              item={item}
              pending={review.pending}
              filePath={filePath}
              highlightColorIndex={
                highlights[item.record.annotationId]?.colorIndex ?? null
              }
              onToggleLocate={onToggleLocate}
              onUpdate={review.update}
              onDelete={review.remove}
            />
          ))
        )}
      </div>
    </section>
  );
}
