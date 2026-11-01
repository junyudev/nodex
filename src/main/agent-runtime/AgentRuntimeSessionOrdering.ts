import * as Effect from "effect/Effect";
import type { AgentRuntimeApplicationConnection } from "./AgentRuntimeApplication";
import { coreSessionResolver } from "./AgentRuntimeSessionActivity";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CoreModules } from "../core-runtime/CoreModules";
import { createOperationId } from "../core-runtime/operation-identity";

/**
 * Brings Core's Session activity up to the Runtime's latest person-authored messages. Live sends
 * already raise it through Core's accepted-message receipt; reconciliation backfills chats and
 * heals any send whose receipt never reached Core. Only placement facts cross: history stays with
 * the Runtime.
 */
export const make = Effect.fn("AgentRuntimeSessionOrdering.make")(function* () {
  const core = yield* CoreModules;
  const resolve = yield* coreSessionResolver;
  const record = Effect.fn("AgentRuntimeSessionOrdering.record")(function* (
    connection: AgentRuntimeApplicationConnection,
    observations: readonly { readonly threadId: string; readonly atMs: number }[],
  ) {
    if (observations.length === 0) return;
    const sessions = yield* resolve(
      connection.identity.runtimeId,
      observations.map((row) => row.threadId),
    );
    const entries = observations.flatMap((row) => {
      const sessionId = sessions.get(row.threadId);
      return sessionId && Number.isSafeInteger(row.atMs)
        ? [{ session_id: sessionId, at_ms: row.atMs }]
        : [];
    });
    if (entries.length === 0) return;
    yield* core.workspace
      .apply({
        operationId: createOperationId("agent-runtime.session-activity"),
        intent: { kind: "record_session_activity", entries },
      })
      .pipe(Effect.provideService(CoreApplicationAgent, null));
  });
  return {
    /** The caller supplies an established connection; reconciliation cannot start execution. */
    reconcile: (connection: AgentRuntimeApplicationConnection) =>
      Effect.gen(function* () {
        let cursor: string | undefined;
        do {
          const page = yield* connection.request("sessions.catalog", {
            ...(cursor === undefined ? {} : { cursor }),
            limit: 100,
            includeSubagents: false,
          });
          yield* record(
            connection,
            page.items.flatMap((item) =>
              item.latestUserAuthoredMessageAt === null
                ? []
                : [{ threadId: item.threadId, atMs: Date.parse(item.latestUserAuthoredMessageAt) }],
            ),
          );
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "Session activity will reconcile on the next Runtime connection",
            cause,
          ),
        ),
      ),
  };
});
