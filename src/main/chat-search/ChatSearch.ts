import { nativeSearchThreadId } from "@nodex/agent-runtime/orchestration/NativeSearchHistory";
import { compileSearchQuery } from "@nodex/search-kernel/node";
import { projectAutomationHeartbeatExcerpt } from "../../shared/automation-heartbeat";
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
import { z } from "zod";
import { compareMessageSearchRank, scoreMessageSearch } from "@nodex/agent-runtime/palette-search";
import type { CatalogWordRanks } from "@nodex/agent-runtime/orchestration/SessionSearchIndex";
import { corpusHighlights } from "@nodex/agent-runtime/orchestration/SessionSearchText";
import {
  CHAT_SEARCH_MAX_LIMIT,
  CHAT_SEARCH_QUERY_MAX_CHARS,
  type ChatSearchInput,
  type ChatSearchMatch,
  type ChatHistoryMatch,
  type ChatSearchResult,
  type ChatMessageSearchResult,
  type ChatMessageSource,
  type ChatMessageSourceState,
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
  chatSearchSubject,
  chatWireEntry,
  prepareChatCatalog,
  rankCatalog,
  singleLine,
} from "./ChatSearchRanking";

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

interface RankedMatch {
  readonly chat: ChatCatalogItem;
  readonly snippet: string;
  readonly role: "user" | "assistant" | null;
  readonly quality?: number;
  readonly wordQuality?: number;
  readonly historyMatch?: ChatHistoryMatch;
  readonly hits?: number;
  readonly messageCreatedAt?: string;
}
interface SourceResult {
  readonly matches: readonly RankedMatch[];
  readonly state: ChatMessageSourceState;
  readonly hasMore?: boolean;
}
interface SourceCompletion {
  readonly incomplete: boolean;
  readonly hasMore: boolean;
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

/**
 * One search owner for a desktop's own chats and for a Space host's Members. A desktop's own
 * search ranks one warm catalog. A Member's search through the host (a `HostInvocation`) reads
 * the chats that Member may read with their authority on each request, bounded, and never shares
 * a catalog or result with anyone else. All admitted history uses the Runtime index; native
 * host reads feed that index independently of query latency.
 */
export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const runtime = yield* AgentRuntimeApplication;
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
        for (const chat of project(pending, metadata, archived)) entries.set(chat.sessionId, chat);
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
  const sharedCatalog = Effect.gen(function* () {
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
          yield* readCatalog(false).pipe(
            Effect.tap((value) =>
              Effect.gen(function* () {
                const builtAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
                yield* Ref.set(warm, { catalog: value, revision: currentRevision, builtAt });
                yield* Ref.update(catalogGeneration, (generation) => generation + 1);
              }),
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

  /** The Member a host call carries, whose own reads are never shared; null for this desktop. */
  const member = Effect.map(HostInvocation, (invocation) => invocation !== null);
  const catalog = Effect.flatMap(member, (forMember) =>
    forMember ? readCatalog(false, MEMBER_CHAT_CATALOG_MAX_ENTRIES) : sharedCatalog,
  );

  const indexId = (chat: ChatCatalogItem) =>
    chat.binding?.kind === "native"
      ? nativeSearchThreadId(chat.binding.hostId, chat.binding.threadId)
      : chat.threadId;
  const runtimeMatches = Effect.fn("ChatSearch.runtimeMatches")(function* (
    input: ChatMessageSearchInput,
    admitted: ChatCatalog,
    matches: RankedMatch[],
    options: {
      readonly metadata: readonly CatalogWordRanks[];
      readonly strongWords: readonly boolean[];
      readonly observedStrong: boolean[];
      readonly now: number;
      readonly suppressHistory: (sessionId: string) => boolean;
    },
  ) {
    const { metadata, strongWords, observedStrong, now, suppressHistory } = options;
    const nativeChats = new Map<string, ChatCatalogItem>();
    const runtimeChats = new Map<string, ChatCatalogItem>();
    const scope = new Set<string>();
    const subjects = [];
    for (const chat of admitted.entries) {
      const id = indexId(chat);
      if (!chat.binding || !id) continue;
      scope.add(id);
      subjects.push({
        threadId: id,
        sessionId: chat.sessionId,
        activityAt: chat.recencyAt,
        opens: chat.opens,
      });
      if (chat.binding.kind === "native") nativeChats.set(id, chat);
      else runtimeChats.set(`${chat.binding.runtimeId}\0${id}`, chat);
    }
    const threadIds = [...scope];
    const picker = subjects.length === scope.size ? { now, subjects } : undefined;
    const cursors = new Set<string>();
    let cursor: string | null = null;
    let incomplete = false;
    let boundRuntime: string | null = null;
    do {
      const page: Effect.Success<ReturnType<typeof runtime.sessionSearch>> =
        yield* runtime.sessionSearch({
          query: input.query,
          threadIds,
          ...(metadata.length ? { metadata } : {}),
          strongWords,
          ...(picker ? { picker } : {}),
          limit: picker ? input.limit : 100,
          ...(cursor ? { cursor } : {}),
        });
      if (page.runtimeId === null && threadIds.length === 0)
        return { incomplete: false, hasMore: false };
      if (page.runtimeId === null || (boundRuntime !== null && page.runtimeId !== boundRuntime))
        return yield* Effect.fail(new Error("Runtime identity changed or is unavailable"));
      boundRuntime = page.runtimeId;
      for (const [index, strong] of page.strongWords.entries()) observedStrong[index] ||= strong;
      for (const fact of page.items) {
        const chat =
          nativeChats.get(fact.threadId) ?? runtimeChats.get(`${page.runtimeId}\0${fact.threadId}`);
        if (!chat) continue;
        const excerpt = projectAutomationHeartbeatExcerpt(fact.snippet);
        if (excerpt !== fact.snippet && !excerpt.includes(fact.matchedText)) continue;
        matches.push({
          chat,
          snippet: singleLine(excerpt),
          role: fact.source === "user" || fact.source === "assistant" ? fact.source : null,
          quality: fact.quality,
          wordQuality: fact.wordQuality,
          hits: fact.hits,
          messageCreatedAt: fact.messageAt,
          historyMatch: {
            sessionId: chat.sessionId,
            sourceThreadId: chat.threadId!,
            itemId: fact.itemId,
            runId: fact.runId,
            matchedText: fact.matchedText,
          },
        });
      }
      incomplete ||= page.truncated;
      cursor = page.nextCursor;
      if (cursor === null) return { incomplete, hasMore: false };
      if (
        page.pickerOrdered &&
        new Set(
          matches
            .filter(({ chat }) => !suppressHistory(chat.sessionId))
            .map(({ chat }) => chat.sessionId),
        ).size >= input.limit
      )
        return { incomplete, hasMore: true };
      if (cursors.has(cursor))
        return yield* Effect.fail(new Error("Runtime search cursor did not advance"));
      cursors.add(cursor);
    } while (cursor !== null);
    return { incomplete, hasMore: false };
  });

  const sourceResult = <E>(
    source: ChatMessageSource,
    operation: (matches: RankedMatch[]) => Effect.Effect<SourceCompletion, E>,
    deadline: Duration.Input,
  ): Effect.Effect<SourceResult> =>
    Effect.suspend(() => {
      const matches: RankedMatch[] = [];
      return operation(matches).pipe(
        Effect.timeoutOption(deadline),
        Effect.map((result): SourceResult => ({
          matches,
          hasMore: Option.isSome(result) && result.value.hasMore,
          state: {
            source,
            state: Option.isSome(result)
              ? result.value.incomplete
                ? "partial"
                : "complete"
              : matches.length
                ? "partial"
                : "timed_out",
          },
        })),
        Effect.catchCause(() =>
          Effect.succeed<SourceResult>(
            matches.length ? { matches, state: { source, state: "partial" } } : unavailable(source),
          ),
        ),
      );
    });
  const messageMatches = (input: ChatMessageSearchInput) =>
    Effect.gen(function* () {
      const admitted = yield* catalog;
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      using query = compileSearchQuery(input.query);
      const prepared = prepareChatCatalog(admitted.entries, query, input.query, now);
      const observedStrong = [...prepared.strongWords];
      const metadata = prepared.facts.flatMap(({ entry, metadata }) => {
        if (!entry.binding || !entry.threadId || !metadata.withTypos.some((rank) => rank !== null))
          return [];
        return [
          {
            threadId:
              entry.binding.kind === "native"
                ? nativeSearchThreadId(entry.binding.hostId, entry.threadId)
                : entry.threadId,
            withoutTypos: metadata.withoutTypos,
            withTypos: metadata.withTypos,
          },
        ];
      });
      const rankCatalogMatches = () =>
        new Map(prepared.rank(observedStrong).map((fact) => [fact.entry.sessionId, fact] as const));
      let catalogRank:
        | { corpus: string; matches: ReturnType<typeof rankCatalogMatches> }
        | undefined;
      const catalogMatchesFor = () => {
        const corpus = observedStrong.join(",");
        if (!catalogRank || catalogRank.corpus !== corpus)
          catalogRank = { corpus, matches: rankCatalogMatches() };
        return catalogRank.matches;
      };
      const suppressHistory = (sessionId: string) => {
        const match = catalogMatchesFor().get(sessionId);
        return match?.kind === "metadata" && match.rank.word;
      };
      const source = yield* sourceResult(
        "runtime",
        (matches) =>
          runtimeMatches(input, admitted, matches, {
            metadata,
            strongWords: prepared.strongWords,
            observedStrong,
            now,
            suppressHistory,
          }),
        "3 seconds",
      );
      const sources = [source];
      const catalogMatches = catalogMatchesFor();
      const ranked = sources
        .flatMap((source) => source.matches)
        .flatMap((match) => {
          const { chat, snippet, role, historyMatch } = match;
          const rank = scoreMessageSearch(match, chatSearchSubject(chat), now);
          if (suppressHistory(chat.sessionId)) return [];
          return [
            {
              entry: chat,
              rank,
              render: (): ChatSearchMatch => ({
                chat: chatWireEntry(chat),
                rank,
                titleRanges: corpusHighlights(query, chat.title, "metadata", observedStrong),
                hint: null,
                ...(historyMatch ? { historyMatch } : {}),
                excerpt: {
                  text: snippet,
                  ranges: corpusHighlights(query, snippet, "long_text", observedStrong),
                  role,
                },
              }),
            },
          ];
        });
      ranked.push(
        ...[...catalogMatches.values()].filter(
          (match) => match.kind !== "metadata" || !match.rank.word,
        ),
      );
      ranked.sort(
        (a, b) =>
          compareMessageSearchRank(a.rank, b.rank) ||
          a.entry.sessionId.localeCompare(b.entry.sessionId),
      );
      const seen = new Set<string>();
      const distinct = ranked.filter(({ entry }) => {
        if (seen.has(entry.sessionId)) return false;
        seen.add(entry.sessionId);
        return true;
      });
      const matches = distinct.slice(0, input.limit).map(({ render }) => render());
      return {
        matches,
        sources: sources.map((source) => source.state),
        truncated:
          !admitted.complete ||
          distinct.length > input.limit ||
          sources.some(({ state, hasMore }) => hasMore || state.state === "partial"),
      } satisfies ChatMessageSearchResult;
    }).pipe(Effect.provideService(CoreApplicationAgent, null));
  const cache = yield* Cache.makeWith(
    (key: string) => messageMatches((JSON.parse(key) as { input: ChatMessageSearchInput }).input),
    {
      capacity: 100,
      timeToLive: (exit) =>
        exit._tag === "Success" && exit.value.sources.every(({ state }) => state === "complete")
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
      const admitted = yield* input.archived
        ? readCatalog(true, (yield* member) ? MEMBER_CHAT_CATALOG_MAX_ENTRIES : undefined)
        : catalog;
      const candidates =
        input.projectId === undefined
          ? admitted.entries
          : admitted.entries.filter((entry) => entry.projectId === input.projectId);
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      return rankCatalog(candidates, input.query, now).map(({ entry }) => entry.sessionId);
    });
  return ChatSearch.of({ search, searchMessages, rankSessionIds });
});

export const live = Layer.effect(ChatSearch, make);
