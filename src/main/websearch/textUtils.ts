/** 文本处理工具（对齐 Snow CLI 的 text.utils.ts）。 */

/** 常用命名实体（覆盖排版符号、货币、标点与西欧重音字母）。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  shy: "",
  mdash: "—",
  ndash: "–",
  minus: "−",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  sbquo: "‚",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  lsaquo: "‹",
  rsaquo: "›",
  middot: "·",
  bull: "•",
  dagger: "†",
  Dagger: "‡",
  para: "¶",
  sect: "§",
  prime: "′",
  Prime: "″",
  trade: "™",
  copy: "©",
  reg: "®",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  sup1: "¹",
  sup2: "²",
  sup3: "³",
  iexcl: "¡",
  iquest: "¿",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  curren: "¤",
  szlig: "ß",
  agrave: "à",
  aacute: "á",
  acirc: "â",
  atilde: "ã",
  auml: "ä",
  aring: "å",
  ccedil: "ç",
  egrave: "è",
  eacute: "é",
  ecirc: "ê",
  euml: "ë",
  igrave: "ì",
  iacute: "í",
  icirc: "î",
  iuml: "ï",
  ntilde: "ñ",
  ograve: "ò",
  oacute: "ó",
  ocirc: "ô",
  otilde: "õ",
  ouml: "ö",
  oslash: "ø",
  ugrave: "ù",
  uacute: "ú",
  ucirc: "û",
  uuml: "ü",
  yacute: "ý",
  yuml: "ÿ",
};

/** 数字实体：&#123;（十进制）与 &#x1F600;（十六进制）。 */
const NUMERIC_ENTITY_PATTERN = /&#(x?)([0-9a-fA-F]+);/g;

/** 命名实体：&amp;、&nbsp; 等。 */
const NAMED_ENTITY_PATTERN = /&([a-zA-Z][a-zA-Z0-9]{1,31});/g;

const decodeEntities = (text: string): string =>
  text
    .replace(
      NUMERIC_ENTITY_PATTERN,
      (match, hexMarker: string, digits: string) => {
        const code = Number.parseInt(digits, hexMarker ? 16 : 10);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
          return match;
        }
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      },
    )
    .replace(NAMED_ENTITY_PATTERN, (match, name: string) => {
      const entity = NAMED_ENTITIES[name];
      return entity === undefined ? match : entity;
    });

/** 清理文本：去掉 HTML 标签、解码实体、压缩空白。 */
export function cleanText(text: string): string {
  return decodeEntities(text.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}
