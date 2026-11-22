import { CoreRequestClass } from "../core-runtime/CoreRequestClass";
import * as Schema from "effect/Schema";
import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
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
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
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

/** Rounds start at least this far apart, so each chat reads at most one history page a second. */
const ROUND_SPACING_MS = 1_000;
/** A turn lands as several Core commits; a short pause gathers them into one round. */
const SIGNAL_SETTLE = "100 millis";
/** A sweep rereads every native chat, one Core page per 100, to recover a dropped change notice
 * and prune removed chats. Five minutes keeps an idle Profile's cost negligible while bounding how
 * long either can linger; a chat in failure backoff still waits for its own retry time. */
const SWEEP_INTERVAL_MS = 300_000;
/** Core reads at most 100 Sessions by identity. A larger backlog is cheaper as one sweep. */
const SESSION_BATCH = 100;
const MAX_CHANGED_SESSIONS = 1_000;

const nativeTarget = (row: ChatListingItem) => {
  const chat = projectChat(row, undefined, true);
  if (chat?.binding?.kind !== "native" || chat.backend !== "codex") return null;
  const binding = chat.binding;
  return { row, chat, binding, threadId: nativeSearchThreadId(binding.hostId, binding.threadId) };
};
type NativeTarget = NonNullable<ReturnType<typeof nativeTarget>>;

/**
 * Main owns native-host access; Runtime owns the disposable history cache and its one search
 * index. One producer page per chat per round keeps startup and live turn delivery independent of
 * backfill. Rounds run only when there is work: Core Session changes reread the changed chats by
 * identity, a native host's availability change sweeps every chat, and a chat that is backfilling,
 * streaming or backing off schedules its own next read. A periodic sweep is the safety net.
 */
