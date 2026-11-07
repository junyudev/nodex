import { hasImportedThreadHistory, type OrchestrationV2AppThread } from "@nodex/runtime-contracts";

/**
 * The execution fact behind "a Thread started". Imported history is not new activity, and a bulk
 * import must not look like thousands of conversations starting at once.
 */
export const threadCreatedAnalytics = (
  thread: OrchestrationV2AppThread,
  driver: string | null,
): Readonly<Record<string, unknown>> | null => {
  if (hasImportedThreadHistory(thread.historyOrigin)) return null;
  return {
    driver,
    model: thread.modelSelection.model,
    kind:
      thread.sideChat !== undefined ? "side_chat" : (thread.lineage.relationshipToParent ?? "root"),
    source: thread.creationSource,
    actor: thread.createdBy,
  };
};
