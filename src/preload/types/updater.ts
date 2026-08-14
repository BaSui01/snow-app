export interface UpdateStatus {
  available: boolean;
  version: string | null;
  downloading: boolean;
  progress: number;
  downloaded: boolean;
  error: string | null;
  /** 新版本的发行说明（markdown 文本；无说明时为 null） */
  releaseNotes: string | null;
  /** 新版本的中文发行说明（markdown 文本；未提供翻译时为 null） */
  releaseNotesZh: string | null;
}
