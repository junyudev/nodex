import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import { nativeSearchThreadId } from "@nodex/agent-runtime/orchestration/NativeSearchHistory";
import type { CatalogWordRanks } from "@nodex/agent-runtime/orchestration/SessionSearchIndex";
import { corpusHighlights } from "@nodex/agent-runtime/orchestration/SessionSearchText";
import { compareMessageSearchRank, scoreMessageSearch } from "@nodex/agent-runtime/palette-search";
import { compileSearchQuery } from "@nodex/search-kernel/node";
import { projectAutomationHeartbeatExcerpt } from "../../shared/automation-heartbeat";
import type {
  ChatCatalogEntry,
  ChatHistoryMatch,
  ChatMessageSearchResult,
  ChatMessageSource,
  ChatMessageSourceState,
  ChatSearchInput,
  ChatSearchMatch,
} from "../../shared/chat-search";
import type { ChatCatalogItem } from "./ChatCatalogProjection";
import { prepareChatMetadataIndex } from "./ChatMetadataIndex";
import {
  chatArchiveTier,
  chatSearchSubject,
  chatWireEntry,
  prepareChatCatalog,
  rankCatalog,
  singleLine,
} from "./ChatSearchRanking";

export type ChatMessageSearchInput = Omit<ChatSearchInput, "instant">;
export type SessionSearchRequest = AgentRuntimeOperations["sessions.search"]["input"];
/** One Runtime history page, with the identity of the Runtime that answered it. */
export type SessionSearchPage = AgentRuntimeOperations["sessions.search"]["output"] & {
  readonly runtimeId: string | null;
};

/** The desktop's own shared catalog, or the chats one Member may read for a single request. */
export type ChatSearchCatalog =
  | { readonly kind: "shared" }
  | { readonly kind: "inline"; readonly entries: readonly ChatCatalogItem[] };

export interface ChatSearchRequest {
  readonly catalog: ChatSearchCatalog;
  readonly input: ChatSearchInput;
  readonly now: number;
}
export interface ChatMessageSearchRequest {
  readonly catalog: ChatSearchCatalog;
  readonly input: ChatMessageSearchInput;
  readonly now: number;
}
export interface ChatRankRequest {
  readonly catalog: ChatSearchCatalog;
  readonly query: string;
  readonly archived: boolean;
  readonly projectId?: string | null;
  readonly now: number;
}
export interface ChatRanked {
  readonly matches: readonly ChatSearchMatch[];
  readonly truncated: boolean;
}
export type ChatMessagesRanked = Omit<ChatMessageSearchResult, "catalogComplete">;

export class ChatSearchEngineUnavailable extends Data.TaggedError("ChatSearchEngineUnavailable")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Ranks chat catalogs and merges them with Runtime history. Main reads catalogs and owns their
 * freshness; the engine owns the prepared metadata index and every per-query computation, so
 * the desktop runs it in one shared worker and Main only routes queries.
 */
export class ChatSearchEngine extends Context.Service<
  ChatSearchEngine,
  {
    /** Replaces the desktop's shared catalog and prepares its metadata index. */
    readonly publish: (entries: readonly ChatCatalogItem[]) => Effect.Effect<void>;
    readonly search: (
      request: ChatSearchRequest,
    ) => Effect.Effect<ChatRanked, ChatSearchEngineUnavailable>;
    readonly searchMessages: (
      request: ChatMessageSearchRequest,
    ) => Effect.Effect<ChatMessagesRanked, ChatSearchEngineUnavailable>;
    readonly rankSessionIds: (
      request: ChatRankRequest,
    ) => Effect.Effect<readonly string[], ChatSearchEngineUnavailable>;
  }
>()("nodex/main/chat-search/ChatSearchEngine") {}

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
const indexId = (chat: ChatCatalogItem) =>
  chat.binding?.kind === "native"
    ? nativeSearchThreadId(chat.binding.hostId, chat.binding.threadId)
    : chat.threadId;
const preferredProjectOrder = (
  a: ChatCatalogEntry,
  b: ChatCatalogEntry,
  input: Pick<ChatSearchInput, "preferredProjectId">,
) =>
  Number(input.preferredProjectId !== undefined && b.projectId === input.preferredProjectId) -
  Number(input.preferredProjectId !== undefined && a.projectId === input.preferredProjectId);

