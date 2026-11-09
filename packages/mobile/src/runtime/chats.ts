import type { ChatItem, ChatPatchOp, ChatResponse, ChatSnapshot } from "@nodex/mobile-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as RcMap from "effect/RcMap";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Connection } from "./connection";
import { Files } from "./files";
import { Lists } from "./lists";
import { Platform } from "./platform";
import { createProjection } from "./projection";
import type { ConnectionLink } from "./connection";
import { shareItems } from "./lists";
import { errorMessage, mintId, retryOperation } from "./operations";
import type { LocalImage } from "./platform";
import { disconnected, RpcFailure } from "./rpc-client";

type ChatView = {
  chat: ChatSnapshot | null;
  loading: boolean;
  error: string | null;
  hasOlder: boolean;
  loadingOlder: boolean;
};

export function applyChatPatch(
  chat: ChatSnapshot,
  ops: readonly ChatPatchOp[],
): ChatSnapshot | null {
  let next = chat;
  for (const op of ops) {
    switch (op.op) {
      case "upsert": {
        const index = next.items.findIndex((item) => item.id === op.item.id);
        if (index < 0) {
          next = { ...next, items: [...next.items, op.item] };
        } else if (JSON.stringify(next.items[index]) !== JSON.stringify(op.item)) {
          const items = next.items.slice();
          items[index] = op.item;
          next = { ...next, items };
        }
        break;
      }
      case "append": {
        const index = next.items.findIndex((item) => item.id === op.itemId);
        const item = next.items[index];
        if (
          (item?.kind !== "assistant" && item?.kind !== "thinking") ||
          item.text.length !== op.offset
        ) {
          return null;
        }
        if (!op.text) break;
        const items = next.items.slice();
        items[index] = { ...item, text: item.text + op.text };
        next = { ...next, items };
        break;
      }
      case "remove": {
        const items = next.items.filter((item) => item.id !== op.itemId);
        if (items.length !== next.items.length) next = { ...next, items };
        break;
      }
      case "state":
        next = { ...next, state: op.state };
        break;
      case "title":
        if (next.title !== op.title) next = { ...next, title: op.title };
        break;
    }
  }
  return next;
}

