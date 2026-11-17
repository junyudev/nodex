import { CoreRequestClass } from "../core-runtime/CoreRequestClass";
import * as Schema from "effect/Schema";
import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { z } from "zod";
import {
  nativeSearchThreadId,
  type NativeSearchItem,
} from "@nodex/agent-runtime/orchestration/NativeSearchHistory";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { CoreModules } from "../core-runtime/CoreModules";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexMainConversationManagers } from "../codex-application/CodexMainConversationManagers";
import { readCodexHistoryItems } from "../codex-application/CodexHistoryItems";
import { projectChat, type ChatListingItem } from "./ChatCatalogProjection";

const Position = z.strictObject({
  cursor: z.string().nullable(),
  mode: z.enum(["legacy", "paginated"]),
  itemId: z.string().nullable(),
  runId: z.string().nullable(),
});

const staleCursor = (cause: unknown) => {
  if (!Schema.is(CodexRuntimeError)(cause) || !Schema.is(CodexAppServerRequestError)(cause.cause))
    return false;
  const error = cause.cause;
  return (
    error.code === -32602 || (error.code === -32600 && error.message.startsWith("invalid cursor:"))
  );
};

/** Main owns native-host access; Runtime owns the disposable history cache and its one search index.
 * One producer page per chat per pass keeps startup and live turn delivery independent of backfill. */
