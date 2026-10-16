/** Pure local-file URL boundary, shared by the renderer and Markdown worker. */
export const localFileUrlToPath = (input: string): string | undefined => {
  // Check the original spelling before WHATWG normalizes localhost or backslashes.
  if (!/^file:\/\/\/(?!\/)/i.test(input) || /[\\\u0000-\u0020]/.test(input))
    return;
  if (/%(?:2f|5c)/i.test(input)) return;
  try {
    const url = new URL(input);
    if (
      url.protocol !== "file:" ||
      url.host ||
      url.username ||
      url.password ||
      url.search
    )
      return;
    if (url.hash && !/^#L\d+$/i.test(url.hash)) return;
    const decoded = decodeURIComponent(url.pathname);
    if (/[\\\u0000-\u001f\u007f]/.test(decoded) || !/^\/(?!\/)/.test(decoded))
      return;
    // Device namespaces and alternate Windows drive spellings are not local paths.
    if (/^\/(?:\?{1,2}|\.)(?:\/|$)/.test(decoded) || decoded.includes("|"))
      return;
    const windows = /^\/[a-z]:\//i.test(decoded);
    const path = windows ? decoded.slice(1) : decoded;
    if (path.slice(windows ? 2 : 0).includes(":")) return;
    if (
      windows &&
      path
        .split("/")
        .slice(1)
        .some((segment) =>
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(
            segment.trimEnd(),
          ),
        )
    )
      return;
    return path;
  } catch {
    return;
  }
};
