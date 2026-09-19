import {
  BookOpen,
  FileText,
  GitCommitHorizontal,
  GitCompare,
  Globe,
  Link2,
  MessageSquareQuote,
  MousePointer2,
  ScanSearch,
} from "lucide-react";
import { getFileTypeIcon } from "../../../utils/fileIcons";
import {
  formatLinesStr,
  getChipDisplayLabel,
  type ContentSegment,
} from "./fileTagUtils";

type ContentChipsProps = {
  /** parseContentSegments 解析出的内容片段。 */
  segments: ContentSegment[];
};

/**
 * 把内容片段渲染成聊天区同款 chip：文本段落原样输出，标签段落渲染为带图标
 * 的 chip（`user-message-file-chip` 样式）。不带悬停预览等交互，适合消息
 * 列表与回滚目标列表这类紧凑位置。
 */
export const ContentChips = ({
  segments,
}: ContentChipsProps): React.JSX.Element => (
  <>
    {segments.map((segment, index) => {
      if (segment.type === "text") {
        return <span key={index}>{segment.content}</span>;
      }

      if (segment.type === "image") {
        return (
          <span
            key={index}
            className="user-message-file-chip image-chip"
            title={segment.tag.name}
          >
            {getFileTypeIcon(segment.tag.name, false, false, {
              size: 12,
              className: "user-message-file-chip-icon",
            })}
            <span className="user-message-file-chip-name">
              {getChipDisplayLabel(segment)}
            </span>
          </span>
        );
      }

      if (segment.type === "commit") {
        const chipTitle = `${segment.tag.shortHash} ${segment.tag.message} (${segment.tag.author}, ${segment.tag.date})`;
        return (
          <span
            key={index}
            className="user-message-file-chip commit-chip"
            title={chipTitle}
          >
            <GitCommitHorizontal
              size={12}
              className="user-message-file-chip-icon"
              style={{ color: "#f05032" }}
            />
            <span className="user-message-file-chip-name">
              {getChipDisplayLabel(segment)}
            </span>
          </span>
        );
      }

      if (segment.type === "change") {
        const chipTitle = `${
          segment.tag.section === "staged" ? "Staged" : "Unstaged"
        } ${segment.tag.status} ${segment.tag.path}`;
        return (
          <span
            key={index}
            className="user-message-file-chip change-chip"
            title={chipTitle}
          >
            <GitCompare
              size={12}
              className="user-message-file-chip-icon"
              style={{ color: "#f59e0b" }}
            />
            <span className="user-message-file-chip-name">
              {getChipDisplayLabel(segment)}
            </span>
          </span>
        );
      }

      if (segment.type === "text-snippet") {
        const snippetTitle = `${segment.tag.summary} (${segment.tag.charCount} chars)`;
        return (
          <span
            key={index}
            className="user-message-file-chip text-snippet-chip"
            title={snippetTitle}
          >
            <FileText
              size={12}
              className="user-message-file-chip-icon"
              style={{ color: "#6c757d" }}
            />
            <span className="user-message-file-chip-name">
              {getChipDisplayLabel(segment)}
            </span>
          </span>
        );
      }

      if (segment.type === "quote") {
        const quoteTitle = `${segment.tag.summary} (${segment.tag.charCount} chars)`;
        return (
          <span
            key={index}
            className="user-message-file-chip quote-chip"
            title={quoteTitle}
          >
            <MessageSquareQuote
              size={12}
              className="user-message-file-chip-icon"
              style={{ color: "var(--accent-color, #4a9eff)" }}
            />
            <span className="user-message-file-chip-name">
              {getChipDisplayLabel(segment)}
            </span>
          </span>
        );
      }

      if (segment.type === "review") {
        const reviewTitle = `${segment.tag.summary} (${segment.tag.charCount} chars)`;
        return (
          <span
            key={index}
            className="user-message-file-chip review-chip"
            title={reviewTitle}
          >
            <ScanSearch
              size={12}
              className="user-message-file-chip-icon"
              style={{ color: "#2ea043" }}
            />
            <span className="user-message-file-chip-name">
              {getChipDisplayLabel(segment)}
            </span>
          </span>
        );
      }

      if (segment.type === "element") {
        const elementTitle = segment.tag.url
          ? `${segment.tag.label} (${segment.tag.url})`
          : segment.tag.label;
        return (
          <span
            key={index}
            className="user-message-file-chip element-chip"
            title={elementTitle}
          >
            <MousePointer2
              size={12}
              className="user-message-file-chip-icon"
              style={{ color: "#1a73e8" }}
            />
            <span className="user-message-file-chip-name">
              {getChipDisplayLabel(segment)}
            </span>
          </span>
        );
      }

      if (segment.type === "web") {
        const webTitle = `${getChipDisplayLabel(segment)} (${segment.tag.url})`;
        return (
          <span
            key={index}
            className="user-message-file-chip web-chip"
            title={webTitle}
          >
            <Globe
              size={12}
              className="user-message-file-chip-icon"
              style={{ color: "#0f766e" }}
            />
            <span className="user-message-file-chip-name">
              {getChipDisplayLabel(segment)}
            </span>
          </span>
        );
      }

      if (segment.type === "conversation") {
        const { tag } = segment;
        return (
          <span
            key={index}
            className="user-message-file-chip conversation-chip"
            title={tag.title}
          >
            {tag.emoji ? (
              <span
                className="user-message-file-chip-icon"
                style={{ fontSize: 12, lineHeight: 1 }}
              >
                {tag.emoji}
              </span>
            ) : (
              <Link2
                size={12}
                className="user-message-file-chip-icon"
                style={{ color: "var(--accent-color, #4a9eff)" }}
              />
            )}
            <span className="user-message-file-chip-name">
              {getChipDisplayLabel(segment)}
            </span>
          </span>
        );
      }

      if (segment.type === "skill") {
        const skillTitle = segment.tag.description
          ? `${segment.tag.name} - ${segment.tag.description}`
          : segment.tag.name;
        return (
          <span
            key={index}
            className="user-message-file-chip skill-chip"
            title={skillTitle}
          >
            <BookOpen
              size={12}
              className="user-message-file-chip-icon"
              style={{ color: "#a855f7" }}
            />
            <span className="user-message-file-chip-name">
              {getChipDisplayLabel(segment)}
            </span>
          </span>
        );
      }

      const { tag } = segment;
      const linesStr =
        !tag.isDirectory && tag.lines && tag.lines.length > 0
          ? formatLinesStr(tag.lines)
          : "";
      const fileChipTitle = linesStr ? `${tag.path}:${linesStr}` : tag.path;
      return (
        <span
          key={index}
          className="user-message-file-chip"
          title={fileChipTitle}
        >
          {getFileTypeIcon(tag.name, tag.isDirectory, false, {
            size: 12,
            className: "user-message-file-chip-icon",
          })}
          <span className="user-message-file-chip-name">
            {getChipDisplayLabel(segment)}
          </span>
        </span>
      );
    })}
  </>
);