export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const runtime = yield* AgentRuntimeApplication;
  const gateway = yield* CodexGateway;
  const managers = yield* CodexMainConversationManagers;
  const notifications = yield* DatabaseNotifierRuntime;
  const observedRevisions = new Map<
    string,
    { readonly revision: string; readonly retryAt?: number; readonly delay?: number }
  >();
  /** Chats with another read due: 0 for the next round, or the end of a failure backoff. */
  const followUps = new Map<string, { readonly row: ChatListingItem; readonly dueAt: number }>();
  const changedSessions = new Set<string>();
  const hostAvailability = new Map<string, string>();
  let sweepRequested = true;
  const wake = yield* Queue.sliding<void>(1);

  /** Reads at most one producer page. Null settles the chat until its revision changes. */
  const ingest = Effect.fn("NativeChatSearchIndex.ingest")(function* ({
    row,
    chat,
    binding,
    threadId,
  }: NativeTarget) {
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
    const now = yield* Clock.currentTimeMillis;
    if (
      previous?.revision === revision &&
      (previous.retryAt === undefined || now < previous.retryAt)
    )
      return previous.retryAt ?? null;
    const dueAt: number | null = yield* Effect.gen(function* () {
      const state = yield* runtime.syncNativeSearchHistory({
        kind: "admit",
        threadId,
        revision,
      });
      if (state.complete || connection === null) {
        observedRevisions.set(threadId, { revision });
        return null;
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
        return 0;
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
        return 0;
      }
      if (native.nextCursor !== null && native.nextCursor === cursor) {
        yield* runtime.syncNativeSearchHistory({ kind: "reset", threadId });
        return 0;
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
      if (!published.complete) return 0;
      observedRevisions.set(threadId, { revision });
      return null;
    }).pipe(
      Effect.catch(() =>
        Effect.gen(function* () {
          // A readable host can still lack a particular chat. Leave it partial, and retry
          // changed chats promptly without continually competing for reads of missing ones.
          const delay = Math.min(
            300_000,
            previous?.revision === revision ? (previous.delay ?? 5_000) * 2 : 5_000,
          );
          const failedAt = yield* Clock.currentTimeMillis;
          observedRevisions.set(threadId, { revision, delay, retryAt: failedAt + delay });
          return failedAt + delay;
        }),
      ),
    );
    yield* Effect.yieldNow;
    return dueAt;
  });

  /** One read per native chat, scheduling the chats that still have work. */
  const ingestRows = (rows: Iterable<ChatListingItem>, admitted?: Set<string>) => {
    const targets = new Map<string, NativeTarget>();
    for (const row of rows) {
      const target = nativeTarget(row);
      if (target) targets.set(target.threadId, target);
    }
    for (const threadId of targets.keys()) admitted?.add(threadId);
    return Effect.forEach(
      targets.values(),
      (target) =>
        ingest(target).pipe(
          Effect.map((dueAt) => {
            if (dueAt === null) followUps.delete(target.threadId);
            else followUps.set(target.threadId, { row: target.row, dueAt });
          }),
        ),
      { concurrency: 4, discard: true },
    );
  };

  const forEachPage = Effect.fnUntraced(function* (
    request: { readonly archived: boolean; readonly sessionIds?: readonly string[] },
    visit: (items: readonly ChatListingItem[]) => Effect.Effect<void>,
  ) {
    let after: string | null = null;
    const seen = new Set<string>();
    do {
      const response: Effect.Success<ReturnType<typeof core.workspace.read>> =
        yield* core.workspace.read({
          kind: "session_window",
          archived: request.archived,
          native_only: true,
          order: "identity",
          ...(request.sessionIds ? { session_ids: request.sessionIds } : {}),
          window: { first: SESSION_BATCH, ...(after ? { after } : {}) },
        });
      if (response.value.kind !== "session_window")
        return yield* Effect.fail(new Error("Core returned a non-Session window"));
      yield* visit(response.value.sessions.items);
      after = response.value.sessions.next_cursor ?? null;
      if (after && seen.has(after))
        return yield* Effect.fail(new Error("Session cursor did not advance"));
      if (after) seen.add(after);
    } while (after !== null);
  });

  const sweep = Effect.gen(function* () {
    changedSessions.clear();
    const admitted = new Set<string>();
    for (const archived of [false, true])
      yield* forEachPage({ archived }, (items) => ingestRows(items, admitted));
    yield* runtime.syncNativeSearchHistory({ kind: "prune", threadIds: [...admitted] });
    for (const key of observedRevisions.keys())
      if (!admitted.has(key)) observedRevisions.delete(key);
    for (const key of followUps.keys()) if (!admitted.has(key)) followUps.delete(key);
  });

  const refresh = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const sessionIds = [...changedSessions];
    changedSessions.clear();
    const current: ChatListingItem[] = [];
    yield* Effect.forEach(
      Array.from({ length: Math.ceil(sessionIds.length / SESSION_BATCH) }, (_, index) =>
        sessionIds.slice(index * SESSION_BATCH, (index + 1) * SESSION_BATCH),
      ),
      (batch) =>
        Effect.forEach(
          [false, true],
          (archived) =>
            forEachPage({ archived, sessionIds: batch }, (items) =>
              Effect.sync(() => current.push(...items)),
            ),
          { discard: true },
        ),
      { discard: true },
    ).pipe(
      Effect.tapCause(() =>
        Effect.sync(() => {
          for (const id of sessionIds) changedSessions.add(id);
        }),
      ),
    );
    // Core's current rows supersede retained ones. A changed chat it no longer lists natively
    // stops reading its host, and the next sweep prunes it.
    const changed = new Set(sessionIds);
    const due: ChatListingItem[] = [];
    for (const [key, { row, dueAt }] of followUps)
      if (changed.has(row.task.session.id)) followUps.delete(key);
      else if (dueAt <= now) due.push(row);
    yield* ingestRows([...due, ...current]);
  });

  const signal = Queue.offer(wake, undefined).pipe(Effect.asVoid);
  // Subscribe before the first round so no change can fall between its reads and the signal.
  yield* notifications.projectSessionInvalidations.pipe(
    Stream.runForEach((event) =>
      Effect.suspend(() => {
        const detail = event.detailInvalidation;
        if (detail.kind === "sessions") {
          if (detail.sessionIds.length === 0) return Effect.void;
          for (const id of detail.sessionIds) changedSessions.add(id);
        }
        if (detail.kind === "all" || changedSessions.size > MAX_CHANGED_SESSIONS) {
          sweepRequested = true;
          changedSessions.clear();
        }
        return signal;
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  // Revisions carry each host's connection generation. A change makes every chat on that host
  // stale, and a host that becomes ready lets chats it left partial catch up.
  yield* gateway.events.pipe(
    Stream.runForEach((event) =>
      Effect.suspend(() => {
        if (event.kind !== "connection") return Effect.void;
        const connection = event.value;
        const availability =
          connection.kind === "ready" ? `ready:${connection.generation}` : "unavailable";
        if (hostAvailability.get(connection.hostId) === availability) return Effect.void;
        hostAvailability.set(connection.hostId, availability);
        sweepRequested = true;
        return signal;
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );

  let failed = false;
  let nextSweepAt = 0;
  // The first sweep waits one round spacing, so indexing never competes with startup reads.
  let lastRoundAt = yield* Clock.currentTimeMillis;
  const nextRoundAt = () => {
    let at = sweepRequested || changedSessions.size > 0 ? 0 : nextSweepAt;
    for (const { dueAt } of followUps.values()) at = Math.min(at, dueAt);
    return Math.max(at, lastRoundAt + ROUND_SPACING_MS);
  };
  yield* Effect.gen(function* () {
    while (true) {
      const now = yield* Clock.currentTimeMillis;
      const at = nextRoundAt();
      if (at > now) {
        const woken = yield* Queue.take(wake).pipe(Effect.timeoutOption(at - now));
        if (Option.isSome(woken)) yield* Effect.sleep(SIGNAL_SETTLE);
        continue;
      }
      const full = sweepRequested || now >= nextSweepAt;
      sweepRequested = false;
      yield* (full ? sweep : refresh).pipe(
        Effect.tap(() =>
          Effect.gen(function* () {
            failed = false;
            if (full) nextSweepAt = (yield* Clock.currentTimeMillis) + SWEEP_INTERVAL_MS;
          }),
        ),
        Effect.catch((cause) => {
          if (full) sweepRequested = true;
          if (failed) return Effect.void;
          failed = true;
          return Effect.logWarning("Native chat indexing will retry", { cause });
        }),
        Effect.provideService(CoreApplicationAgent, null),
        Effect.provideService(CoreRequestClass, "background"),
      );
      lastRoundAt = yield* Clock.currentTimeMillis;
    }
  }).pipe(Effect.forkScoped({ startImmediately: true }));
});
export const live = Layer.effectDiscard(make);