export const makeChats = Effect.gen(function* () {
  const platform = yield* Platform;
  const connection = yield* Connection;
  const files = yield* Files;
  const lists = yield* Lists;
  const owner = yield* Scope.Scope;
  type Session = Effect.Success<ReturnType<typeof makeSession>>;
  const sessions = new Map<string, Session & { attach: Effect.Effect<Effect.Effect<void>> }>();
  const keyFor = (hostId: string | null, sessionId: string) => JSON.stringify([hostId, sessionId]);
  const markRead = Effect.fnUntraced(function* (hostId: string | null, sessionId: string) {
    const link = connection.activeLink();
    if (!link || link.hello.host.id !== hostId) return;
    yield* connection.rpc.request("chat.markRead", { sessionId }).pipe(
      Effect.tap(() =>
        connection.activeLink() === link ? lists.invalidate(["chats"]) : Effect.void,
      ),
      Effect.ignore,
    );
  });
  const makeSession = Effect.fnUntraced(function* (hostId: string | null, sessionId: string) {
    const scope = yield* Scope.fork(owner);
    const tasks = yield* FiberMap.make<string>().pipe(Scope.provide(scope));
    const store = createProjection<ChatView>({
      chat: null,
      loading: !!hostId,
      error: null,
      hasOlder: false,
      loadingOlder: false,
    });
    const submissions = new Map<string, string>();
    let current: ChatSnapshot | null = null;
    let snapshotLink: ConnectionLink | null = null;
    let subscribed: ConnectionLink | null = null;
    let readOn: ConnectionLink | null = null;
    let live = false;
    let disposed = false;
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        disposed = true;
      }),
    );
    let opening = false;
    let transcriptGeneration = 0;
    type Patch = { revision: number; ops: ChatPatchOp[] };
    type Event = { snapshot: ChatSnapshot } | Patch;
    let duringOpen: Event[] = [];
    let newestDuringOpen = -1;
    let overflow = false;
    const eventRevision = (event: Event) =>
      "snapshot" in event ? event.snapshot.revision : event.revision;
    const isStaleSnapshot = (snapshot: ChatSnapshot) =>
      snapshotLink === connection.activeLink() &&
      current !== null &&
      snapshot.revision < current.revision;
    function setSnapshot(snapshot: ChatSnapshot) {
      const link = connection.activeLink();
      // Host revisions belong to one channel, including snapshots queued behind an open response.
      if (isStaleSnapshot(snapshot)) return;
      snapshotLink = link;
      transcriptGeneration++;
      const items = shareItems(current?.items ?? [], snapshot.items, (item) => item.id);
      current =
        current && JSON.stringify(current) === JSON.stringify(snapshot)
          ? current
          : { ...snapshot, items };
    }
    function applyPatch({ revision, ops }: Patch) {
      if (!current || revision > current.revision + 1) return false;
      if (revision <= current.revision) return true;
      const patched = applyChatPatch(current, ops);
      if (!patched) return false;
      current = { ...patched, revision };
      return true;
    }
    const flush = Effect.gen(function* () {
      yield* FiberMap.remove(tasks, "flush");
      store.setState({ chat: current, hasOlder: !!current?.historyCursor });
    });
    const close = Effect.gen(function* () {
      transcriptGeneration++;
      yield* FiberMap.remove(tasks, "open");
      opening = false;
      duringOpen = [];
      const link = subscribed;
      subscribed = null;
      readOn = null;
      if (link && connection.activeLink() === link)
        yield* FiberMap.run(
          tasks,
          "close",
          connection.rpc.request("chat.close", { sessionId }).pipe(Effect.ignore),
          { startImmediately: true },
        );
    });
    const openAttempt = Effect.gen(function* () {
      if (!live) return;
      const link = connection.activeLink();
      if (!link || link.hello.host.id !== hostId) {
        store.setState({ loading: false, error: current ? null : disconnected().message });
        return;
      }
      transcriptGeneration++;
      subscribed = link;
      opening = true;
      duringOpen = [];
      newestDuringOpen = -1;
      overflow = false;
      store.setState({ loading: !current, error: null });
      yield* Effect.gen(function* () {
        const snapshot = yield* connection.rpc.request("chat.open", { sessionId });
        yield* connection.assertLink(link);
        opening = false;
        if (snapshot.sessionId !== sessionId) {
          store.setState({ loading: false, error: "Your desktop returned a different chat." });
          return;
        }
        setSnapshot(snapshot);
        const events = duringOpen;
        duringOpen = [];
        if (overflow)
          return yield* Effect.fail(
            new RpcFailure("conflict", "This chat needs to be refreshed.", true),
          );
        for (const event of events) {
          if ("snapshot" in event) {
            setSnapshot(event.snapshot);
            continue;
          }
          if (!applyPatch(event))
            return yield* Effect.fail(
              new RpcFailure("conflict", "This chat needs to be refreshed.", true),
            );
        }
        yield* flush;
        store.setState({ loading: false, error: null });
        if (readOn !== link) {
          readOn = link;
          yield* markRead(hostId, sessionId).pipe(Effect.forkIn(scope, { startImmediately: true }));
        }
      }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (connection.activeLink() === link)
              store.setState({
                loading: false,
                error: errorMessage(error, "This chat could not be opened."),
              });
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            opening = false;
          }),
        ),
      );
    });
    const open = FiberMap.run(
      tasks,
      "open",
      openAttempt.pipe(
        Effect.retry({
          while: (error) => error.retryable && live,
          schedule: Schedule.spaced(1_000).pipe(
            Schedule.setInputType<RpcFailure>(),
            Schedule.modifyDelay(({ input }) =>
              Effect.succeed(input.code === "conflict" ? 0 : 1_000),
            ),
          ),
        }),
        Effect.ignore,
      ),
      { startImmediately: true },
    ).pipe(Effect.asVoid);
    const accept = Effect.fnUntraced(function* (event: Event) {
      if (!live || !subscribed || subscribed !== connection.activeLink()) return;
      if ("snapshot" in event && isStaleSnapshot(event.snapshot)) return;
      if (opening) {
        newestDuringOpen = Math.max(newestDuringOpen, eventRevision(event));
        if ("snapshot" in event) {
          if (
            duringOpen.some(
              (queued) =>
                "snapshot" in queued && queued.snapshot.revision > event.snapshot.revision,
            )
          )
            return;
          const newer = duringOpen.filter(
            (queued) => eventRevision(queued) > event.snapshot.revision,
          );
          overflow =
            (overflow && event.snapshot.revision < newestDuringOpen) || newer.length >= 128;
          duringOpen = [event, ...newer.slice(0, 127)];
        } else if (duringOpen.length < 128) duringOpen.push(event);
        else overflow = true;
        return;
      }
      if ("snapshot" in event) {
        setSnapshot(event.snapshot);
        yield* flush;
        store.setState({ loading: false, error: null });
        return;
      }
      const before = current;
      if (!applyPatch(event)) {
        yield* open;
        return;
      }
      if (current === before) return;
      yield* FiberMap.run(
        tasks,
        "flush",
        Effect.sleep(60).pipe(
          Effect.andThen(
            Effect.sync(() =>
              store.setState({ chat: current, hasOlder: !!current?.historyCursor }),
            ),
          ),
        ),
        { onlyIfMissing: true, startImmediately: true },
      );
    });
    const assertHost = Effect.suspend(() =>
      hostId && connection.activeHostId() === hostId && !disposed
        ? Effect.void
        : Effect.fail(disconnected()),
    );
    const retain = Effect.acquireRelease(
      Effect.gen(function* () {
        live = true;
        yield* open;
      }),
      () =>
        Effect.gen(function* () {
          live = false;
          // A retained view can outlive the Session's Scope during application shutdown.
          if (disposed) return;
          yield* close;
          yield* flush;
        }),
    );
    return {
      hostId,
      store,
      accept,
      retain,
      reconnect: close.pipe(Effect.andThen(Effect.suspend(() => (live ? open : Effect.void)))),
      disconnect: close.pipe(
        Effect.andThen(flush),
        Effect.andThen(Effect.sync(() => store.setState({ loading: false }))),
      ),
      loadOlder: Effect.suspend(() => {
        const cursor = current?.historyCursor;
        const link = connection.activeLink();
        if (!cursor || !link || link !== subscribed || opening) return Effect.void;
        const generation = transcriptGeneration;
        return FiberMap.run(
          tasks,
          "history",
          Effect.gen(function* () {
            store.setState({ loadingOlder: true });
            yield* connection.rpc.request("chat.history", { sessionId, cursor }).pipe(
              Effect.tap(({ items, historyCursor }) =>
                Effect.sync(() => {
                  if (
                    !current ||
                    generation !== transcriptGeneration ||
                    link !== connection.activeLink()
                  )
                    return;
                  const known = new Set(current.items.map((item) => item.id));
                  const older: ChatItem[] = [];
                  for (const item of items) {
                    if (known.has(item.id)) continue;
                    known.add(item.id);
                    older.push(item);
                  }
                  current = {
                    ...current,
                    items: older.length ? [...older, ...current.items] : current.items,
                    historyCursor: historyCursor === cursor ? null : historyCursor,
                  };
                }),
              ),
              Effect.andThen(flush),
              Effect.catch((error) => {
                if (generation !== transcriptGeneration || link !== connection.activeLink())
                  return Effect.void;
                if (error.code === "conflict") return open;
                return Effect.sync(() =>
                  store.setState({
                    error: errorMessage(error, "Could not load earlier messages."),
                  }),
                );
              }),
              Effect.ensuring(Effect.sync(() => store.setState({ loadingOlder: false }))),
            );
          }),
          { onlyIfMissing: true, startImmediately: true },
        ).pipe(Effect.asVoid);
      }),
      send: Effect.fnUntraced(function* (
        text: string,
        images: LocalImage[],
        delivery: "queue" | "steer",
      ) {
        yield* assertHost;
        const messageId = mintId(platform);
        yield* files.withImageUploads(images, (fileRefs) =>
          assertHost.pipe(
            Effect.andThen(
              connection.rpc.request("chat.send", {
                sessionId,
                messageId,
                text,
                fileRefs,
                delivery,
              }),
            ),
          ),
        );
      }),
      stop: Effect.gen(function* () {
        yield* assertHost;
        yield* connection.requireLink;
        const runId = current?.state.activeRunId;
        if (runId)
          yield* retryOperation(connection, () =>
            connection.rpc.request("chat.stop", { sessionId, runId }),
          );
      }),
      respond: Effect.fnUntraced(function* (
        requestId: string,
        runId: string | null,
        response: ChatResponse,
      ) {
        yield* assertHost;
        const answer =
          response.kind === "answers"
            ? Object.entries(response.answers).sort(([left], [right]) => left.localeCompare(right))
            : [response.optionId, response.feedback];
        const key = JSON.stringify([requestId, runId, response.kind, answer]);
        const submissionId = submissions.get(key) ?? mintId(platform);
        submissions.set(key, submissionId);
        yield* retryOperation(connection, () =>
          connection.rpc.request("chat.respond", {
            sessionId,
            requestId,
            runId,
            submissionId,
            response,
          }),
        );
      }),
      dispose: Scope.close(scope, Exit.void),
    };
  });
  const retained = yield* RcMap.make({
    lookup: (key: string) =>
      Effect.suspend(() => {
        const session = sessions.get(key);
        return session ? session.retain : Effect.void;
      }),
    idleTimeToLive: 750,
  });
  yield* connection.rpc.notifications.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        if (event.event === "chat.patch") {
          const { sessionId, revision, ops } = event.data;
          yield* (
            sessions.get(keyFor(connection.activeHostId(), sessionId))?.accept({ revision, ops }) ??
              Effect.void
          );
        } else if (event.event === "chat.snapshot") {
          yield* (
            sessions
              .get(keyFor(connection.activeHostId(), event.data.sessionId))
              ?.accept({ snapshot: event.data }) ?? Effect.void
          );
        }
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* connection.state.changes.pipe(
    Stream.runForEach(({ status }) =>
      Effect.gen(function* () {
        for (const session of sessions.values()) {
          if (session.hostId !== connection.activeHostId()) continue;
          yield* status === "connected" ? session.reconnect : session.disconnect;
        }
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  let previousHost = connection.activeHostId();
  yield* connection.hosts.changes.pipe(
    Stream.runForEach(({ activeHostId }) =>
      Effect.gen(function* () {
        if (activeHostId === previousHost) return;
        previousHost = activeHostId;
        for (const [key, session] of sessions) {
          if (session.hostId === activeHostId) continue;
          yield* RcMap.invalidate(retained, key);
          yield* session.dispose;
          sessions.delete(key);
        }
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  return {
    get: Effect.fnUntraced(function* (hostId: string | null, sessionId: string) {
      const key = keyFor(hostId, sessionId);
      const existing = sessions.get(key);
      if (existing) return existing;
      const session = yield* makeSession(hostId, sessionId);
      const resource = {
        ...session,
        attach: Effect.gen(function* () {
          const reference = yield* Scope.fork(owner);
          yield* RcMap.get(retained, key).pipe(Scope.provide(reference));
          return Scope.close(reference, Exit.void);
        }),
      };
      sessions.set(key, resource);
      return resource;
    }),
    markChatRead: (sessionId: string) => markRead(connection.activeHostId(), sessionId),
  };
});
export class Chats extends Context.Service<Chats, Effect.Success<typeof makeChats>>()(
  "nodex/mobile/Chats",
) {}
