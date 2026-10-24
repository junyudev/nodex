import type * as CodexSchema from "effect-codex-app-server/schema";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as Effect from "effect/Effect";

/** Codex 0.156 replaces count-based rollback with a boundary in paginated history. */
export const revertCodexThread = Effect.fn("revertCodexThread")(function* (
  client: Pick<CodexClient.CodexAppServerClient["Service"], "request">,
  threadId: string,
  numTurns: number,
) {
  let remaining = numTurns;
  let beforeTurnId: string | undefined;
  let cursor: string | null = null;
  const visited = new Set<string | null>();
  while (remaining > 0) {
    if (visited.has(cursor)) {
      return yield* CodexErrors.CodexAppServerRequestError.internalError(
        "Thread history pagination repeated a cursor.",
        undefined,
        { method: "thread/turns/list", operation: "decode-payload" },
      );
    }
    visited.add(cursor);
    const page: CodexSchema.V2ThreadTurnsListResponse = yield* client.request("thread/turns/list", {
      threadId,
      cursor,
      limit: Math.min(remaining, 100),
      sortDirection: "desc",
      itemsView: "summary",
    });
    for (const turn of page.data) {
      beforeTurnId = turn.id;
      if (--remaining === 0) break;
    }
    cursor = page.nextCursor ?? null;
    if (cursor === null) break;
  }
  return beforeTurnId === undefined
    ? yield* client.request("thread/read", { threadId, includeTurns: false })
    : yield* client.request("thread/revert", { threadId, beforeTurnId });
});

/** Reconcile a durable set of discarded Turns, so a lost acknowledgement cannot rewind twice. */
export const revertCodexThreadTurns = Effect.fn("revertCodexThreadTurns")(function* (
  client: Pick<CodexClient.CodexAppServerClient["Service"], "request">,
  threadId: string,
  discardedTurnIds: ReadonlyArray<string>,
) {
  const discarded = new Set(discardedTurnIds);
  const firstDiscarded = discardedTurnIds[0];
  let beforeTurnId: string | undefined;
  let cursor: string | null = null;
  const visited = new Set<string | null>();
  while (discarded.size > 0) {
    if (visited.has(cursor)) {
      return yield* CodexErrors.CodexAppServerRequestError.internalError(
        "Thread history pagination repeated a cursor.",
        undefined,
        { method: "thread/turns/list", operation: "decode-payload" },
      );
    }
    visited.add(cursor);
    const page: CodexSchema.V2ThreadTurnsListResponse = yield* client.request("thread/turns/list", {
      threadId,
      cursor,
      limit: cursor === null ? Math.min(discarded.size, 100) : 100,
      sortDirection: "desc",
      itemsView: "summary",
    });
    for (const turn of page.data) {
      if (discarded.has(turn.id)) beforeTurnId = turn.id;
      if (turn.id === firstDiscarded) break;
    }
    cursor = page.nextCursor ?? null;
    if (beforeTurnId === firstDiscarded || cursor === null) break;
  }
  return beforeTurnId === undefined
    ? yield* client.request("thread/read", { threadId, includeTurns: false })
    : yield* client.request("thread/revert", { threadId, beforeTurnId });
});
