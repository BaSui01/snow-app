export interface FileReviewAnnotationRecord {
  id: string;
  annotationId: string;
  sourceKey: string;
  filePath: string;
  anchorJson: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

/** Offsets and context lengths use JavaScript UTF-16 code units. */
export interface FileReviewTextAnchor {
  kind: "text-range";
  representation: "source" | "extracted-text";
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  quote: string;
  before: string;
  after: string;
  sourceHash: string;
}
