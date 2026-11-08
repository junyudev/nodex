import type { AgentSnapshot } from "@nodex/agent-runtime/contracts";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import {
  CHANNEL_MAX_MESSAGE_BYTES,
  type ChatItem,
  type ChatSnapshot,
} from "@nodex/mobile-protocol";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { ProjectSession } from "../../shared/types";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { AgentRuntimeSessionActivity } from "../agent-runtime/AgentRuntimeSessionActivity";
import { makeSessionObservation } from "../agent-runtime/AgentRuntimeSessionObservation";
import { makeNativeSessionHistory } from "../app-tools/NativeSessionHistory";
import type { SessionSourceContent } from "../app-tools/SessionHistoryRead";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import { UserPresence } from "../host-runtime/UserPresence";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import type { makeMobileChatCommands } from "./chat-commands";
import {
  invalid,
  missing,
  rpcError,
  unavailable,
  type MobileHandlers,
  type PushMobileEvent,
} from "./rpc";
import {
  WINDOW_ITEMS,
  chatItemId,
  chatPatch,
  nativeActivity,
  parseChatItemId,
  projectNativeItem,
  projectRequests,
  projectRuntimeItem,
  transcriptWindow,
} from "./transcript-projection";

const MAX_OPEN_CHATS = 8;
const NATIVE_WINDOW_ITEMS = 32;
const NATIVE_ITEM_PREVIEW_CHARS = 128 * 1024;
const transcriptUnavailable = () => unavailable("This transcript is temporarily unavailable.");
const itemMissing = () => missing("This chat item is unavailable.");
const itemTooLarge = () => rpcError("rejected", "This item is too large to open on the phone.");
const nativeOnly = "Continue this chat on your desktop.";

type Read = {
  readonly value: ChatSnapshot;
  readonly sequence: number | null;
  readonly historyRevision: number | null;
};

const projectQueued = (projection: AgentSnapshot["projection"]) =>
  new Set(
    projection.runs
      .filter((run) => run.status === "queued" || run.queuePosition != null)
      .map((run) => run.userMessageId),
  );

const nativeItem = (content: SessionSourceContent): ChatItem => {
  const { itemId, sourceThreadId, runId, updatedAt } = content.reference;
  if (content.nextTextOffset === null) {
    return projectNativeItem(sourceThreadId, runId, JSON.parse(content.text) as ThreadItem);
  }
  return {
    kind: "notice",
    id: chatItemId(sourceThreadId, itemId, runId),
    at: updatedAt ?? new Date(0).toISOString(),
    tone: "info",
    text: "Open this item to view its content.",
  };
};