/** The engine itself, with Runtime history reached through `sessionSearch`. */
export const makeChatSearchEngine = (
  sessionSearch: (
    request: SessionSearchRequest,
  ) => Effect.Effect<SessionSearchPage, ChatSearchEngineUnavailable>,
): Effect.Effect<ChatSearchEngine["Service"], never, Scope.Scope> =>
  Effect.gen(function* () {
    const prepared = yield* Effect.acquireRelease(Effect.sync(prepareChatMetadataIndex), (index) =>
      Effect.sync(index.close),
    );
    let shared: readonly ChatCatalogItem[] = [];
    const catalogOf = (catalog: ChatSearchCatalog) =>
      catalog.kind === "shared"
        ? { entries: shared, prepared: true }
        : { entries: catalog.entries, prepared: false };
    const scoped = (catalog: ChatSearchCatalog, input: ChatMessageSearchInput) => {
      const admitted = catalogOf(catalog);
      return {
        ...admitted,
        entries: admitted.entries.filter(
          (chat) =>
            (input.includeArchived || !chat.archived) &&
            (!input.startedOnly || chat.threadId !== null) &&
            (input.projectId === undefined || chat.projectId === input.projectId),
        ),
      };
    };

    const runtimeMatches = Effect.fn("ChatSearchEngine.runtimeMatches")(function* (
      input: ChatMessageSearchInput,
      admitted: { readonly entries: readonly ChatCatalogItem[] },
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
      const picker =
        input.preferredProjectId === undefined &&
        !admitted.entries.some((chat) => chat.archived) &&
        subjects.length === scope.size
          ? { now, subjects }
          : undefined;
      const cursors = new Set<string>();
      let cursor: string | null = null;
      let incomplete = false;
      let boundRuntime: string | null = null;
      do {
        const page: SessionSearchPage = yield* sessionSearch({
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
            nativeChats.get(fact.threadId) ??
            runtimeChats.get(`${page.runtimeId}\0${fact.threadId}`);
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
        // The Runtime flag describes history coverage. Its cursor tracks ranked matches.
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
              matches.length
                ? { matches, state: { source, state: "partial" } }
                : unavailable(source),
            ),
          ),
        );
      });

    const searchMessages = Effect.fn("ChatSearchEngine.searchMessages")(function* ({
      catalog,
      input,
      now,
    }: ChatMessageSearchRequest) {
      const admitted = scoped(catalog, input);
      using query = compileSearchQuery(input.query);
      const candidates = admitted.prepared
        ? prepared.candidates(input.query, admitted.entries)
        : admitted.entries;
      const catalogMatch = prepareChatCatalog(candidates, query, input.query, now);
      const observedStrong = [...catalogMatch.strongWords];
      const metadata = catalogMatch.facts.flatMap(({ entry, metadata }) => {
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
        new Map(
          catalogMatch.rank(observedStrong).map((fact) => [fact.entry.sessionId, fact] as const),
        );
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
            strongWords: catalogMatch.strongWords,
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
          (match) => input.includeArchived || match.kind !== "metadata" || !match.rank.word,
        ),
      );
      ranked.sort(
        (a, b) =>
          chatArchiveTier(Boolean(a.entry.archived), a.rank.word) -
            chatArchiveTier(Boolean(b.entry.archived), b.rank.word) ||
          preferredProjectOrder(a.entry, b.entry, input) ||
          compareMessageSearchRank(a.rank, b.rank) ||
          a.entry.sessionId.localeCompare(b.entry.sessionId),
      );
      const seen = new Set<string>();
      const distinct = ranked.filter(({ entry }) => {
        if (seen.has(entry.sessionId)) return false;
        seen.add(entry.sessionId);
        return true;
      });
      return {
        matches: distinct.slice(0, input.limit).map(({ render }) => render()),
        sources: sources.map((source) => source.state),
        truncated: distinct.length > input.limit || source.hasMore === true,
      } satisfies ChatMessagesRanked;
    });

    const search = ({ catalog, input, now }: ChatSearchRequest) =>
      Effect.sync((): ChatRanked => {
        const admitted = scoped(catalog, input);
        if (input.instant && input.query && admitted.prepared)
          return prepared.instant(
            input.query,
            admitted.entries,
            now,
            input.limit,
            (a, b) =>
              chatArchiveTier(Boolean(a.archived), true) -
                chatArchiveTier(Boolean(b.archived), true) || preferredProjectOrder(a, b, input),
          );
        const candidates =
          input.query && admitted.prepared
            ? prepared.candidates(input.query, admitted.entries)
            : admitted.entries;
        const ranked = [...rankCatalog(candidates, input.query, now)]
          .filter(
            (match) =>
              !input.instant || !match.rank || (match.rank.word && match.kind === "metadata"),
          )
          .sort(
            (a, b) =>
              chatArchiveTier(Boolean(a.entry.archived), a.rank?.word) -
                chatArchiveTier(Boolean(b.entry.archived), b.rank?.word) ||
              preferredProjectOrder(a.entry, b.entry, input),
          );
        return {
          matches: ranked.slice(0, input.limit).map(({ render }) => render()),
          truncated: ranked.length > input.limit,
        };
      });

    return ChatSearchEngine.of({
      publish: (entries) =>
        Effect.sync(() => {
          prepared.update(entries);
          shared = entries;
        }),
      search,
      searchMessages,
      rankSessionIds: ({ catalog, query, archived, projectId, now }) =>
        Effect.sync(() =>
          rankCatalog(
            catalogOf(catalog).entries.filter(
              (entry) =>
                Boolean(entry.archived) === archived &&
                (projectId === undefined || entry.projectId === projectId),
            ),
            query,
            now,
          ).map(({ entry }) => entry.sessionId),
        ),
    });
  });
