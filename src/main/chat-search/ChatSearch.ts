import * as Queue from "effect/Queue";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type * as Cause from "effect/Cause";
import * as Stream from "effect/Stream";
import { z } from "zod";
import {
  CHAT_SEARCH_MAX_LIMIT,
  CHAT_SEARCH_QUERY_MAX_CHARS,
  type ChatSearchInput,
  type ChatSearchResult,
  type ChatMessageSearchResult,
} from "../../shared/chat-search";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import { AgentRuntimeSessionActivity } from "../agent-runtime/AgentRuntimeSessionActivity";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CoreModules } from "../core-runtime/CoreModules";
import { HostInvocation } from "../../host/HostInvocation";
import {
  CHAT_CATALOG_MAX_ENTRIES,
  MEMBER_CHAT_CATALOG_MAX_ENTRIES,
  projectChat,
  type ChatCatalogItem,
  type ChatListingItem,
  type ChatRuntimeMetadata,
} from "./ChatCatalogProjection";
import {
  ChatSearchEngine,
  type ChatMessageSearchInput,
  type ChatSearchCatalog,
} from "./ChatSearchEngine";
import * as ChatSearchWorker from "./ChatSearchWorker";

interface ChatCatalog {
  readonly entries: readonly ChatCatalogItem[];
  readonly complete: boolean;
  readonly prepared?: true;
}
const combineCatalogs = ([active, archive]: [ChatCatalog, ChatCatalog]): ChatCatalog => ({
  entries: [
    ...new Map(
      [...archive.entries, ...active.entries].map((chat) => [chat.sessionId, chat]),
    ).values(),
  ],
  complete: active.complete && archive.complete,
});

export class ChatSearchError extends Data.TaggedError("ChatSearchError")<{
  readonly operation: "catalog" | "search" | "search-messages";
  readonly reason: "invalid_input" | "unavailable";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const ChatSearchInputSchema = z.strictObject({
  query: z
    .string()
    .trim()
    .refine((query) => Array.from(query).length <= CHAT_SEARCH_QUERY_MAX_CHARS),
  limit: z.number().int().min(1).max(CHAT_SEARCH_MAX_LIMIT),
  startedOnly: z.boolean().optional(),
  includeArchived: z.boolean().optional(),
  instant: z.boolean().optional(),
  projectId: z.string().min(1).max(256).optional(),
  preferredProjectId: z.string().min(1).max(256).optional(),
});
export const ChatMessageSearchInputSchema = ChatSearchInputSchema.omit({
  instant: true,
}).extend({ query: ChatSearchInputSchema.shape.query.refine((query) => query.length > 0) });

export class ChatSearch extends Context.Service<
  ChatSearch,
  {
    readonly rankSessionIds: (input: {
      readonly query: string;
      readonly archived: boolean;
      readonly projectId?: string | null;
    }) => Effect.Effect<readonly string[], ChatSearchError>;
    readonly search: (input: ChatSearchInput) => Effect.Effect<ChatSearchResult, ChatSearchError>;
    readonly searchMessages: (
      input: ChatMessageSearchInput,
    ) => Effect.Effect<ChatMessageSearchResult, ChatSearchError>;
  }
>()("nodex/main/chat-search/ChatSearch") {}

const failure = (operation: ChatSearchError["operation"], cause: unknown) =>
  new ChatSearchError({
    operation,
    reason: "unavailable",
    message: "Chat search is unavailable",
    cause,
  });
const batches = <A>(items: readonly A[], size: number): A[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size),
  );

/**
 * One search owner for a desktop's own chats and for a Space host's Members. A desktop's own
 * search ranks one warm catalog. A Member's search through the host (a `HostInvocation`) reads
 * the chats that Member may read with their authority on each request, bounded, and never shares
 * a catalog or result with anyone else. Main reads catalogs and keeps them fresh; the
 * `ChatSearchEngine` ranks them and merges Runtime history. Native host reads feed that history
 * index independently of query latency.
 */
