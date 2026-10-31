import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as Duration from "effect/Duration";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import { z } from "zod";
import {
  findSearchTokenRanges,
  foldSearchQuery,
  messageMatcher,
  rankMessageMatches,
} from "@nodex/agent-runtime/palette-search";
import {
  CHAT_SEARCH_MAX_LIMIT,
  CHAT_SEARCH_QUERY_MAX_CHARS,
  type ChatSearchInput,
  type ChatSearchResult,
  type ChatMessageSearchResult,
  type ChatMessageSource,
  type ChatMessageSourceState,
} from "../../shared/chat-search";
import { cappedApproximateValueBytes } from "../../shared/codex-bounded-value-size";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { CodexInternalThreadRegistry } from "../codex-application/CodexInternalThreadRegistry";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import { AgentRuntimeSessionActivity } from "../agent-runtime/AgentRuntimeSessionActivity";
import { isNonSidebarThreadWithoutParent } from "../codex-application/CodexThreadCatalogProjection";
import { CodexGateway, codexGatewayGenerationFence } from "../codex-runtime/CodexGateway";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CoreModules } from "../core-runtime/CoreModules";
import {
  CHAT_CATALOG_MAX_ENTRIES,
  projectChat,
  type ChatCatalogItem,
  type ChatListingItem,
  type ChatRuntimeMetadata,
} from "./ChatCatalogProjection";

import { chatSearchSubject, chatWireEntry, rankCatalog, singleLine } from "./ChatSearchRanking";

interface ChatCatalog {
  readonly entries: readonly ChatCatalogItem[];
  readonly complete: boolean;
}
type ChatMessageSearchInput = Pick<ChatSearchInput, "query" | "limit">;

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
});
export const ChatMessageSearchInputSchema = ChatSearchInputSchema.omit({
  startedOnly: true,
}).extend({ query: ChatSearchInputSchema.shape.query.refine((query) => query.length > 0) });

export class ChatSearch extends Context.Service<
  ChatSearch,
  {
    readonly search: (input: ChatSearchInput) => Effect.Effect<ChatSearchResult, ChatSearchError>;
    readonly searchMessages: (
      input: ChatMessageSearchInput,
    ) => Effect.Effect<ChatMessageSearchResult, ChatSearchError>;
  }
>()("nodex/main/chat-search/ChatSearch") {}

interface RankedMatch {
  readonly chat: ChatCatalogItem;
  readonly snippet: string;
  readonly role: "user" | "assistant" | null;
  readonly quality?: number;
  readonly hits?: number;
  readonly messageCreatedAt?: string;
}
interface SourceResult {
  readonly matches: readonly RankedMatch[];
  readonly state: ChatMessageSourceState;
}
interface PendingScan {
  readonly input: ChatMessageSearchInput;
  readonly catalog: ChatCatalog;
  readonly result: Deferred.Deferred<SourceResult>;
  readonly deadlineAt: number;
}
const unavailable = (source: ChatMessageSource): SourceResult => ({
  matches: [],
  state: { source, state: "unavailable" },
});
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

