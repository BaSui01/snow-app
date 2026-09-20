/** 转义正则元字符，用于把关键词安全地拼成高亮匹配模式。 */
const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type HighlightedTextProps = {
  text: string;
  /** 检索关键词；整句与分词都会高亮，留空时原样返回。 */
  query: string;
};

/**
 * 命中高亮：把关键词（整句 + 分词）在文本中的出现位置包成 <mark>。
 * 利用带捕获组的 split 特性——奇数下标即为命中片段。
 * 备忘录面板与项目记忆面板共用同一套高亮规则与样式（.search-hit-mark）。
 */
export function HighlightedText({
  text,
  query,
}: HighlightedTextProps): React.JSX.Element {
  const terms = [...new Set([query, ...query.split(/\s+/)])].filter(
    (term) => term.trim() !== "",
  );
  if (terms.length === 0) {
    return <>{text}</>;
  }
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "gi");
  return (
    <>
      {text.split(pattern).map((part, index) =>
        index % 2 === 1 ? (
          <mark className="search-hit-mark" key={`${part}-${index}`}>
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}
