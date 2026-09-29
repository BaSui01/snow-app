import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, Pencil, Send, Trash2 } from "lucide-react";

import { useI18n } from "../../i18n";
import { writeBackToChatInput } from "../mainContent/chatInput/chatInputDraftBridge";

import type {
  DiffCommentSide,
  DiffReviewCommentRecord,
} from "../../../preload";

type Translate = (
  key: string,
  options?: { values?: Record<string, string | number> },
) => string;

const sideLabel = (side: DiffCommentSide, t: Translate): string =>
  side === "old" ? t("diffComments.sideOld") : t("diffComments.sideNew");

/** 单条评论发送到输入框的文本。 */
export const buildSingleCommentMessage = (
  filePath: string,
  comment: Pick<DiffReviewCommentRecord, "lineNumber" | "side" | "content">,
  t: Translate,
): string =>
  t("diffComments.messageSingle", {
    values: {
      path: filePath,
      line: comment.lineNumber,
      side: sideLabel(comment.side, t),
      content: comment.content,
    },
  });

/** 全部评论合并发送到输入框的文本（按行号排序）。 */
export const buildAllCommentsMessage = (
  filePath: string,
  comments: DiffReviewCommentRecord[],
  t: Translate,
): string => {
  const items = [...comments]
    .sort((left, right) => left.lineNumber - right.lineNumber)
    .map((comment) =>
      t("diffComments.messageItem", {
        values: {
          line: comment.lineNumber,
          side: sideLabel(comment.side, t),
          content: comment.content,
        },
      }),
    )
    .join("\n");
  return `${t("diffComments.messageHeader", { values: { path: filePath } })}\n\n${items}`;
};

type DiffCommentComposerProps = {
  filePath: string;
  side: DiffCommentSide;
  lineNumber: number;
  onSubmit: (content: string) => void;
  onCancel: () => void;
};

/** 行内新增评论的编辑器（挂载在 diff 行下方的 widget 行）。 */
export const DiffCommentComposer = ({
  filePath,
  side,
  lineNumber,
  onSubmit,
  onCancel,
}: DiffCommentComposerProps): React.JSX.Element => {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const submit = (): void => {
    const content = draft.trim();
    if (!content) {
      return;
    }
    onSubmit(content);
  };

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="diff-comment-composer">
      <div className="diff-comment-composer-target">
        {`${filePath}:${lineNumber}`}
        <span className="diff-comment-composer-side">{sideLabel(side, t)}</span>
      </div>
      <textarea
        ref={textareaRef}
        className="diff-comment-composer-input"
        rows={3}
        value={draft}
        placeholder={t("diffComments.placeholder")}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="diff-comment-composer-actions">
        <button
          type="button"
          className="diff-comment-action-btn"
          onClick={onCancel}
        >
          {t("diffComments.cancel")}
        </button>
        <button
          type="button"
          className="diff-comment-action-btn primary"
          disabled={!draft.trim()}
          onClick={submit}
        >
          {t("diffComments.submit")}
        </button>
      </div>
    </div>
  );
};

type DiffCommentCardProps = {
  comment: DiffReviewCommentRecord;
  filePath: string;
  /** 该行当前内容；null 表示行已不存在（未匹配到代码行）。 */
  currentLineContent: string | null;
  onUpdate: (commentId: string, content: string) => void;
  onDelete: (commentId: string) => void;
};

