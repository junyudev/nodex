import * as Effect from "effect/Effect";
import { z } from "zod";
import { CodexNativeThreadLookup } from "../codex-application/CodexNativeThreadLookup";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { SessionHistoryReadError, SESSION_READ_MAX_BYTES } from "./SessionHistoryRead";
import { toolResultBytes } from "./app-tool-result";
import type { NativeSessionReadExecution } from "./SessionReadDetails";

const nativeCursorSchema = z.strictObject({
  version: z.literal(1),
  sessionId: z.string(),
  binding: z.string(),
  cursor: z.string(),
});

/** Native metadata stays producer-owned and uses the same concrete host/generation as history. */
export const makeNativeSessionReadDetails = Effect.gen(function* () {
  const lookup = yield* CodexNativeThreadLookup;
  const gateway = yield* CodexGateway;
  return Effect.fn("NativeSessionReadDetails.read")(function* (input: {
    readonly threadId: string;
    readonly hostId?: string;
    readonly sessionId: string;
    readonly binding: string;
    readonly runLimit: number;
    readonly runCursor?: string;
    readonly base: Record<string, unknown>;
  }) {
    const failure = (cause: unknown) =>
      new SessionHistoryReadError({ reason: "history_unavailable", cause });
    const resolved = yield* lookup
      .resolve(input.threadId, input.hostId)
      .pipe(Effect.mapError(failure));
    if (input.hostId !== undefined && resolved.hostId !== input.hostId)
      return yield* failure(new Error("Native Session host changed"));
    let cursor: string | null =
      input.runCursor === undefined
        ? null
        : yield* Effect.try({
            try: () => {
              if (!input.runCursor!.startsWith("nxnr1."))
                throw new Error("Unknown native Run cursor");
              const value = nativeCursorSchema.parse(
                JSON.parse(Buffer.from(input.runCursor!.slice(6), "base64url").toString("utf8")),
              );
              if (value.sessionId !== input.sessionId || value.binding !== input.binding)
                throw new Error("Run cursor belongs to another Session binding");
              return value.cursor;
            },
            catch: (cause) => new SessionHistoryReadError({ reason: "invalid_cursor", cause }),
          });
    const encode = (cursor: string | null) =>
      cursor === null
        ? null
        : `nxnr1.${Buffer.from(
            JSON.stringify({
              version: 1,
              sessionId: input.sessionId,
              binding: input.binding,
              cursor,
            }),
            "utf8",
          ).toString("base64url")}`;
    const thread = resolved.thread;
    const metadata = {
      id: thread.id,
      source: thread.source,
      originator: thread.originator,
      model: thread.model,
      modelProvider: thread.modelProvider,
      forkedFromId: thread.forkedFromId,
      parentThreadId: thread.parentThreadId,
      gitInfo: thread.gitInfo,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      status: thread.status,
    };
    const runs: NativeSessionReadExecution["recentRuns"][number][] = [];
    const result = (): NativeSessionReadExecution => ({
      source: "codex",
      metadata,
      runCount: null,
      pendingRequestCount: null,
      recentRuns: [...runs],
      runsPage: { nextCursor: encode(cursor) },
    });
    for (let count = 0; count < input.runLimit; count++) {
      const page = yield* gateway
        .requestOnHost(
          resolved.hostId,
          "thread/turns/list",
          {
            threadId: input.threadId,
            cursor,
            limit: 1,
            sortDirection: "desc",
            itemsView: "notLoaded",
          },
          {
            expectedHostId: resolved.hostId,
            expectedGeneration: resolved.manager.generation,
            timeoutMs: 10_000,
          },
        )
        .pipe(Effect.mapError(failure));
      yield* Effect.try({ try: () => resolved.manager.assertCurrent(), catch: failure });
      if (page.nextCursor !== null && page.nextCursor === cursor)
        return yield* failure(new Error("Native Run cursor did not advance"));
      const turn = page.data[0];
      if (!turn) {
        cursor = null;
        break;
      }
      runs.push({
        runId: turn.id,
        status: turn.status,
        startedAt: turn.startedAt ?? null,
        completedAt: turn.completedAt ?? null,
        durationMs: turn.durationMs ?? null,
      });
      const priorCursor = cursor;
      cursor = page.nextCursor ?? null;
      if (
        runs.length > 1 &&
        toolResultBytes({ ...input.base, execution: result() }) > SESSION_READ_MAX_BYTES / 2
      ) {
        runs.pop();
        cursor = priorCursor;
        break;
      }
      if (cursor === null) break;
    }
    return result();
  });
});
