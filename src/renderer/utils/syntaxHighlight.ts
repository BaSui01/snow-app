import hljs from "highlight.js";

/** Bound synchronous tokenization; callers retain the complete original source. */
export const MAX_SYNTAX_HIGHLIGHT_CHARS = 128 * 1024;

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  html: "xml",
  htm: "xml",
  xhtml: "xml",
  svg: "xml",
  "text/html": "xml",
  "application/xhtml+xml": "xml",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  kt: "kotlin",
  gql: "graphql",
  toml: "ini",
  cfg: "ini",
  vue: "xml",
  svelte: "xml",
  patch: "diff",
  text: "",
  txt: "",
  plaintext: "",
  plain: "",
};

const FILE_LANGUAGES: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  css: "css",
  scss: "scss",
  less: "less",
  html: "xml",
  htm: "xml",
  xhtml: "xml",
  xml: "xml",
  svg: "xml",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  bashrc: "bash",
  zshrc: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  lua: "lua",
  r: "r",
  dart: "dart",
  vue: "xml",
  svelte: "xml",
  dockerfile: "dockerfile",
  makefile: "makefile",
  diff: "diff",
  patch: "diff",
};

/** Metadata is not part of the language, and cannot become markup attributes. */
export const getCodeLanguageHint = (info: string): string => {
  const hint = info.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9_+.#/-]*$/i.test(hint) ? hint : "";
};

export const normalizeCodeLanguage = (info: string): string => {
  const hint = getCodeLanguageHint(info);
  return Object.prototype.hasOwnProperty.call(LANGUAGE_ALIASES, hint)
    ? LANGUAGE_ALIASES[hint]
    : hint;
};

export const getCodeLanguageFromPath = (path: string): string => {
  const fileName =
    path.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() ?? "";
  if (/^dockerfile(?:\..+)?$/.test(fileName)) return "dockerfile";
  if (fileName === "gnumakefile") return "makefile";
  const extension = fileName.split(".").pop() ?? "";
  return Object.prototype.hasOwnProperty.call(FILE_LANGUAGES, extension)
    ? FILE_LANGUAGES[extension]
    : "";
};

/** Escape code text, not attribute values. Never insert the raw source as HTML. */
export const escapeCodeHtml = (source: string): string =>
  source.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const highlightCodeHtml = (source: string, info: string): string => {
  const language = normalizeCodeLanguage(info);
  if (
    source.length > MAX_SYNTAX_HIGHLIGHT_CHARS ||
    !language ||
    !hljs.getLanguage(language)
  ) {
    return escapeCodeHtml(source);
  }
  try {
    return hljs.highlight(source, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeCodeHtml(source);
  }
};
