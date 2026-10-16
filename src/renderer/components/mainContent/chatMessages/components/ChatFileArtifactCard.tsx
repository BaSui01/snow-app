import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { useI18n } from "../../../../i18n";
import { openBrowserFile } from "../../../../utils/browserFileOpen";
import { highlightCodeHtml } from "../../../../utils/syntaxHighlight";
import {
  setHtmlArtifactView,
  syncHtmlArtifactZoom,
  type ArtifactLabels,
} from "./htmlArtifactRenderer";
import {
  HTML_ARTIFACT_MAX_BYTES,
  type ChatFileArtifact,
} from "./chatFileArtifacts";

type LoadState =
  { source: string } | { error: "failed" | "tooLarge" | "remote" } | null;

/** Shared DOM sandbox lifecycle used by both file cards and Markdown HTML fences. */
const HtmlFileRuntime = ({ source }: { source: string }): React.JSX.Element => {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const title = t("markdown.html.title");
  const labels = useMemo<ArtifactLabels>(
    () => ({
      code: t("markdown.html.code"),
      preview: t("markdown.html.preview"),
      pending: t("markdown.html.pending"),
      title,
      fitWidth: t("markdown.html.fitWidth"),
      fitPage: t("markdown.html.fitPage"),
      zoomIn: t("markdown.html.zoomIn"),
      zoomOut: t("markdown.html.zoomOut"),
      zoomReset: t("markdown.html.zoomReset"),
    }),
    [t, title],
  );
  const labelsRef = useRef(labels);
  labelsRef.current = labels;
  const [view, setView] = useState<"code" | "preview">("preview");
  const highlightedSource = useMemo(
    () => (view === "code" ? highlightCodeHtml(source, "html") : ""),
    [source, view],
  );
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    setHtmlArtifactView(node, view, false, labelsRef.current);
    return () => {
      node.querySelector(".html-artifact-preview")?.replaceChildren();
    };
  }, [source, view]);
  // Language switches must reach the zoom controls, which the renderer owns.
  useLayoutEffect(() => {
    const node = root.current;
    if (node) syncHtmlArtifactZoom(node, labels);
  }, [labels]);
  useEffect(() => {
    const frame = root.current?.querySelector("iframe");
    if (frame) frame.title = title;
  }, [title]);
  return (
    <div
      ref={root}
      className="html-artifact-block chat-file-artifact-runtime"
      data-html-source={encodeURIComponent(source)}
      data-html-complete="true"
      data-html-view={view}
    >
      <div className="html-artifact-toolbar">
        <button
          type="button"
          data-html-action="code"
          aria-pressed={view === "code"}
          onClick={() => setView("code")}
        >
          {t("markdown.html.code")}
        </button>
        <button
          type="button"
          data-html-action="preview"
          aria-pressed={view === "preview"}
          title={title}
          onClick={() => setView("preview")}
        >
          {t("markdown.html.preview")}
        </button>
        <div className="html-artifact-zoom-slot" />
      </div>
      <pre className="html-artifact-code chat-file-artifact-source">
        <code
          className="hljs language-html"
          dangerouslySetInnerHTML={{ __html: highlightedSource }}
        />
      </pre>
      <div className="html-artifact-preview" />
    </div>
  );
};

/** Identity-keyed by the parent: stale reads cannot repopulate a changed/suspended artifact. */
export const ChatFileArtifactCard = memo(
  ({
    artifact,
    workspace,
  }: {
    artifact: ChatFileArtifact;
    workspace: string | undefined;
  }): React.JSX.Element => {
    const { t } = useI18n();
    const { path, automatic, blocked, isSsh } = artifact;
    const [requested, setRequested] = useState(automatic);
    const [generation, setGeneration] = useState(0);
    const [loaded, setLoaded] = useState<LoadState>(null);
    const requestSequence = useRef(0);
    useEffect(() => {
      if (!requested || blocked) return;
      let cancelled = false;
      const sequence = ++requestSequence.current;
      const isCurrent = (): boolean =>
        !cancelled && sequence === requestSequence.current;
      const load = async (): Promise<void> => {
        try {
          let result;
          if (isSsh) {
            if (!workspace?.startsWith("ssh://")) {
              if (isCurrent()) setLoaded({ error: "remote" });
              return;
            }
            result = await window.snow.sshReadFile(workspace, path);
          } else {
            result = await window.snow.readFileContent(path);
          }
          if (!isCurrent()) return;
          if (
            result.size > HTML_ARTIFACT_MAX_BYTES ||
            new TextEncoder().encode(result.content).byteLength >
              HTML_ARTIFACT_MAX_BYTES
          ) {
            setLoaded({ error: "tooLarge" });
          } else if (result.isBinary || result.content.includes("\u0000")) {
            setLoaded({ error: "failed" });
          } else {
            setLoaded({ source: result.content });
          }
        } catch (error) {
          if (isCurrent()) {
            setLoaded({
              error:
                error instanceof Error &&
                error.message.includes("[SSH_FILE_TOO_LARGE]")
                  ? "tooLarge"
                  : "failed",
            });
          }
        }
      };
      void load();
      return () => {
        cancelled = true;
      };
    }, [requested, blocked, isSsh, path, workspace, generation]);
    const refresh = (): void => {
      requestSequence.current += 1;
      setLoaded(null);
      setRequested(true);
      setGeneration((value) => value + 1);
    };
    const status = blocked
      ? t("chat.fileArtifact.pending")
      : loaded && "error" in loaded
        ? t(`chat.fileArtifact.${loaded.error}`)
        : requested && !loaded
          ? t("chat.fileArtifact.loading")
          : undefined;
    return (
      <section
        className="chat-file-artifact"
        data-file-artifact-key={artifact.key}
        aria-label={path}
      >
        <div className="chat-file-artifact-header">
          <span className="chat-file-artifact-name" title={path}>
            {path.split(/[\\/]/).pop()}
          </span>
          <button
            type="button"
            className="chat-file-artifact-action"
            disabled={blocked}
            title={t("chat.fileArtifact.refresh")}
            aria-label={t("chat.fileArtifact.refresh")}
            onClick={refresh}
          >
            <RefreshCw size={15} />
          </button>
          {!isSsh ? (
            <button
              type="button"
              className="chat-file-artifact-action"
              disabled={blocked}
              title={t("toolCall.websearch.openInBrowser")}
              aria-label={t("toolCall.websearch.openInBrowser")}
              onClick={() => openBrowserFile(path)}
            >
              <ExternalLink size={15} />
            </button>
          ) : null}
        </div>
        {status ? (
          <div className="chat-file-artifact-status" role="status">
            {status}
          </div>
        ) : null}
        {!requested && !blocked ? (
          <button
            type="button"
            className="chat-file-artifact-load"
            onClick={refresh}
          >
            {t("chat.fileArtifact.load")}
          </button>
        ) : null}
        {!blocked && loaded && "source" in loaded ? (
          <HtmlFileRuntime source={loaded.source} />
        ) : null}
      </section>
    );
  },
);
ChatFileArtifactCard.displayName = "ChatFileArtifactCard";
