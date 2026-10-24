import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import * as nodePath from "node:path";
import type {
  ThreadItemEntry,
  ThreadItemsListResponse,
  ThreadTurnsListResponse,
  ThreadTimelineListResponse,
} from "@nodex/codex-app-server-protocol/v2";
import type { CodexNativeInteraction } from "@t3tools/provider-core/server/nativeInteraction";
import { EventId, ProviderSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import { importIdentity } from "./NativeImportHistory.ts";
import { isAgentRuntimeCodexThreadSource } from "./CodexThreadSource.ts";
import type { NativeImportInput } from "./NativeImport.ts";
import type { NativeImportBoundary } from "./NativeImportSource.ts";
const fail = (message: string) => Effect.fail(new Error(message));

export const openCodexImportSource = Effect.fn("CodexImportSource.open")(function* (
  input: typeof NativeImportInput.Type,
) {
  const sink = yield* EventSinkV2;
  const sessions = yield* ProviderSessionManagerV2;
  const runtimePolicy = {
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    cwd: input.cwd,
  };
  const sourceSessionId = ProviderSessionId.make(`native-import:${importIdentity(input.threadId)}`);
  let sourceClosed = false;
  const closeSource = Effect.fn("NativeImport.closeSource")(function* () {
    if (sourceClosed) return;
    yield* sessions.close(sourceSessionId);
    const closedAt = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make(randomUUID()),
          type: "provider-session.detached",
          threadId: input.threadId,
          occurredAt: closedAt,
          payload: {
            providerSessionId: sourceSessionId,
            detachedAt: closedAt,
            reason: "Codex import history reader released",
          },
        },
      ],
    });
    sourceClosed = true;
  });
  const session = yield* Effect.acquireRelease(
    sessions.open({
      threadId: input.threadId,
      providerSessionId: sourceSessionId,
      modelSelection: input.modelSelection,
      runtimePolicy,
    }),
    () => closeSource().pipe(Effect.orDie),
  );
  const native = session.codexNative;
  if (!native) return yield* fail("The Codex Agent does not expose native import capabilities.");
  yield* native.initialize;
  return {
    capture: Effect.fn("CodexImportSource.capture")(function* () {
      const source = (yield* native.request("thread/read", {
        threadId: input.sourceNativeThreadId,
        includeTurns: false,
      })).thread;
      if (source.id !== input.sourceNativeThreadId)
        return yield* fail("Codex returned a different source conversation.");
      if (!nodePath.isAbsolute(source.cwd))
        return yield* fail(
          "This conversation has no recorded working folder, so it can’t be imported.",
        );
      if (source.parentThreadId || isAgentRuntimeCodexThreadSource(source.threadSource))
        return yield* fail(
          "This is a subagent conversation or one Nodex runs itself, so it can’t be imported.",
        );
      if (source.ephemeral || source.status.type === "active")
        return yield* fail(
          "This Codex conversation is still running. Import it after it finishes.",
        );
      if (source.historyMode === "paginated")
        yield* assertOrdinaryHistory(native, input.sourceNativeThreadId);
      const latest = yield* native.request("thread/turns/list", {
        threadId: input.sourceNativeThreadId,
        limit: 1,
        sortDirection: "desc",
        itemsView: "full",
      });
      const turn = latest.data[0];
      if (turn?.status === "inProgress")
        return yield* fail(
          "This Codex conversation is still running. Import it after it finishes.",
        );
      const boundary = turn?.items.at(-1);
      if (turn && !boundary)
        return yield* fail("Codex could not read the latest turn of this conversation.");
      return {
        boundaryItemId: boundary?.id ?? null,
        boundaryTurnId: turn?.id ?? null,
        historyMode: source.historyMode,
        sourceCwd: source.cwd,
        sourceRevision: null,
      };
    }),
    page: Effect.fn("CodexImportSource.page")(function* (
      boundary: NativeImportBoundary,
      cursor: string | null,
    ) {
      const nativePage: ThreadItemsListResponse | ThreadTurnsListResponse =
        boundary.boundaryItemId === null
          ? { data: [], nextCursor: null, backwardsCursor: null }
          : boundary.historyMode === "legacy"
            ? yield* native.request("thread/turns/list", {
                threadId: input.sourceNativeThreadId,
                cursor,
                limit: 20,
                sortDirection: "asc",
                itemsView: "full",
              })
            : yield* native.request("thread/items/list", {
                threadId: input.sourceNativeThreadId,
                cursor,
                limit: 50,
                sortDirection: "asc",
              });
      const entries: ThreadItemEntry[] =
        boundary.historyMode === "legacy"
          ? (nativePage as ThreadTurnsListResponse).data.flatMap((turn) =>
              turn.items.map((item) => ({
                turnId: turn.id,
                item,
                startedAtMs: turn.startedAt === null ? null : turn.startedAt * 1000,
                completedAtMs: turn.completedAt === null ? null : turn.completedAt * 1000,
              })),
            )
          : (nativePage as ThreadItemsListResponse).data;
      return { data: entries, nextCursor: nativePage.nextCursor };
    }),
    close: closeSource(),
  };
});

const assertOrdinaryHistory = Effect.fn("NativeImport.assertOrdinaryHistory")(function* (
  native: CodexNativeInteraction,
  threadId: string,
) {
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page: ThreadTimelineListResponse = yield* native.request("thread/timeline/list", {
      threadId,
      cursor,
      limit: 100,
    });
    if (
      page.activeRealtimeSessionAtPageStart ||
      page.data.some((entry) => entry.type === "realtime")
    )
      return yield* fail("Voice conversations cannot yet be copied into Nodex.");
    if (Buffer.byteLength(JSON.stringify(page), "utf8") > 8 * 1024 * 1024)
      return yield* fail("Part of this conversation is too large to import.");
    if (page.nextCursor !== null && (page.nextCursor === cursor || seen.has(page.nextCursor)))
      return yield* fail("Codex import timeline repeated a continuation cursor.");
    cursor = page.nextCursor;
    if (cursor !== null) seen.add(cursor);
  } while (cursor !== null);
});
