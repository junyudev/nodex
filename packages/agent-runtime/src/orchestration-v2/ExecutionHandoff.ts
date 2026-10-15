import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

/** Workspace moves seal the execution root and all delegated descendants, not content access. */
export const readExecutionHandoff = Effect.fnUntraced(function* (
  store: Pick<ProjectionStoreV2Shape, "getThread">,
  threadId: ThreadId,
) {
  const thread = yield* store.getThread(threadId);
  const root =
    thread.lineage.rootThreadId === thread.id
      ? thread
      : yield* store.getThread(thread.lineage.rootThreadId);
  return root.executionHandoff ?? null;
});