export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const runtime = yield* AgentRuntimeApplication;
  const gateway = yield* CodexGateway;
  const internalThreads = yield* CodexInternalThreadRegistry;
  const ownerScope = yield* Scope.Scope;
  const notifications = yield* DatabaseNotifierRuntime;
  const events = yield* CodexApplicationEventHub;
  const activity = yield* AgentRuntimeSessionActivity;
  const revision = yield* Ref.make(0);
  // Subscribe directly so changes cannot race the first catalog query.
  for (const changes of [
    notifications.projectSessionInvalidations.pipe(Stream.map(() => undefined)),
    events.events.pipe(
      Stream.filter(
        (event) => event.kind === "hostMessage" && event.value.type === "sidebarSyncUpdated",
      ),
      Stream.map(() => undefined),
    ),
    activity.activityChanges.pipe(Stream.map(() => undefined)),
  ])
    yield* changes.pipe(
      Stream.runForEach(() => Ref.update(revision, (value) => value + 1)),
      Effect.forkScoped({ startImmediately: true }),
    );

  const placement = Effect.fn("ChatSearch.placement")(function* (after: string | null) {
    const response = yield* core.workspace.read({
      kind: "session_window",
      archived: false,
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
      byRuntime.set(ref.runtime_id, [...(byRuntime.get(ref.runtime_id) ?? []), ref.thread_id]);
    }
    const details = yield* Effect.forEach(
      [...byRuntime],
      ([runtimeId, ids]) =>
        Effect.forEach(
          batches([...new Set(ids)], 100),
          (threadIds) => runtime.sessionMetadata({ runtimeId, threadIds }),
          { concurrency: 4 },
        ).pipe(
          Effect.map((pages) =>
            pages.flat().map((item) => [`${runtimeId}\0${item.threadId}`, item] as const),
          ),
        ),
      { concurrency: 4 },
    );
    return new Map<string, ChatRuntimeMetadata>(details.flat());
  });
  const project = (
    items: readonly ChatListingItem[],
    metadata: ReadonlyMap<string, ChatRuntimeMetadata>,
  ) =>
    items.flatMap((item) => {
      const ref = item.task.session.execution_ref;
      const chat = projectChat(
        item,
        ref ? metadata.get(`${ref.runtime_id}\0${ref.thread_id}`) : undefined,
      );
      return chat ? [chat] : [];
    });

  const readCatalog = Effect.fn("ChatSearch.catalog")(
    function* () {
      const entries = new Map<string, ChatCatalogItem>();
      let after: string | null = null;
      const cursors = new Set<string>();
      do {
        const page: Effect.Success<ReturnType<typeof placement>> = yield* placement(after);
        const metadata = yield* metadataFor(page.items);
        for (const chat of project(page.items, metadata)) entries.set(chat.sessionId, chat);
        after = page.next_cursor ?? null;
        if (entries.size > CHAT_CATALOG_MAX_ENTRIES)
          return {
            entries: [...entries.values()]
              .sort((a, b) => b.recencyAt - a.recencyAt)
              .slice(0, CHAT_CATALOG_MAX_ENTRIES),
            complete: false,
          };
        if (after && cursors.has(after))
          return yield* Effect.fail(new Error("Session cursor did not advance"));
        if (after) cursors.add(after);
      } while (after !== null);
      return {
        entries: [...entries.values()].sort((a, b) => b.recencyAt - a.recencyAt),
        complete: true,
      };
    },
    Effect.mapError((cause) => failure("catalog", cause)),
    Effect.provideService(CoreApplicationAgent, null),
  );

  const catalogFlight = yield* Ref.make<Deferred.Deferred<ChatCatalog, ChatSearchError> | null>(
    null,
  );
  const warm = yield* Ref.make<{
    readonly catalog: ChatCatalog;
    readonly revision: number;
    readonly builtAt: number;
  } | null>(null);
  const catalogGeneration = yield* Ref.make(0);
  const catalog = Effect.gen(function* () {
    const previous = yield* Ref.get(warm);
    const currentRevision = yield* Ref.get(revision);
    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    if (previous && previous.revision === currentRevision && now - previous.builtAt < 15_000)
      return previous.catalog;
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const fresh = Deferred.makeUnsafe<ChatCatalog, ChatSearchError>();
        const flight = yield* Ref.modify(catalogFlight, (current) => [
          current ?? fresh,
          current ?? fresh,
        ]);
        if (flight === fresh)
          yield* readCatalog().pipe(
            Effect.tap((value) =>
              Ref.set(warm, { catalog: value, revision: currentRevision, builtAt: now }).pipe(
                Effect.andThen(Ref.update(catalogGeneration, (value) => value + 1)),
              ),
            ),
            Effect.onExit((exit) =>
              Ref.set(catalogFlight, null).pipe(Effect.andThen(Deferred.done(flight, exit))),
            ),
            Effect.exit,
            Effect.forkIn(ownerScope, { startImmediately: true }),
          );
        return previous ? previous.catalog : yield* restore(Deferred.await(flight));
      }),
    );
  });

  const runtimeMatches = Effect.fn("ChatSearch.runtimeMatches")(function* (
    input: ChatMessageSearchInput,
    admitted: ChatCatalog,
  ) {
    // Runtime's indexed search accepts queries of at least two UTF-16 code units.
    if (input.query.length < 2) return yield* Effect.fail(new Error("Runtime query is too short"));
    const matches: RankedMatch[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: Effect.Success<ReturnType<typeof runtime.sessionSearch>> =
        yield* runtime.sessionSearch({
          query: input.query,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
      if (page.runtimeId === null) return matches;
      const chats = new Map(
        admitted.entries
          .filter(
            (chat) => chat.binding?.kind === "runtime" && chat.binding.runtimeId === page.runtimeId,
          )
          .map((chat) => [chat.threadId, chat]),
      );
      const facts: typeof page.items = page.items.filter((fact) => chats.has(fact.threadId));
      for (const batch of batches(facts, 50)) {
        const resolved: Effect.Success<ReturnType<typeof runtime.sessionSearchResolve>> =
          yield* runtime.sessionSearchResolve({
            query: input.query,
            references: batch.map(({ threadId, itemId, messageId, contentVersion }) => ({
              threadId,
              itemId,
              messageId,
              contentVersion,
            })),
          });
        if (resolved.runtimeId !== page.runtimeId)
          return yield* Effect.fail(new Error("Runtime identity changed"));
        for (const fact of resolved.items) {
          const original = batch.find(
            (item) =>
              item.messageId === fact.messageId &&
              item.threadId === fact.threadId &&
              item.contentVersion === fact.contentVersion,
          );
          const chat = chats.get(fact.threadId);
          if (!original || !chat) continue;
          const snippet = singleLine(fact.snippet);
          matches.push({
            chat,
            snippet,
            role: fact.source,
            quality: messageMatcher(input.query)(snippet)?.quality ?? fact.quality,
            hits: original.hits,
            messageCreatedAt: fact.messageAt,
          });
        }
      }
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor))
        return yield* Effect.fail(new Error("Runtime search cursor did not advance"));
      if (cursor) cursors.add(cursor);
    } while (
      cursor !== null &&
      new Set(matches.map((match) => match.chat.sessionId)).size < input.limit
    );
    return matches;
  });

  const codexMatches = Effect.fn("ChatSearch.codexMatches")(function* (
    input: ChatMessageSearchInput,
    admitted: ChatCatalog,
  ) {
    const connection = yield* gateway.connection(gateway.localHostId);
    if (connection.kind !== "ready") return yield* Effect.fail(new Error("Codex is unavailable"));
    const chats = new Map(
      admitted.entries
        .filter(
          (chat) =>
            chat.binding?.kind === "native" &&
            chat.backend === "codex" &&
            chat.binding.hostId === gateway.localHostId,
        )
        .map((chat) => [chat.threadId, chat]),
    );
    const matches: RankedMatch[] = [];
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let bytes = 0;
    for (let page = 0; page < 5; page++) {
      const response: ClientRequestResponsesByMethod["thread/search"] = yield* gateway.requestLocal(
        "thread/search",
        {
          cursor,
          limit: input.limit,
          sortKey: "updated_at",
          sortDirection: "desc",
          sourceKinds: [],
          archived: false,
          searchTerm: input.query,
        },
        {
          ...codexGatewayGenerationFence(connection),
          priority: "interactive",
          source: "thread_catalog",
          timeoutMs: 12_000,
        },
      );
      if (
        response.data.length > input.limit ||
        cappedApproximateValueBytes(response.data, 2 * 1024 * 1024) > 2 * 1024 * 1024
      )
        return yield* Effect.fail(new Error("Codex search page exceeded its byte budget"));
      for (const hit of response.data) {
        const thread = hit.thread;
        const chat = chats.get(thread.id);
        const sourceExcluded =
          isNonSidebarThreadWithoutParent(thread as unknown as Record<string, unknown>) ||
          internalThreads.shouldSuppress(thread.id);
        // Core-admitted root Sessions can retain their original subagent source label.
        const linkedRoot =
          chat &&
          thread.threadSource !== "system" &&
          internalThreads.classification(thread.id) !== "structured-title";
        if (
          !chat ||
          thread.ephemeral ||
          thread.parentThreadId ||
          (sourceExcluded && !linkedRoot) ||
          seen.has(chat.sessionId)
        )
          continue;
        const snippet = singleLine(hit.snippet);
        const match = {
          chat,
          snippet,
          role: null,
          quality: messageMatcher(input.query)(snippet)?.quality,
        } satisfies RankedMatch;
        bytes += cappedApproximateValueBytes(match, 256 * 1024 - bytes);
        if (bytes > 256 * 1024)
          return yield* Effect.fail(new Error("Codex search results exceeded their byte budget"));
        matches.push(match);
        seen.add(chat.sessionId);
      }
      cursor = response.nextCursor ?? null;
      if (cursor === null || matches.length >= input.limit) return matches;
      if (cursors.has(cursor))
        return yield* Effect.fail(new Error("Codex search cursor did not advance"));
      cursors.add(cursor);
    }
    return yield* Effect.fail(new Error("Codex search exceeded its page budget"));
  });

  const sourceResult = <E>(
    source: ChatMessageSource,
    operation: Effect.Effect<readonly RankedMatch[], E>,
    deadline: Duration.Input,
  ): Effect.Effect<SourceResult> =>
    operation.pipe(
      Effect.timeoutOption(deadline),
      Effect.map((result): SourceResult =>
        Option.isSome(result)
          ? { matches: result.value, state: { source, state: "complete" } }
          : { matches: [], state: { source, state: "timed_out" } },
      ),
      Effect.catchCause(() => Effect.succeed(unavailable(source))),
    );
  const scans = yield* Ref.make<{
    readonly running: boolean;
    readonly pending: PendingScan | null;
  }>({ running: false, pending: null });
  const runScans = Effect.fn("ChatSearch.runScans")(function* (first: PendingScan) {
    let current: PendingScan | null = first;
    while (current) {
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      const remaining = current.deadlineAt - now;
      const result: SourceResult =
        remaining <= 0
          ? { matches: [], state: { source: "codex", state: "timed_out" } }
          : yield* sourceResult("codex", codexMatches(current.input, current.catalog), remaining);
      yield* Deferred.succeed(current.result, result);
      current = yield* Ref.modify(scans, ({ pending }) => [
        pending,
        { running: pending !== null, pending: null },
      ]);
    }
  });
  const latestCodex = Effect.fn("ChatSearch.latestCodex")(function* (
    input: ChatMessageSearchInput,
    catalog: ChatCatalog,
  ) {
    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    const request: PendingScan = {
      input,
      catalog,
      result: Deferred.makeUnsafe(),
      deadlineAt: now + 12_000,
    };
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const previous = yield* Ref.modify(scans, (state) => [
          state,
          { running: true, pending: state.running ? request : null },
        ]);
        if (previous.pending)
          yield* Deferred.succeed(previous.pending.result, unavailable("codex"));
        if (!previous.running)
          yield* runScans(request).pipe(Effect.forkIn(ownerScope, { startImmediately: true }));
        return yield* restore(Deferred.await(request.result));
      }),
    );
  });

  const cache = yield* Cache.make({
    capacity: 100,
    timeToLive: "30 seconds",
    lookup: (key: string) =>
      Effect.gen(function* () {
        const { input, revision: _revision } = JSON.parse(key) as {
          input: ChatMessageSearchInput;
          revision: number;
        };
        const admitted = yield* catalog;
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        const excluded = new Set(
          rankCatalog(admitted.entries, input.query, now).map(({ entry }) => entry.sessionId),
        );
        const eligible = {
          ...admitted,
          entries: admitted.entries.filter((entry) => !excluded.has(entry.sessionId)),
        };
        const sources = yield* Effect.all(
          [
            sourceResult("runtime", runtimeMatches(input, eligible), "3 seconds"),
            latestCodex(input, eligible),
          ],
          { concurrency: "unbounded" },
        );
        const ranked = rankMessageMatches(
          sources
            .flatMap((source) => source.matches)
            .filter((match) => !excluded.has(match.chat.sessionId)),
          (match) => chatSearchSubject(match.chat),
          foldSearchQuery(input.query),
          now,
          { picks: false },
        );
        const seen = new Set<string>();
        const matches = ranked
          .filter((match) => {
            if (seen.has(match.chat.sessionId)) return false;
            seen.add(match.chat.sessionId);
            return true;
          })
          .slice(0, input.limit)
          .map(({ chat, snippet, role }) => ({
            chat: chatWireEntry(chat),
            titleRanges: [],
            hint: null,
            excerpt: { text: snippet, ranges: findSearchTokenRanges(snippet, input.query), role },
          }));
        return {
          matches,
          sources: sources.map((source) => source.state),
        } satisfies ChatMessageSearchResult;
      }).pipe(Effect.provideService(CoreApplicationAgent, null)),
  });
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
    const admitted = yield* catalog;
    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
    return {
      matches: rankCatalog(admitted.entries, parsed.query, now)
        .filter(({ entry }) => !parsed.startedOnly || entry.threadId !== null)
        .slice(0, parsed.limit)
        .map(({ render }) => render()),
      complete: admitted.complete,
    };
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
    const currentRevision = yield* Ref.get(revision);
    yield* catalog;
    const generation = yield* Ref.get(catalogGeneration);
    const normalized = {
      ...parsed,
      query: parsed.query.normalize("NFC").toLowerCase().replace(/\s+/gu, " "),
    };
    return yield* Cache.get(
      cache,
      JSON.stringify({ input: normalized, revision: currentRevision, generation }),
    );
  });
  return ChatSearch.of({ search, searchMessages });
});

export const live = Layer.effect(ChatSearch, make);
