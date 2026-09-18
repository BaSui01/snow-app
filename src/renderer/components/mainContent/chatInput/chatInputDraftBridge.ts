type ChatInputDraftSink = (content: string) => void;

let sink: ChatInputDraftSink | null = null;

export const registerChatInputDraftSink = (
  handler: ChatInputDraftSink,
): (() => void) => {
  sink = handler;
  return () => {
    if (sink === handler) {
      sink = null;
    }
  };
};

export const writeBackToChatInput = (content: string): boolean => {
  if (!sink) {
    return false;
  }
  sink(content);
  return true;
};
