import { createContext, useContext } from "react";

/** Moves the Chat into the pane on `side`, putting its content panel on the other side. */
export interface ThreadStagePaneMove {
  readonly side: "left" | "right";
  readonly onSelect: () => void;
}

/**
 * Where the shell renders the registered thread header. The titlebar shows the title and Chat
 * actions; a full-view Chat tab shows only the Chat actions, sized for the tab.
 */
export interface ThreadStageHeaderSlot {
  readonly variant: "titlebar" | "chat-tab";
  /** Offered only while the Chat and its content are side by side. */
  readonly paneMove: ThreadStagePaneMove | null;
}

const TITLEBAR_SLOT: ThreadStageHeaderSlot = { variant: "titlebar", paneMove: null };

export const ThreadStageHeaderSlotContext = createContext<ThreadStageHeaderSlot>(TITLEBAR_SLOT);

export function useThreadStageHeaderSlot(): ThreadStageHeaderSlot {
  return useContext(ThreadStageHeaderSlotContext);
}
