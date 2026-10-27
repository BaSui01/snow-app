import { createContext, useContext } from "react";
import { artifactFileKey, resolveArtifactPath } from "./chatFileArtifacts";

type ChatFileArtifactRevealValue = {
  /** 当前已展开的 HTML 文件卡片 key 集合。 */
  revealed: ReadonlySet<string>;
  /** 会话工作目录，用于把工具卡片里的原始路径解析成卡片 key。 */
  workspace: string | undefined;
};

const ChatFileArtifactRevealContext = createContext<
  ChatFileArtifactRevealValue | undefined
>(undefined);

export const ChatFileArtifactRevealProvider =
  ChatFileArtifactRevealContext.Provider;

/** 原始路径对应的 HTML 文件卡片是否已展开（无 Provider / 无法解析时视为未展开）。 */
export const useFileArtifactRevealed = (rawPath: string): boolean => {
  const value = useContext(ChatFileArtifactRevealContext);
  if (!value) {
    return false;
  }
  const path = resolveArtifactPath(rawPath, value.workspace);
  return path ? value.revealed.has(artifactFileKey(path)) : false;
};
