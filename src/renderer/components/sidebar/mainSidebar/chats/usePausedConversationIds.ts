import { useMemo, useRef } from "react";

import type { ConversationSessionState } from "../../../mainContent/chatMessages/utils/conversationTypes";

export function usePausedConversationIds(
  sessions: Record<string, ConversationSessionState>,
): Set<string> {
  const previousRef = useRef<Set<string>>(new Set());
  return useMemo(() => {
    const next = new Set<string>();
    for (const [id, session] of Object.entries(sessions)) {
      if (session.isPaused) {
        next.add(id);
      }
    }
    const previous = previousRef.current;
    if (previous.size === next.size) {
      let same = true;
      for (const id of next) {
        if (!previous.has(id)) {
          same = false;
          break;
        }
      }
      if (same) {
        return previous;
      }
    }
    previousRef.current = next;
    return next;
  }, [sessions]);
}
