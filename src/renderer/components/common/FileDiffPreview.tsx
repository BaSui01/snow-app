import { useState } from "react";
import { FilePen, FilePlus, FileX, type LucideIcon } from "lucide-react";

import { DiffViewer } from "../rightPanel/DiffViewer";

export type FileDiffPreviewItem = {
  path: string;
  changeType: string;
  content: string;
  isBinary: boolean;
};

export type FileDiffPreviewLabels = {
  loading: string;
  error: string;
  empty: string;
  selectFile: string;
};

type FileDiffPreviewProps = {
  diffs: FileDiffPreviewItem[];
  isLoading: boolean;
  hasError: boolean;
  labels: FileDiffPreviewLabels;
};

type FileChangeIconProps = {
  changeType: string;
  size?: number;
};

const FILE_CHANGE_ICON: Record<string, LucideIcon> = {
  added: FilePlus,
  modified: FilePen,
  deleted: FileX,
};

const FILE_CHANGE_CLASS: Record<string, string> = {
  added: "file-change-added",
  modified: "file-change-modified",
  deleted: "file-change-deleted",
};

export const getFileChangeClassName = (changeType: string): string =>
  FILE_CHANGE_CLASS[changeType] ?? "";

export const FileChangeIcon = ({
  changeType,
  size = 13,
}: FileChangeIconProps): React.JSX.Element => {
  const Icon = FILE_CHANGE_ICON[changeType] ?? FilePen;

  return (
    <Icon
      size={size}
      className={`file-change-icon ${getFileChangeClassName(changeType)}`}
    />
  );
};

export const FileDiffPreview = ({
  diffs,
  isLoading,
  hasError,
  labels,
}: FileDiffPreviewProps): React.JSX.Element => {
  const [selectedDiffPath, setSelectedDiffPath] = useState<string | null>(null);
  const selectedDiff =
    diffs.find((diff) => diff.path === selectedDiffPath) ?? diffs[0] ?? null;
  const isSingleFile = diffs.length <= 1;

  return (
    <div className={`file-diff-preview${isSingleFile ? " single-file" : ""}`}>
      {!isSingleFile ? (
        <div className="file-diff-preview-files">
          {isLoading ? (
            <div className="file-diff-preview-state">{labels.loading}</div>
          ) : hasError ? (
            <div className="file-diff-preview-state error">{labels.error}</div>
          ) : diffs.length > 0 ? (
            diffs.map((diff) => (
              <button
                type="button"
                key={diff.path}
                className={`file-diff-preview-file ${
                  selectedDiff?.path === diff.path ? "active" : ""
                }`}
                onClick={() => setSelectedDiffPath(diff.path)}
                title={diff.path}
              >
                <FileChangeIcon changeType={diff.changeType} />
                <span>{diff.path}</span>
              </button>
            ))
          ) : (
            <div className="file-diff-preview-state">{labels.empty}</div>
          )}
        </div>
      ) : null}
      <div className="file-diff-preview-diff">
        {selectedDiff ? (
          <DiffViewer
            key={selectedDiff.path}
            selectedFile={{
              path: selectedDiff.path,
              oldPath: null,
              indexStatus: "",
              workdirStatus: "",
              status: selectedDiff.changeType,
            }}
            diffResult={{
              content: selectedDiff.content,
              isBinary: selectedDiff.isBinary,
              error: "",
            }}
            diffLoading={false}
          />
        ) : (
          <div className="file-diff-preview-state">
            {isLoading ? labels.loading : labels.selectFile}
          </div>
        )}
      </div>
    </div>
  );
};