export const makeMobileTranscript = Effect.fn("MobileTranscript.make")(function* (
  chats: Pick<Effect.Success<ReturnType<typeof makeMobileChatCommands>>, "session">,
) {
  const runtime = yield* AgentRuntimeApplication;
  const activity = yield* AgentRuntimeSessionActivity;
  const observe = yield* makeSessionObservation;
  const resolveNative = yield* makeNativeSessionHistory;
  const database = yield* DatabaseNotifierRuntime;
  const projects = yield* ProjectWorkspace;
  const presence = yield* UserPresence;

  const nativeWindow = (row: ProjectSession, cursor?: string) =>
    Effect.gen(function* () {
      if (!row.thread || row.thread.backendBinding.kind !== "codex")
        return { items: [], historyCursor: null };
      const { source } = yield* resolveNative(row.thread.threadId, row.thread.executionHostId).pipe(
        Effect.mapError(transcriptUnavailable),
      );
      const page = yield* source
        .page({
          ...(cursor === undefined ? {} : { cursor }),
          view: "activity",
          order: "newest_first",
          limit: NATIVE_WINDOW_ITEMS,
          maxCharsPerItem: NATIVE_ITEM_PREVIEW_CHARS,
        })
        .pipe(
          Effect.mapError((error) =>
            error.reason === "invalid_cursor"
              ? invalid("The transcript cursor is invalid.")
              : transcriptUnavailable(),
          ),
        );
      const rows = page.items.flatMap(({ after, initialContent }) =>
        after && initialContent ? [{ cursor: after, item: nativeItem(initialContent) }] : [],
      );
      return transcriptWindow(rows, page.nextCursor !== null);
    });

  const snapshot = Effect.fn("MobileTranscript.snapshot")(function* (
    row: ProjectSession,
    projectName: string | null,
  ) {
    const sessionId = row.id;
    if (!row.executionRef) {
      const thread = row.thread;
      return {
        value: {
          sessionId,
          revision: 0,
          projectName,
          title: row.displayTitle,
          state: {
            status: thread
              ? nativeActivity(sessionId, thread.statusType, thread.statusActiveFlags).status
              : "idle",
            activeRunId: null,
            queuedCount: 0,
            requests: [],
            agentLabel: thread ? "Codex" : null,
            sendBlockedReason: nativeOnly,
          },
          ...(yield* nativeWindow(row)),
        },
        sequence: null,
        historyRevision: null,
      } satisfies Read;
    }
    const { snapshot } = yield* runtime
      .read({ sessionId })
      .pipe(Effect.mapError(transcriptUnavailable));
    const projection = snapshot.projection;
    const current = (yield* activity.read).items.find((entry) => entry.sessionId === sessionId);
    const requests = projectRequests(projection);
    const queued = projectQueued(projection);
    const activeRunId =
      current?.activeRunId ??
      projection.runs.find(
        (run) =>
          run.queuePosition == null &&
          ["running", "waiting", "preparing", "starting"].includes(run.status),
      )?.id ??
      null;
    const active = projection.runs.find((run) => run.id === activeRunId);
    const newest = [...projection.visibleTurnItems]
      .reverse()
      .flatMap(({ item, sourceItemId, sourceThreadId }) => {
        const projected = projectRuntimeItem(sessionId, item, sourceThreadId, sourceItemId, {
          queued: item.type === "user_message" && queued.has(item.messageId),
          activeRunId,
        });
        return projected
          ? [{ item: projected, cursor: chatItemId(sourceThreadId, sourceItemId) }]
          : [];
      });
    return {
      value: {
        sessionId,
        revision: 0,
        projectName,
        title: row.displayTitle,
        state: {
          status:
            requests.length ||
            (current?.pendingRequestCount ?? 0) > 0 ||
            active?.status === "waiting"
              ? "waiting"
              : (current?.status ?? (activeRunId ? "running" : "idle")),
          activeRunId,
          queuedCount: queued.size,
          requests,
          agentLabel: projection.thread.modelSelection?.model ?? null,
          sendBlockedReason: row.archived ? "Restore this chat to continue it." : null,
        },
        ...transcriptWindow(newest, snapshot.hasMoreHistory === true),
      },
      sequence: snapshot.snapshotSequence,
      historyRevision: projection.thread.historyRevision ?? 0,
    } satisfies Read;
  });

  const history: MobileHandlers["chat.history"] = ({ sessionId, cursor }) =>
    Effect.gen(function* () {
      if (cursor.length > 12000)
        return yield* Effect.fail(invalid("The transcript cursor is invalid."));
      const row = yield* chats.session(sessionId);
      if (!row.executionRef) return yield* nativeWindow(row, cursor);
      const anchor = parseChatItemId(cursor);
      if (!anchor || anchor[2] !== null)
        return yield* Effect.fail(invalid("The transcript cursor is invalid."));
      const [sourceThreadId, sourceItemId] = anchor;
      const page = yield* runtime
        .timeline({
          sessionId,
          beforeItem: { sourceThreadId, sourceItemId },
          order: "newest_first",
          view: "activity",
          limit: WINDOW_ITEMS,
        })
        .pipe(Effect.mapError(transcriptUnavailable));
      if (!page.anchorFound)
        return yield* Effect.fail(
          rpcError("conflict", "Open the chat again to refresh its history."),
        );
      const rows = yield* Effect.forEach(
        page.items,
        (row) =>
          runtime
            .item({
              sessionId,
              itemId: row.sourceItemId,
              sourceThreadId: row.sourceThreadId,
            })
            .pipe(
              Effect.mapError(transcriptUnavailable),
              Effect.map((found) => {
                const item =
                  found &&
                  projectRuntimeItem(sessionId, found, row.sourceThreadId, row.sourceItemId);
                return item
                  ? { item, cursor: chatItemId(row.sourceThreadId, row.sourceItemId) }
                  : null;
              }),
            ),
        { concurrency: 3 },
      );
      return transcriptWindow(
        rows.filter((row) => row !== null),
        page.hasMore,
      );
    });

  const item: MobileHandlers["chat.item"] = ({ sessionId, itemId }) =>
    Effect.gen(function* () {
      const identity = parseChatItemId(itemId);
      if (!identity) return yield* Effect.fail(itemMissing());
      const row = yield* chats.session(sessionId);
      const [sourceThreadId, sourceItemId, runId] = identity;
      const selected = yield* Effect.gen(function* () {
        if (row.executionRef) {
          if (runId !== null) return yield* Effect.fail(itemMissing());
          const found = yield* runtime
            .item({ sessionId, sourceThreadId, itemId: sourceItemId, full: true })
            .pipe(Effect.mapError(itemMissing));
          if (!found) return yield* Effect.fail(itemMissing());
          const projected = projectRuntimeItem(sessionId, found, sourceThreadId, sourceItemId);
          if (!projected) return yield* Effect.fail(itemMissing());
          return projected;
        }
        if (
          !runId ||
          !row.thread ||
          row.thread.threadId !== sourceThreadId ||
          row.thread.backendBinding.kind !== "codex"
        )
          return yield* Effect.fail(itemMissing());
        const native = yield* resolveNative(sourceThreadId, row.thread.executionHostId).pipe(
          Effect.mapError(itemMissing),
        );
        const { entry } = yield* native
          .readItem({
            itemId: sourceItemId,
            sourceThreadId,
            runId,
          })
          .pipe(Effect.mapError(itemMissing));
        return projectNativeItem(sourceThreadId, runId, entry.item);
      });
      if (Buffer.byteLength(JSON.stringify(selected)) > CHANNEL_MAX_MESSAGE_BYTES - 256)
        return yield* Effect.fail(itemTooLarge());
      return selected;
    });

  return (push: PushMobileEvent) =>
    Effect.gen(function* () {
      const owner = yield* Scope.Scope;
      const lane = yield* Semaphore.make(1);
      type Watched = { scope: Scope.Closeable; current: Read };
      const watching = new Map<string, Watched>();
      // A chat opened again must supersede any events still queued from its previous watch.
      let highestRevision = -1;

      const close = (sessionId: string) =>
        Effect.gen(function* () {
          const existing = watching.get(sessionId);
          if (!existing) return;
          watching.delete(sessionId);
          yield* Scope.close(existing.scope, Exit.void);
        });

      // Reads what the chat needs, and resolves to the step that starts watching it. The gateway
      // runs that step and the answer with nothing sent in between; the read itself holds nothing.
      const open: MobileHandlers["chat.open"] = ({ sessionId }) =>
        Effect.gen(function* () {
          const existing = watching.get(sessionId);
          if (existing) return Effect.sync(() => existing.current.value);
          if (watching.size >= MAX_OPEN_CHATS)
            return yield* Effect.fail(unavailable("Close an open chat before opening another."));
          const row = yield* chats.session(sessionId);
          const projectName = row.projectId
            ? ((yield* projects
                .getProject(row.projectId)
                .pipe(Effect.mapError(transcriptUnavailable)))?.name ?? null)
            : null;
          const loaded = yield* snapshot(row, projectName);
          return Effect.gen(function* () {
            const scope = yield* Scope.fork(owner);
            const current: Read = {
              ...loaded,
              value: { ...loaded.value, revision: ++highestRevision },
            };
            const reads = yield* Semaphore.make(1);
            const watched: Watched = { scope, current };
            watching.set(sessionId, watched);
            // A chat the phone watches over a live channel is in front of the person.
            yield* presence
              .showOnPhone({
                sessionId,
                conversationId: row.executionRef?.threadId ?? row.thread?.threadId ?? null,
                hostId: row.thread?.executionHostId,
              })
              .pipe(Scope.provide(scope));
            const applyRefresh = (next: Read, reset: boolean) =>
              lane.withPermit(
                Effect.gen(function* () {
                  if (watching.get(sessionId) !== watched) return;
                  const previous = watched.current;
                  const replace =
                    reset ||
                    previous.historyRevision !== next.historyRevision ||
                    (previous.sequence !== null &&
                      next.sequence !== null &&
                      previous.sequence > next.sequence);
                  const ops = replace ? [] : chatPatch(previous.value, next.value);
                  const revision = previous.value.revision + (ops.length > 0 ? 1 : 0);
                  watched.current = { ...next, value: { ...next.value, revision } };
                  if (replace) yield* push("chat.snapshot", watched.current.value);
                  else if (ops.length > 0) {
                    highestRevision = Math.max(highestRevision, revision);
                    yield* push("chat.patch", { sessionId, revision, ops });
                  }
                }),
              );
            // A chat serializes its reads; only applying and publishing joins channel recovery.
            const refresh = (reset: boolean) =>
              reads
                .withPermit(
                  Effect.gen(function* () {
                    if (watching.get(sessionId) !== watched) return;
                    const session = yield* chats.session(sessionId);
                    const next = yield* snapshot(session, projectName);
                    yield* applyRefresh(next, reset);
                  }),
                )
                .pipe(Effect.ignore);
            const coreChanges = database.projectSessionInvalidations.pipe(
              Stream.filter(
                ({ detailInvalidation }) =>
                  detailInvalidation.kind === "all" ||
                  detailInvalidation.sessionIds.includes(sessionId),
              ),
              Stream.groupedWithin(64, "80 millis"),
              Stream.runForEach(() => refresh(!row.executionRef)),
            );
            yield* Effect.forkIn(coreChanges, scope, { startImmediately: true });
            // The Run's last event can arrive before its activity settles, so the end of a Run
            // reaches this chat through activity, not through the transcript.
            const activityChanges = activity.activityChanges.pipe(
              Stream.filter(
                (change) =>
                  change.type === "reset" ||
                  (change.type === "upsert" ? change.activity.sessionId : change.sessionId) ===
                    sessionId,
              ),
              Stream.groupedWithin(16, "80 millis"),
              Stream.runForEach(() => refresh(false)),
            );
            if (row.executionRef)
              yield* Effect.forkIn(activityChanges, scope, { startImmediately: true });
            if (current.sequence !== null) {
              const live = Effect.forever(
                Effect.gen(function* () {
                  const after = watched.current.sequence;
                  if (after === null) return yield* Effect.never;
                  yield* observe(sessionId, after).pipe(
                    Stream.groupedWithin(128, "80 millis"),
                    Stream.runForEach((signals) =>
                      refresh(signals.some((signal) => signal.kind === "reset")),
                    ),
                    Effect.ignore,
                  );
                  yield* Effect.sleep("500 millis");
                  yield* refresh(true);
                }),
              );
              yield* Effect.forkIn(live, scope, { startImmediately: true });
            }
            return current.value;
          });
        });

      return {
        handlers: {
          "chat.open": open,
          "chat.close": ({ sessionId }) => close(sessionId).pipe(Effect.as({})),
          "chat.history": history,
          "chat.item": item,
        } satisfies Pick<MobileHandlers, "chat.open" | "chat.close" | "chat.history" | "chat.item">,
        recover: (push: PushMobileEvent, discard: Effect.Effect<void>) =>
          lane.withPermits(1)(
            discard.pipe(
              Effect.andThen(
                Effect.forEach(
                  watching.values(),
                  ({ current }) => push("chat.snapshot", current.value),
                  { discard: true },
                ),
              ),
            ),
          ),
      };
    });
});
