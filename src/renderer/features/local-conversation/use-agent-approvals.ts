import { useSyncExternalStore } from "react";
import { useConversationRuntimeOverride } from "./conversation-runtime";
import { EMPTY_AGENT_APPROVAL_SNAPSHOT } from "./agent-approval-runtime";
const noSubscribe = () => () => {};
const empty = () => EMPTY_AGENT_APPROVAL_SNAPSHOT;
export function useAgentApprovals() {
  const runtime = useConversationRuntimeOverride()?.approvals;
  const snapshot = useSyncExternalStore(
    runtime?.subscribe ?? noSubscribe,
    runtime?.getSnapshot ?? empty,
  );
  return { runtime, ...snapshot };
}