export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const runtime = yield* AgentRuntimeApplication;
  const gateway = yield* CodexGateway;
  const managers = yield* CodexMainConversationManagers;
  const observedRevisions = new Map<
    string,
    { readonly revision: string; readonly retryAt?: number; readonly delay?: number }
  >();
  const ingest = Effect.fn("NativeChatSearchIndex.ingest")(function* (row: ChatListingItem) {
    const chat = projectChat(row, undefined, true);
    if (chat?.binding?.kind !== "native" || chat.backend !== "codex") return null;
    const binding = chat.binding;
    const threadId = nativeSearchThreadId(binding.hostId, binding.threadId);
    let observed = yield* gateway.connection(binding.hostId).pipe(Effect.result);
    // Local Codex starts on demand. Warm its history owner in this background fiber;
    // disconnected remote hosts stay partial until their existing owner reconnects.
    if (
      binding.hostId === gateway.localHostId &&
      observed._tag === "Success" &&
      observed.success.kind === "stopped"
    ) {
      yield* gateway.awaitReady(binding.hostId).pipe(
        Effect.timeout("10 seconds"),
        Effect.catch(() => Effect.void),
      );
      observed = yield* gateway.connection(binding.hostId).pipe(Effect.result);
    }
    const connection =
      observed._tag === "Success" && observed.success.kind === "ready" ? observed.success : null;
    const revision = JSON.stringify([
      connection?.generation ?? "unavailable",
      row.task.thread?.updated_at,
      row.task.thread?.recency_at,
      row.task.thread?.status,
    ]);
    const previous = observedRevisions.get(threadId);
    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    if (
      previous?.revision === revision &&
      (previous.retryAt === undefined || now < previous.retryAt)
    )
      return threadId;
    yield* Effect.gen(function* () {
      const state = yield* runtime.syncNativeSearchHistory({
        kind: "admit",
        threadId,
        revision,
      });
      if (state.complete || connection === null) {
        observedRevisions.set(threadId, { revision });
        return;
      }
      const manager = yield* managers.get(binding.hostId);
      const target = {
        hostId: binding.hostId,
        threadId: binding.threadId,
        generation: manager.generation,
        assertCurrent: manager.assertCurrent,
      };
      const decoded = yield* Effect.try(() =>
        state.cursor ? Position.parse(JSON.parse(state.cursor)) : null,
      ).pipe(Effect.result);
      if (decoded._tag === "Failure") {
        yield* runtime.syncNativeSearchHistory({ kind: "reset", threadId });
        return;
      }
      const position = decoded.success;
      const mode =
        position?.mode ??
        (yield* gateway.requestOnHost(
          binding.hostId,
          "thread/read",
          { threadId: binding.threadId, includeTurns: false },
          {
            expectedHostId: binding.hostId,
            expectedGeneration: manager.generation,
            priority: "background",
            source: "thread_hydration",
            timeoutMs: 10_000,
          },
        )).thread.historyMode;
      yield* Effect.try(manager.assertCurrent);
      const cursor = position?.cursor ?? null;
      const read = (limit: number) =>
        readCodexHistoryItems(
          gateway,
          target,
          { cursor, direction: "asc", limit, historyMode: mode },
          { priority: "background", source: "thread_hydration" },
        ).pipe(
          Effect.catch((cause) =>
            cursor !== null && staleCursor(cause)
              ? runtime
                  .syncNativeSearchHistory({ kind: "reset", threadId })
                  .pipe(Effect.andThen(Effect.fail(cause)))
              : Effect.fail(cause),
          ),
        );
      const native = yield* read(24);
      if (
        position?.itemId &&
        !native.data.some(
          (entry) => entry.item.id === position.itemId && entry.turnId === position.runId,
        )
      ) {
        yield* runtime.syncNativeSearchHistory({ kind: "reset", threadId });
        return;
      }
      if (native.nextCursor !== null && native.nextCursor === cursor) {
        yield* runtime.syncNativeSearchHistory({ kind: "reset", threadId });
        return;
      }
      let streaming = false;
      const items = native.data.flatMap((entry): NativeSearchItem[] => {
        const item = entry.item;
        const date = entry.startedAtMs === null ? null : new Date(entry.startedAtMs);
        const at = date && Number.isFinite(date.getTime()) ? date.toISOString() : "";
        if (
          (item.type === "commandExecution" || item.type === "fileChange") &&
          item.status === "inProgress"
        ) {
          streaming = true;
          return [];
        }
        if (
          item.type === "commandExecution" &&
          (item.status === "completed" || item.status === "failed")
        )
          return [
            {
              itemId: item.id,
              runId: entry.turnId,
              role: "command_execution",
              text: Array.from(item.command).slice(0, 4096).join(""),
              at,
            },
          ];
        if (item.type === "fileChange" && item.status === "completed")
          return [
            {
              itemId: item.id,
              runId: entry.turnId,
              role: "file_change",
              text: item.changes
                .flatMap((change) => [
                  change.path,
                  ...(change.kind.type === "update" && change.kind.move_path
                    ? [change.kind.move_path]
                    : []),
                ])
                .join("\n"),
              at,
            },
          ];
        if (item.type !== "userMessage" && item.type !== "agentMessage") return [];
        // An active partial message is reread after settlement; never index streaming deltas.
        if (
          item.type === "agentMessage" &&
          entry.completedAtMs === null &&
          !native.settledTurnIds.includes(entry.turnId) &&
          chat.activity === "running"
        ) {
          streaming = true;
          return [];
        }
        const text =
          item.type === "agentMessage"
            ? item.text
            : item.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n");
        return [
          {
            itemId: item.id,
            runId: entry.turnId,
            role: item.type === "userMessage" ? "user" : "assistant",
            text,
            at,
          },
        ];
      });
      const last = native.data.at(-1);
      // Retain the forward cursor at the start of the last page, and re-read that bounded
      // overlap when the chat grows. Reverse cursors belong to the opposite sort direction.
      const next = native.nextCursor
        ? { mode, cursor: native.nextCursor, itemId: null, runId: null }
        : last
          ? { mode, cursor, itemId: last.item.id, runId: last.turnId }
          : position;
      // A legacy turn can contain many items. Persist and yield in the same bounded slices.
      const pages = items.length
        ? Array.from({ length: Math.ceil(items.length / 24) }, (_, index) =>
            items.slice(index * 24, (index + 1) * 24),
          )
        : [[]];
      let published = state;
      for (const [index, chunk] of pages.entries()) {
        const lastChunk = index === pages.length - 1;
        published = yield* runtime.syncNativeSearchHistory({
          kind: "page",
          threadId,
          revision,
          items: chunk,
          cursor: streaming || !lastChunk ? state.cursor : next ? JSON.stringify(next) : null,
          complete:
            lastChunk && !streaming && native.nextCursor === null && chat.activity !== "running",
        });
        yield* Effect.yieldNow;
      }
      if (published.complete) observedRevisions.set(threadId, { revision });
    }).pipe(
      Effect.catch(() =>
        Effect.gen(function* () {
          // A readable host can still lack a particular chat. Leave it partial, and retry
          // changed chats promptly without continually competing for reads of missing ones.
          const delay = Math.min(
            300_000,
            previous?.revision === revision ? (previous.delay ?? 5_000) * 2 : 5_000,
          );
          const failedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
          observedRevisions.set(threadId, { revision, delay, retryAt: failedAt + delay });
        }),
      ),
    );
    yield* Effect.yieldNow;
    return threadId;
  });
  const pass = Effect.gen(function* () {
    const admitted: string[] = [];
    for (const archived of [false, true]) {
      let after: string | null = null;
      const seen = new Set<string>();
      do {
        const response: Effect.Success<ReturnType<typeof core.workspace.read>> =
          yield* core.workspace.read({
            kind: "session_window",
            archived,
            native_only: true,
            order: "identity",
            window: { first: 100, ...(after ? { after } : {}) },
          });
        if (response.value.kind !== "session_window") return;
        const page = response.value.sessions;
        const keys = yield* Effect.forEach(page.items, ingest, { concurrency: 4 });
        admitted.push(...keys.filter((key): key is string => key !== null));
        after = page.next_cursor ?? null;
        if (after && seen.has(after)) return;
        if (after) seen.add(after);
      } while (after !== null);
    }
    yield* runtime.syncNativeSearchHistory({ kind: "prune", threadIds: admitted });
    const present = new Set(admitted);
    for (const key of observedRevisions.keys())
      if (!present.has(key)) observedRevisions.delete(key);
  }).pipe(
    Effect.provideService(CoreApplicationAgent, null),
    Effect.provideService(CoreRequestClass, "background"),
  );
  return pass;
});
export const install = Effect.gen(function* () {
  const pass = yield* make;
  let failed = false;
  yield* Effect.gen(function* () {
    while (true) {
      yield* pass.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            failed = false;
          }),
        ),
        Effect.catch((cause) => {
          if (failed) return Effect.void;
          failed = true;
          return Effect.logWarning("Native chat indexing will retry", { cause });
        }),
      );
      yield* Effect.sleep("1 second");
    }
  }).pipe(Effect.forkScoped);
});
export const live = Layer.effectDiscard(install);
