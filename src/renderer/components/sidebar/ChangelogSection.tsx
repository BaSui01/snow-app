import { ChevronRight, LoaderCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { localeLabels, useI18n, type Locale } from "../../i18n";
import { MarkdownBlock } from "../mainContent/chatMessages/components/markdownRenderer";

/** 发行说明可切换的语言顺序（中文优先，与更新弹窗一致）。 */
const CHANGELOG_LOCALES: Locale[] = ["zh-CN", "zh-TW", "en"];

type ReleaseNotesByLocale = Record<Locale, string>;

/** 单个版本节点的拆分结果：版本号 + 该版本的 markdown 正文。 */
type ReleaseNoteSection = {
  version: string;
  body: string;
};

/**
 * 仓库内的发行说明文件（RELEASE_NOTES*.md）以 ?raw 打进渲染层包：
 * 三份文件合计约 330KB，放在独立 chunk 中按需加载，不拖慢首屏。
 */
const loadReleaseNotes = async (): Promise<ReleaseNotesByLocale> => {
  const [zhCN, zhTW, en] = await Promise.all([
    import("../../../../RELEASE_NOTES_ZH.md?raw"),
    import("../../../../RELEASE_NOTES_ZH_TW.md?raw"),
    import("../../../../RELEASE_NOTES.md?raw"),
  ]);
  return { "zh-CN": zhCN.default, "zh-TW": zhTW.default, en: en.default };
};

/**
 * 按版本标题（整行 `## vX.Y.Z`）把发行说明拆成逐个版本节点：
 * 版本标题行进入节点头部，其余内容作为该节点的正文。
 * 英文版的小节标题（`## New Features` 等）与版本标题同级，靠“整行且以 v 开头”区分。
 */
const parseReleaseSections = (markdown: string): ReleaseNoteSection[] => {
  const sections: ReleaseNoteSection[] = [];
  let version: string | null = null;
  let bodyLines: string[] = [];

  const flush = (): void => {
    if (version) {
      sections.push({ version, body: bodyLines.join("\n").trim() });
    }
  };

  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(v\S+)\s*$/.exec(line);
    if (heading) {
      flush();
      version = heading[1];
      bodyLines = [];
      continue;
    }
    if (version) {
      bodyLines.push(line);
    }
  }
  flush();
  return sections;
};

/** 更新日志：按版本拆分渲染发行说明文件（简体 / 繁体 / 英文），默认跟随应用语言。 */
export function ChangelogSection(): React.JSX.Element {
  const { locale, t } = useI18n();
  const [releaseNotes, setReleaseNotes] = useState<ReleaseNotesByLocale | null>(
    null,
  );
  const [activeLocale, setActiveLocale] = useState<Locale>(locale);
  const [openVersions, setOpenVersions] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    void loadReleaseNotes().then((notes) => {
      if (!cancelled) {
        setReleaseNotes(notes);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const sections = useMemo(
    () =>
      releaseNotes ? parseReleaseSections(releaseNotes[activeLocale]) : [],
    [releaseNotes, activeLocale],
  );
  const latestVersion = sections[0]?.version ?? "";

  const toggleVersion = (version: string, open: boolean): void => {
    setOpenVersions((previous) => ({ ...previous, [version]: !open }));
  };

  return (
    <div className="api-settings-manual-form settings-changelog-card">
      <div className="api-settings-manual-header">
        <strong>
          {t("settings.changelogTab", { defaultValue: "Changelog" })}
        </strong>
        <span>
          {t("settings.changelogInfo", {
            defaultValue: "Release notes for every Snow App version.",
          })}
        </span>
      </div>

      <div className="api-settings-form-body">
        <div className="update-dialog-notes-title">
          <span>
            {t("settings.updateDialogNotesTitle", {
              defaultValue: "Release notes",
            })}
          </span>
          <div
            className="update-dialog-lang-switch"
            role="group"
            aria-label={t("settings.updateDialogNotesLanguage", {
              defaultValue: "Release notes language",
            })}
          >
            {CHANGELOG_LOCALES.map((notesLocale) => (
              <button
                key={notesLocale}
                type="button"
                className={activeLocale === notesLocale ? "active" : ""}
                onClick={() => setActiveLocale(notesLocale)}
              >
                {localeLabels[notesLocale]}
              </button>
            ))}
          </div>
        </div>

        {releaseNotes ? (
          <div className="update-dialog-notes settings-changelog-notes">
            {sections.map(({ version, body }) => {
              const open = openVersions[version] ?? version === latestVersion;
              return (
                <div
                  key={version}
                  className={`settings-changelog-node ${open ? "open" : ""}`}
                >
                  <button
                    type="button"
                    className="settings-changelog-node-header"
                    aria-expanded={open}
                    onClick={() => toggleVersion(version, open)}
                  >
                    <ChevronRight
                      size={14}
                      strokeWidth={1.8}
                      className="settings-changelog-node-chevron"
                      aria-hidden="true"
                    />
                    <span className="settings-changelog-node-version">
                      {version}
                    </span>
                  </button>
                  {open && (
                    <div className="settings-changelog-node-body">
                      <MarkdownBlock
                        className="update-dialog-notes-markdown"
                        content={body}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="settings-changelog-loading" role="status">
            <LoaderCircle
              size={14}
              strokeWidth={1.8}
              className="tool-call-icon-spinning"
              aria-hidden="true"
            />
            <span>{t("common.loading", { defaultValue: "Loading..." })}</span>
          </div>
        )}
      </div>
    </div>
  );
}