export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const runtime = yield* AgentRuntimeApplication;
  const ownerScope = yield* Scope.Scope;
  const notifications = yield* DatabaseNotifierRuntime;
  const events = yield* CodexApplicationEventHub;
  const activity = yield* AgentRuntimeSessionActivity;
  const engine = yield* ChatSearchEngine;
  const revision = yield* Ref.make(0);
  const refreshQueue = yield* Queue.sliding<void>(1);
  /** Chats changed since the catalog last caught up; "all" when a change named none. */
  const dirty = yield* Ref.make<ReadonlySet<string> | "all">(new Set());
  const markDirty = (sessionIds: readonly string[] | "all") =>
    Ref.update(dirty, (current) =>
      current === "all" || sessionIds === "all" ? "all" : new Set([...current, ...sessionIds]),
    ).pipe(
      Effect.andThen(Ref.update(revision, (value) => value + 1)),
      Effect.andThen(Queue.offer(refreshQueue, undefined)),
      Effect.asVoid,
    );
  // Subscribe directly so changes cannot race the first catalog query. Each change names the chats
  // it touched, so keeping the catalog current reads only those, never every chat again.
  for (const changes of [
    notifications.projectSessionInvalidations.pipe(
      Stream.map((event): readonly string[] | "all" =>
        event?.detailInvalidation?.kind === "sessions"
          ? event.detailInvalidation.sessionIds
          : "all",
      ),
    ),
    events.events.pipe(
      Stream.filter(
        (event) => event.kind === "hostMessage" && event.value.type === "sidebarSyncUpdated",
      ),
      Stream.map(() => "all" as const),
    ),
    activity.activityChanges.pipe(
      Stream.map((change): readonly string[] | "all" =>
        change.type === "upsert"
          ? [change.activity.sessionId]
          : change.type === "remove"
            ? [change.sessionId]
            : "all",
      ),
    ),
  ])
    yield* changes.pipe(
      Stream.runForEach(markDirty),
      Effect.forkScoped({ startImmediately: true }),
    );

  const placement = Effect.fn("ChatSearch.placement")(function* (
    after: string | null,
    archived: boolean,
  ) {
    const response = yield* core.workspace.read({
      kind: "session_window",
      archived,
      order: "conversation",
      window: { first: 100, after },
    });
    if (response.value.kind !== "session_window")
      return yield* Effect.fail(new Error("Core returned a non-Session window"));
    return response.value.sessions;
  });

  const metadataFor = Effect.fn("ChatSearch.metadataFor")(function* (
    items: readonly ChatListingItem[],
  ) {
    const byRuntime = new Map<string, string[]>();
    for (const item of items) {
      const ref = item.task.session.execution_ref;
      if (!ref) continue;
      const ids = byRuntime.get(ref.runtime_id);
      if (ids) ids.push(ref.thread_id);
      else byRuntime.set(ref.runtime_id, [ref.thread_id]);
    }
    const details = yield* Effect.forEach(
      [...byRuntime],
      ([runtimeId, ids]) =>
        Effect.forEach(
          batches([...new Set(ids)], 100),
          (threadIds) =>
            runtime
              .sessionMetadata({ runtimeId, threadIds })
              .pipe(Effect.timeout("2 seconds"), Effect.option),
          { concurrency: 4 },
        ).pipe(
          Effect.map((pages) =>
            pages.map((page) =>
              Option.map(page, (items) =>
                items.map((item) => [`${runtimeId}\0${item.threadId}`, item] as const),
              ),
            ),
          ),
        ),
      { concurrency: 4 },
    );
    const groups = details.flat();
    return {
      byId: new Map<string, ChatRuntimeMetadata>(
        groups.flatMap((group) => Option.getOrElse(group, () => [])),
      ),
      complete: groups.every(Option.isSome),
    };
  });
  const project = (
    items: readonly ChatListingItem[],
    metadata: ReadonlyMap<string, ChatRuntimeMetadata>,
    archived: boolean,
  ) =>
    items.flatMap((item) => {
      const ref = item.task.session.execution_ref;
      const chat = projectChat(
        item,
        ref ? metadata.get(`${ref.runtime_id}\0${ref.thread_id}`) : undefined,
        archived,
      );
      return chat ? [chat] : [];
    });

  const readCatalog = Effect.fn("ChatSearch.catalog")(
    function* (archived: boolean, maxEntries: number = CHAT_CATALOG_MAX_ENTRIES) {
      const entries = new Map<string, ChatCatalogItem>();
      let after: string | null = null;
      const cursors = new Set<string>();
      let pending: ChatListingItem[] = [];
      let complete = true;
      do {
        const page: Effect.Success<ReturnType<typeof placement>> = yield* placement(
          after,
          archived,
        );
        pending.push(...page.items);
        after = page.next_cursor ?? null;
        if (after && cursors.has(after))
          return yield* Effect.fail(new Error("Session cursor did not advance"));
        if (after) cursors.add(after);
        // Collect a bounded window of placements before looking up execution metadata.
        // Native-heavy catalogs can otherwise issue an RPC for a few Runtime chats on each page.
        if (after !== null && pending.length < 400) continue;
        const metadata = yield* metadataFor(pending);
        complete &&= metadata.complete;
        for (const chat of project(pending, metadata.byId, archived))
          entries.set(chat.sessionId, chat);
        pending = [];
        if (entries.size > maxEntries)
          return {
            entries: [...entries.values()]
              .sort((a, b) => b.recencyAt - a.recencyAt)
              .slice(0, maxEntries),
            complete: false,
          };
      } while (after !== null);
      return {
        entries: [...entries.values()].sort((a, b) => b.recencyAt - a.recencyAt),
        complete,
      };
    },
    Effect.mapError((cause) => failure("catalog", cause)),
    Effect.provideService(CoreApplicationAgent, null),
  );

  /** Reads exactly these chats in both archive states; a chat in neither is gone from the list. */
  const readChats = Effect.fn("ChatSearch.readChats")(
    function* (sessionIds: readonly string[]) {
      const changed = new Map<string, ChatCatalogItem>();
      for (const archived of [false, true])
        for (const ids of batches(sessionIds, 100)) {
          const response = yield* core.workspace.read({
            kind: "session_window",
            archived,
            order: "conversation",
            session_ids: ids,
            window: { first: ids.length, after: null },
          });
          if (response.value.kind !== "session_window")
            return yield* Effect.fail(new Error("Core returned a non-Session window"));
          const items = response.value.sessions.items;
          const metadata = yield* metadataFor(items);
          if (!metadata.complete) return yield* Effect.fail(new Error("Runtime metadata missing"));
          for (const chat of project(items, metadata.byId, archived))
            changed.set(chat.sessionId, chat);
        }
      return changed;
    },
    Effect.provideService(CoreApplicationAgent, null),
  );

  interface WarmCatalog {
    readonly catalog: ChatCatalog;
    readonly byId: ReadonlyMap<string, ChatCatalogItem>;
    /** When every chat was last read; a search after this ages refreshes them all once more. */
    readonly fullAt: number;
  }
  const warm = yield* Ref.make<WarmCatalog | null>(null);
  const catalogGeneration = yield* Ref.make(0);
  const catalogLock = yield* Semaphore.make(1);
  const install = (entries: Iterable<ChatCatalogItem>, complete: boolean, fullAt: number) =>
    Effect.gen(function* () {
      const sorted = [...entries].sort((a, b) => b.recencyAt - a.recencyAt);
      // The ranking engine diffs what it receives, so only changed chats are indexed again.
      yield* engine.publish(sorted);
      const catalog: ChatCatalog = { entries: sorted, complete, prepared: true };
      yield* Ref.set(warm, {
        catalog,
        byId: new Map(sorted.map((chat) => [chat.sessionId, chat])),
        fullAt,
      });
      yield* Ref.update(catalogGeneration, (generation) => generation + 1);
      return catalog;
    });
  /** One writer at a time: a whole read or the chats that changed since the catalog caught up. */
  const catchUp = catalogLock
    .withPermits(1)(
      Effect.gen(function* () {
        const pending = yield* Ref.getAndSet(dirty, new Set());
        const previous = yield* Ref.get(warm);
        const restore = Effect.catchCause((cause: Cause.Cause<unknown>) =>
          Ref.update(dirty, (current) =>
            current === "all" || pending === "all" ? "all" : new Set([...current, ...pending]),
          ).pipe(Effect.andThen(Effect.failCause(cause))),
        );
        if (previous === null || pending === "all") {
          const [active, archive] = yield* Effect.all([readCatalog(false), readCatalog(true)], {
            concurrency: 2,
          }).pipe(restore);
          const value = combineCatalogs([active, archive]);
          const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
          return yield* install(value.entries, value.complete, now);
        }
        if (pending.size === 0) return previous.catalog;
        const ids = [...pending];
        const changed = yield* readChats(ids).pipe(restore);
        const byId = new Map(previous.byId);
        for (const id of ids) if (!changed.has(id)) byId.delete(id);
        for (const [id, chat] of changed) byId.set(id, chat);
        // A catalog that outgrows its bound is read whole again so it keeps the most recent chats.
        if (byId.size > CHAT_CATALOG_MAX_ENTRIES) {
          yield* Ref.set(dirty, "all");
          yield* Queue.offer(refreshQueue, undefined);
          return previous.catalog;
        }
        return yield* install(byId.values(), previous.catalog.complete, previous.fullAt);
      }),
    )
    .pipe(Effect.mapError((cause) => failure("catalog", cause)));

  /** The desktop's own warm catalog: current chats now, with any changes applied behind it. */
  const sharedCatalog = Effect.gen(function* () {
    const previous = yield* Ref.get(warm);
    if (previous === null) return yield* catchUp;
    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    if (now - previous.fullAt >= 15_000) yield* Ref.set(dirty, "all");
    const pending = yield* Ref.get(dirty);
    if (pending === "all" || pending.size > 0)
      yield* catchUp.pipe(Effect.ignore, Effect.forkIn(ownerScope, { startImmediately: true }));
    return previous.catalog;
  });

  yield* sharedCatalog.pipe(
    Effect.retry(Schedule.max([Schedule.spaced("1 second"), Schedule.recurs(3)])),
    Effect.ignore,
    Effect.forkScoped({ startImmediately: true }),
  );
  // Changes arrive in bursts while Agents work; one catch-up covers each burst.
  yield* Stream.fromQueue(refreshQueue).pipe(
    Stream.debounce("250 millis"),
    Stream.runForEach(() => catchUp.pipe(Effect.ignore)),
    Effect.forkScoped({ startImmediately: true }),
  );

  /** The Member a host call carries, whose own reads are never shared; null for this desktop. */
  const member = Effect.map(HostInvocation, (invocation) => invocation !== null);
  const catalog = Effect.flatMap(member, (forMember) =>
    forMember
      ? Effect.all(
          [
            readCatalog(false, MEMBER_CHAT_CATALOG_MAX_ENTRIES),
            readCatalog(true, MEMBER_CHAT_CATALOG_MAX_ENTRIES),
          ],
          { concurrency: 2 },
        ).pipe(Effect.map(combineCatalogs))
      : sharedCatalog,
  );

  /** The desktop's warm catalog, or the chats this Member may read; ranked by the engine. */
  const admittedCatalog = (waitForCatalog = true) =>
    Effect.gen(function* () {
      if (yield* member) {
        const admitted = yield* catalog;
        return { admitted, source: inline(admitted) };
      }
      const admitted: ChatCatalog = waitForCatalog
        ? yield* sharedCatalog
        : ((yield* Ref.get(warm))?.catalog ?? { entries: [], complete: false });
      return { admitted, source: { kind: "shared" } as const };
    });
  const inline = (admitted: ChatCatalog): ChatSearchCatalog => ({
    kind: "inline",
    entries: admitted.entries,
  });

  const messageMatches = (input: ChatMessageSearchInput) =>
    Effect.gen(function* () {
      const { admitted, source } = yield* admittedCatalog();
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      const ranked = yield* engine
        .searchMessages({ catalog: source, input, now })
        .pipe(Effect.mapError((cause) => failure("search-messages", cause)));
      return { ...ranked, catalogComplete: admitted.complete } satisfies ChatMessageSearchResult;
    });
  const cache = yield* Cache.makeWith(
    (key: string) => messageMatches((JSON.parse(key) as { input: ChatMessageSearchInput }).input),
    {
      capacity: 100,
      timeToLive: (exit) =>
        exit._tag === "Success" &&
        exit.value.catalogComplete &&
        exit.value.sources.every(({ state }) => state === "complete")
          ? "30 seconds"
          : 0,
    },
  );
  const search = Effect.fn("ChatSearch.search")(function* (input: ChatSearchInput) {
    const parsed = yield* Effect.try({
      try: () => ChatSearchInputSchema.parse(input),
      catch: (cause) =>
        new ChatSearchError({
          operation: "search",
          reason: "invalid_input",
          message: "Invalid chat search",
          cause,
        }),
    });
    const { admitted, source } = yield* admittedCatalog(!parsed.instant);
    if (parsed.instant && source.kind === "shared" && !admitted.prepared)
      return { matches: [], complete: false, loading: true } satisfies ChatSearchResult;
    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    const ranked = yield* engine
      .search({ catalog: source, input: parsed, now })
      .pipe(Effect.mapError((cause) => failure("search", cause)));
    return { ...ranked, complete: admitted.complete } satisfies ChatSearchResult;
  });
  const searchMessages = Effect.fn("ChatSearch.searchMessages")(function* (
    input: ChatMessageSearchInput,
  ) {
    const parsed = yield* Effect.try({
      try: () => ChatMessageSearchInputSchema.parse(input),
      catch: (cause) =>
        new ChatSearchError({
          operation: "search-messages",
          reason: "invalid_input",
          message: "Invalid chat message search",
          cause,
        }),
    });
    const normalized = {
      ...parsed,
      query: parsed.query,
    };
    if (yield* member) return yield* messageMatches(normalized);
    const currentRevision = yield* Ref.get(revision);
    yield* sharedCatalog;
    const generation = yield* Ref.get(catalogGeneration);
    return yield* Cache.get(
      cache,
      JSON.stringify({ input: normalized, revision: currentRevision, generation }),
    );
  });
  const rankSessionIds: ChatSearch["Service"]["rankSessionIds"] = (input) =>
    Effect.gen(function* () {
      const { source } = input.archived
        ? {
            source: inline(
              yield* readCatalog(
                true,
                (yield* member) ? MEMBER_CHAT_CATALOG_MAX_ENTRIES : undefined,
              ),
            ),
          }
        : yield* admittedCatalog();
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      return yield* engine
        .rankSessionIds({ catalog: source, ...input, now })
        .pipe(Effect.mapError((cause) => failure("search", cause)));
    });
  return ChatSearch.of({ search, searchMessages, rankSessionIds });
});

/** The desktop and a Space host rank in one shared worker at `workerPath`. */
export const live = (options: ChatSearchWorker.ChatSearchWorkerOptions) =>
  Layer.effect(ChatSearch, make).pipe(Layer.provide(ChatSearchWorker.live(options)));
