import * as Effect from "effect/Effect";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import { CodexNativeThreadLookup } from "../codex-application/CodexNativeThreadLookup";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { SessionHistoryReadError } from "./SessionHistoryRead";

/** Metadata pagination finds old Turns without resuming or loading their item payloads. */
export const make = Effect.gen(function* () {
  const lookup = yield* CodexNativeThreadLookup;
  const gateway = yield* CodexGateway;
  return Effect.fn("NativeSessionExecution.read")(function* (input: {
    readonly threadId: string;
    readonly hostId?: string;
    readonly runId?: string | null;
  }) {
    const unavailable = (cause: unknown) =>
      new SessionHistoryReadError({ reason: "history_unavailable", cause });
    const resolved = yield* lookup
      .resolve(input.threadId, input.hostId)
      .pipe(Effect.mapError(unavailable));
    if (input.hostId !== undefined && resolved.hostId !== input.hostId)
      return yield* unavailable(new Error("The Session's bound execution host is unavailable"));
    if (input.runId === null)
      return { selectedRunId: null, runId: null, status: "idle", revision: null };
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (;;) {
      const page: ClientRequestResponsesByMethod["thread/turns/list"] = yield* gateway
        .requestOnHost(
          resolved.hostId,
          "thread/turns/list",
          {
            threadId: input.threadId,
            cursor,
            limit: input.runId ? 50 : 1,
            sortDirection: "desc",
            itemsView: "notLoaded",
          },
          {
            expectedHostId: resolved.hostId,
            expectedGeneration: resolved.manager.generation,
            timeoutMs: 10_000,
          },
        )
        .pipe(Effect.mapError(unavailable));
      yield* Effect.try({ try: () => resolved.manager.assertCurrent(), catch: unavailable });
      const turn = input.runId
        ? page.data.find((candidate) => candidate.id === input.runId)
        : page.data[0];
      if (turn)
        return {
          selectedRunId: turn.id,
          runId: turn.id,
          status: turn.status,
          revision: {
            id: turn.id,
            status: turn.status,
            error: turn.error,
            startedAt: turn.startedAt,
            completedAt: turn.completedAt,
          },
        };
      if (!input.runId) return { selectedRunId: null, runId: null, status: "idle", revision: null };
      const nextCursor = page.nextCursor ?? null;
      if (nextCursor === null)
        return yield* new SessionHistoryReadError({
          reason: "item_unavailable",
          cause: new Error("The requested Run is no longer available"),
        });
      if (seen.has(nextCursor)) return yield* unavailable(new Error("Turn cursor did not advance"));
      seen.add(nextCursor);
      cursor = nextCursor;
    }
  });
});
