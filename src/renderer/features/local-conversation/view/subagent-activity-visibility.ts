import { createContext, useContext } from "react";

/**
 * Whether the thread body around this subtree shows subagent lifecycle: multi-agent tool calls,
 * subagent activity rows, and the rows for a Turn's background agents. The main Conversation shows
 * it; the floating composer's view of the same thread leaves it to the Conversation. The body's
 * timeline, Turn projection, and Find all read this one value.
 */
export const SubagentActivityVisibilityContext = createContext(true);

export function useShowSubagentActivity(): boolean {
  return useContext(SubagentActivityVisibilityContext);
}