/** 单条评论卡片：展示 + 编辑 / 删除 / 复制 / 发送到输入框。 */
export const DiffCommentCard = ({
  comment,
  filePath,
  currentLineContent,
  onUpdate,
  onDelete,
}: DiffCommentCardProps): React.JSX.Element => {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.content);
  const [copied, setCopied] = useState(false);
  const [sent, setSent] = useState(false);

  const isOutdated =
    currentLineContent !== null && currentLineContent !== comment.lineContent;

  useEffect(() => {
    setDraft(comment.content);
  }, [comment.content]);

  const handleCopy = (): void => {
    navigator.clipboard
      .writeText(comment.content)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => undefined);
  };

  const handleSend = (): void => {
    const written = writeBackToChatInput(
      buildSingleCommentMessage(filePath, comment, t),
    );
    if (written) {
      setSent(true);
      window.setTimeout(() => setSent(false), 2000);
    }
  };

  const handleSave = (): void => {
    const content = draft.trim();
    if (!content) {
      return;
    }
    onUpdate(comment.commentId, content);
    setEditing(false);
  };

  const handleEditorKeyDown = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      setEditing(false);
      setDraft(comment.content);
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      handleSave();
    }
  };

  return (
    <div className="diff-comment-card">
      <div className="diff-comment-card-head">
        <span className="diff-comment-card-meta">
          {`${sideLabel(comment.side, t)} · ${comment.lineNumber}`}
        </span>
        {isOutdated ? (
          <span
            className="diff-comment-card-outdated"
            title={t("diffComments.outdated")}
          >
            <AlertTriangle size={11} strokeWidth={1.8} />
            {t("diffComments.outdated")}
          </span>
        ) : null}
        <span className="diff-comment-card-actions">
          <button
            type="button"
            className="diff-comment-icon-btn"
            title={t("diffComments.copy")}
            aria-label={t("diffComments.copy")}
            onClick={handleCopy}
          >
            {copied ? (
              <Check size={12} strokeWidth={1.8} />
            ) : (
              <Copy size={12} strokeWidth={1.8} />
            )}
          </button>
          <button
            type="button"
            className="diff-comment-icon-btn"
            title={t("diffComments.send")}
            aria-label={t("diffComments.send")}
            onClick={handleSend}
          >
            {sent ? (
              <Check size={12} strokeWidth={1.8} />
            ) : (
              <Send size={12} strokeWidth={1.8} />
            )}
          </button>
          <button
            type="button"
            className="diff-comment-icon-btn"
            title={t("diffComments.edit")}
            aria-label={t("diffComments.edit")}
            onClick={() => setEditing((value) => !value)}
          >
            <Pencil size={12} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className="diff-comment-icon-btn danger"
            title={t("diffComments.delete")}
            aria-label={t("diffComments.delete")}
            onClick={() => onDelete(comment.commentId)}
          >
            <Trash2 size={12} strokeWidth={1.8} />
          </button>
        </span>
      </div>
      {editing ? (
        <div className="diff-comment-card-editor">
          <textarea
            className="diff-comment-composer-input"
            rows={3}
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleEditorKeyDown}
          />
          <div className="diff-comment-composer-actions">
            <button
              type="button"
              className="diff-comment-action-btn"
              onClick={() => {
                setEditing(false);
                setDraft(comment.content);
              }}
            >
              {t("diffComments.cancel")}
            </button>
            <button
              type="button"
              className="diff-comment-action-btn primary"
              disabled={!draft.trim()}
              onClick={handleSave}
            >
              {t("diffComments.submit")}
            </button>
          </div>
        </div>
      ) : (
        <div className="diff-comment-card-body">{comment.content}</div>
      )}
    </div>
  );
};

type DiffCommentListProps = {
  comments: DiffReviewCommentRecord[];
  filePath: string;
  currentLineContent: string | null;
  onUpdate: (commentId: string, content: string) => void;
  onDelete: (commentId: string) => void;
};

/** 挂载在 diff 行下方的评论列表（extendData 渲染）。 */
export const DiffCommentList = ({
  comments,
  filePath,
  currentLineContent,
  onUpdate,
  onDelete,
}: DiffCommentListProps): React.JSX.Element => (
  <div className="diff-comment-list">
    {comments.map((comment) => (
      <DiffCommentCard
        key={comment.commentId}
        comment={comment}
        filePath={filePath}
        currentLineContent={currentLineContent}
        onUpdate={onUpdate}
        onDelete={onDelete}
      />
    ))}
  </div>
);

type DiffCommentOrphanSectionProps = {
  comments: DiffReviewCommentRecord[];
  filePath: string;
  onUpdate: (commentId: string, content: string) => void;
  onDelete: (commentId: string) => void;
};

/** 行号已不存在于当前 diff 的评论兜底区域。 */
export const DiffCommentOrphanSection = ({
  comments,
  filePath,
  onUpdate,
  onDelete,
}: DiffCommentOrphanSectionProps): React.JSX.Element => {
  const { t } = useI18n();

  return (
    <div className="diff-comment-orphans">
      <div className="diff-comment-orphans-title">
        {t("diffComments.unmatchedTitle")}
      </div>
      {comments.map((comment) => (
        <DiffCommentCard
          key={comment.commentId}
          comment={comment}
          filePath={filePath}
          currentLineContent={null}
          onUpdate={onUpdate}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
};
