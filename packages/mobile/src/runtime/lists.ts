import {
  ChatListSchema,
  InboxWindowSchema,
  inboxScopeKey,
  type AgentCatalog,
  type ChatActivity,
  type ChatSummary,
  type InboxMessage,
  type InboxScope,
  type MobileEventData,
  type Project,
} from "@nodex/mobile-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Connection } from "./connection";
import { Outbox } from "./outbox";
import { Platform } from "./platform";
import { createProjection } from "./projection";
import type { MobileConnection } from "./connection";
import { errorMessage } from "./operations";
import type { PendingCapture } from "./outbox";
import { readStored } from "./storage";
import { disconnected, type RpcFailure } from "./rpc-client";

export type InboxRow =
  | { type: "message"; message: InboxMessage }
  | { type: "pending"; capture: PendingCapture };

type InboxFilter = "inbox" | "processed";
export type ChatListInput = { query?: string; projectId?: string | null; archived?: boolean };
type Page<Item> = { items: Item[]; nextCursor: string | null };
type ListState<Item> = { items: Item[]; loading: boolean; hasMore: boolean; error: string | null };

export function shareItems<Item>(
  previous: Item[],
  next: Item[],
  id: (item: Item) => string,
): Item[] {
  const known = new Map(previous.map((item) => [id(item), item]));
  const shared = next.map((item) => {
    const old = known.get(id(item));
    return old !== undefined && (old === item || JSON.stringify(old) === JSON.stringify(item))
      ? old
      : item;
  });
  return shared.length === previous.length &&
    shared.every((item, index) => item === previous[index])
    ? previous
    : shared;
}

/** One bounded refresh lane coalesces invalidation while retaining a read requested in flight. */
const makeReader = Effect.fnUntraced(function* (
  read: Effect.Effect<void, RpcFailure>,
  available: () => boolean,
  failed: (error: RpcFailure) => void,
) {
  const owner = yield* Scope.Scope;
  const scope = yield* Scope.fork(owner);
  const commands = yield* Queue.sliding<"refresh" | "now">(1);
  let references = 0;
  const wake = (mode: "refresh" | "now") => Queue.offer(commands, mode).pipe(Effect.asVoid);
  yield* Scope.addFinalizer(scope, Queue.shutdown(commands));
  yield* Effect.gen(function* () {
    while (true) {
      const mode = yield* Queue.take(commands);
      if (mode === "refresh") {
        yield* Effect.sleep(60);
        yield* Queue.clear(commands);
      }
      if (!references || !available()) continue;
      yield* read.pipe(Effect.catch((error) => Effect.sync(() => failed(error))));
    }
  }).pipe(Effect.forkIn(scope, { startImmediately: true }));
  return {
    watched: () => references > 0,
    refresh: Effect.suspend(() => (references ? wake("refresh") : Effect.void)),
    reconnect: Effect.suspend(() => (references ? wake("now") : Effect.void)),
    attach: Effect.gen(function* () {
      if (++references === 1) yield* wake("now");
      let attached = true;
      return Effect.sync(() => {
        if (attached) {
          attached = false;
          references--;
        }
      });
    }),
    dispose: Scope.close(scope, Exit.void),
  };
});

const makePagedList = Effect.fnUntraced(function* <Item>(options: {
  connection: MobileConnection;
  hostId: string | null;
  cached: Page<Item> | null;
  read(after: string | null): Effect.Effect<Page<Item>, RpcFailure>;
  save(page: Page<Item>): void;
  id(item: Item): string;
  project(items: Item[]): Item[];
  observe(items: Item[]): Effect.Effect<void>;
}) {
  const { connection, hostId, cached, read, save, id, project, observe } = options;
  let pages = cached ? [cached] : [];
  let source = cached?.items ?? [];
  let needsRefresh = true;
  let wantsMore = false;
  const store = createProjection<ListState<Item>>({
    items: project(source),
    loading: !!hostId && !cached,
    hasMore: !!cached?.nextCursor,
    error: null,
  });
  const reproject = Effect.sync(() => {
    const next = shareItems(store.getState().items, project(source), id);
    store.setState({ items: next });
  });
  const publish = Effect.gen(function* () {
    const items = new Map<string, Item>();
    for (const page of pages)
      for (const item of page.items) if (!items.has(id(item))) items.set(id(item), item);
    source = shareItems(source, [...items.values()], id);
    yield* reproject;
    store.setState({ hasMore: !!pages.at(-1)?.nextCursor, error: null });
    yield* observe(source);
  });
  const reader = yield* makeReader(
    Effect.gen(function* () {
      const link = connection.activeLink();
      if (!link || link.hello.host.id !== hostId) {
        store.setState({ loading: false, error: pages.length ? null : disconnected().message });
        return;
      }
      const refresh = needsRefresh;
      const more = wantsMore;
      needsRefresh = false;
      wantsMore = false;
      const cursor = pages.at(-1)?.nextCursor ?? null;
      if (!refresh && !cursor) return;
      store.setState({ loading: true, error: null });
      yield* Effect.gen(function* () {
        const next = refresh ? [yield* read(null)] : [...pages, yield* read(cursor)];
        const count = refresh ? pages.length + Number(more) : 0;
        while (next.length < count) {
          const after = next.at(-1)?.nextCursor;
          if (!after) break;
          yield* connection.assertLink(link);
          next.push(yield* read(after));
        }
        yield* connection.assertLink(link);
        pages = next;
        if (refresh && next[0]) save(next[0]);
        yield* publish;
      }).pipe(Effect.ensuring(Effect.sync(() => store.setState({ loading: false }))));
    }),
    () => !!hostId,
    (error) => store.setState({ error: errorMessage(error, "Could not refresh the list.") }),
  );
  return {
    ...reader,
    hostId,
    store,
    reproject,
    refresh: Effect.sync(() => {
      needsRefresh = true;
    }).pipe(Effect.andThen(reader.refresh)),
    reconnect: Effect.sync(() => {
      needsRefresh = true;
    }).pipe(Effect.andThen(reader.reconnect)),
    loadMore: Effect.suspend(() => {
      if (store.getState().loading || !store.getState().hasMore) return Effect.void;
      wantsMore = true;
      return reader.reconnect;
    }),
    attach: Effect.gen(function* () {
      if (!reader.watched()) {
        yield* reproject;
        yield* observe(source);
        needsRefresh = true;
      }
      return yield* reader.attach;
    }),
  };
});

