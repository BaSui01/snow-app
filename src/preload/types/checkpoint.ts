export type CheckpointChangeType = "added" | "modified" | "deleted";

export type CheckpointRollbackRequest = {
  checkpointIds: string[];
  workDir: string;
};

export type CheckpointFileChange = {
  path: string;
  changeType: CheckpointChangeType;
};

export type CheckpointFileDiff = CheckpointFileChange & {
  content: string;
  isBinary: boolean;
};
