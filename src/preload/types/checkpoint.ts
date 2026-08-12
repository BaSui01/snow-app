export type CheckpointChangeType = "added" | "modified" | "deleted";

export type CheckpointFileChange = {
  path: string;
  changeType: CheckpointChangeType;
};

export type CheckpointFileDiff = CheckpointFileChange & {
  content: string;
  isBinary: boolean;
};