export const makeLists = Effect.gen(function* () {
  const platform = yield* Platform;
  const connection = yield* Connection;
  const outbox = yield* Outbox;
  type Paged<Item> = Effect.Success<ReturnType<typeof makePagedList<Item>>>;
  const inboxLists = new Map<string, Paged<InboxMessage>>();
  const chatLists = new Map<string, Paged<ChatSummary>>();
  const activity = new Map<string, ChatActivity>();
  const cacheKeys = new Map<string, Set<string>>();
  const projects = createProjection<{
    projects: Project[];
    libraryInboxCount: number;
    loading: boolean;
  }>({ projects: [], libraryInboxCount: 0, loading: false });
  const agents = createProjection<{ catalog: AgentCatalog | null; loading: boolean }>({
    catalog: null,
    loading: false,
  });
  const projectReads = yield* makeReader(
    Effect.gen(function* () {
      const link = connection.activeLink();
      if (!link) {
        projects.setState({ loading: false });
        return;
      }
      projects.setState({ loading: true });
      yield* connection.rpc.request("projects.list", {}).pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            if (connection.activeLink() !== link) return;
            projects.setState({
              projects: shareItems(
                projects.getState().projects,
                value.projects,
                (project) => project.id,
              ),
              libraryInboxCount: value.libraryInboxCount,
            });
          }),
        ),
        Effect.ensuring(Effect.sync(() => projects.setState({ loading: false }))),
      );
    }),
    () => true,
    () => {},
  );
  const agentReads = yield* makeReader(
    Effect.gen(function* () {
      const link = connection.activeLink();
      if (!link) {
        agents.setState({ loading: false });
        return;
      }
      agents.setState({ loading: true });
      yield* connection.rpc.request("agents.catalog", {}).pipe(
        Effect.tap((catalog) =>
          Effect.sync(() => {
            if (connection.activeLink() === link)
              agents.setState({
                catalog:
                  JSON.stringify(agents.getState().catalog) === JSON.stringify(catalog)
                    ? agents.getState().catalog
                    : catalog,
              });
          }),
        ),
        Effect.ensuring(Effect.sync(() => agents.setState({ loading: false }))),
      );
    }),
    () => true,
    () => {},
  );
  function cache<Item>(
    hostId: string | null,
    key: string,
    schema: { safeParse(input: unknown): { success: true; data: Page<Item> } | { success: false } },
  ) {
    const storageKey = `nodex.mobile.list.v1:${key}`;
    const parsed = schema.safeParse(hostId ? readStored(platform.storage, storageKey, null) : null);
    return {
      cached: parsed.success ? parsed.data : null,
      save(page: Page<Item>) {
        if (!hostId) return;
        try {
          platform.storage.set(storageKey, JSON.stringify(page));
          const index = `nodex.mobile.list-keys.v1:${hostId}`;
          const known =
            cacheKeys.get(hostId) ?? new Set(readStored<string[]>(platform.storage, index, []));
          cacheKeys.set(hostId, known);
          if (!known.has(storageKey)) {
            known.add(storageKey);
            platform.storage.set(index, JSON.stringify([...known]));
          }
        } catch {
          /* An optional cache cannot invalidate an authoritative response. */
        }
      },
    };
  }
  const invalidate = Effect.fnUntraced(function* (topics: MobileEventData<"changed">["topics"]) {
    const hostId = connection.activeHostId();
    if (topics.includes("inbox"))
      for (const list of inboxLists.values()) if (list.hostId === hostId) yield* list.refresh;
    if (topics.includes("chats"))
      for (const list of chatLists.values()) if (list.hostId === hostId) yield* list.refresh;
    if (topics.includes("projects")) yield* projectReads.refresh;
    if (topics.includes("agents")) yield* agentReads.refresh;
  });
  yield* connection.rpc.events("changed").pipe(
    Stream.runForEach(({ topics }) => invalidate(topics)),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* outbox.delivered.pipe(
    Stream.runForEach(() => invalidate(["inbox", "projects"])),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* connection.rpc.events("chat.activity").pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        activity.set(event.sessionId, event);
        for (const list of chatLists.values())
          if (list.watched() && list.hostId === connection.activeHostId()) yield* list.reproject;
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  yield* connection.state.changes.pipe(
    Stream.runForEach(({ status }) =>
      Effect.gen(function* () {
        if (status !== "connected") {
          if (activity.size) {
            activity.clear();
            for (const list of chatLists.values()) yield* list.reproject;
          }
          return;
        }
        const hostId = connection.activeHostId();
        for (const list of [...inboxLists.values(), ...chatLists.values()])
          if (list.hostId === hostId) yield* list.reconnect;
        yield* projectReads.reconnect;
        yield* agentReads.reconnect;
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  let previousHostId = connection.activeHostId();
  yield* connection.hosts.changes.pipe(
    Stream.runForEach(({ activeHostId }) =>
      Effect.gen(function* () {
        if (previousHostId === activeHostId) return;
        previousHostId = activeHostId;
        projects.setState({
          projects: [],
          libraryInboxCount: 0,
          loading: !!activeHostId && projectReads.watched(),
        });
        agents.setState({ catalog: null, loading: !!activeHostId && agentReads.watched() });
        for (const [key, list] of [...inboxLists, ...chatLists]) {
          if (list.hostId === activeHostId) continue;
          yield* list.dispose;
          inboxLists.delete(key);
          chatLists.delete(key);
        }
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  return {
    projects,
    agents,
    projectReads,
    agentReads,
    invalidate,
    inbox: Effect.fnUntraced(function* (
      hostId: string | null,
      scope: InboxScope,
      filter: InboxFilter,
    ) {
      const key = JSON.stringify(["inbox", hostId, inboxScopeKey(scope), filter]);
      const existing = inboxLists.get(key);
      if (existing) return existing;
      const list = yield* makePagedList({
        connection,
        hostId,
        ...cache(hostId, key, InboxWindowSchema),
        read: (after) => connection.rpc.request("inbox.window", { scope, filter, after }),
        id: (message) => message.pageId,
        project: (items) => [...items].reverse(),
        observe: (items) =>
          hostId
            ? outbox.observeWindow(hostId, new Set(items.map((item) => item.pageId)))
            : Effect.void,
      });
      inboxLists.set(key, list);
      return list;
    }),
    chats: Effect.fnUntraced(function* (
      hostId: string | null,
      { query, projectId, archived }: ChatListInput,
    ) {
      const key = JSON.stringify([
        "chats",
        hostId,
        query || "",
        projectId === undefined ? [] : projectId,
        !!archived,
      ]);
      const existing = chatLists.get(key);
      if (existing) return existing;
      const includedActivity = new Map<string, ChatActivity>();
      const list = yield* makePagedList({
        connection,
        hostId,
        ...cache(hostId, key, ChatListSchema),
        read: Effect.fnUntraced(function* (after: string | null) {
          const before = new Map(activity);
          const page = yield* connection.rpc.request("chats.list", {
            query,
            projectId,
            archived,
            after,
          });
          for (const item of page.items) {
            const superseded = before.get(item.sessionId);
            if (superseded) includedActivity.set(item.sessionId, superseded);
            else includedActivity.delete(item.sessionId);
          }
          return page;
        }),
        id: (chat) => chat.sessionId,
        project: (items) =>
          items.map((item) => {
            const latest = activity.get(item.sessionId);
            return hostId === connection.activeHostId() &&
              latest &&
              includedActivity.get(item.sessionId) !== latest
              ? {
                  ...item,
                  status: latest.status,
                  pendingRequestCount: latest.pendingRequestCount,
                  attention: latest.attention,
                }
              : item;
          }),
        observe: () => Effect.void,
      });
      chatLists.set(key, list);
      return list;
    }),
    forgetHost: (hostId: string) =>
      Effect.sync(() => {
        const index = `nodex.mobile.list-keys.v1:${hostId}`;
        for (const key of readStored<string[]>(platform.storage, index, []))
          platform.storage.remove(key);
        platform.storage.remove(index);
        cacheKeys.delete(hostId);
      }),
  };
});
export type MobileLists = Effect.Success<typeof makeLists>;
export class Lists extends Context.Service<Lists, MobileLists>()("nodex/mobile/Lists") {}
