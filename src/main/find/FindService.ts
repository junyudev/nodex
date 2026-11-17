import type { LibraryReadSnapshot } from "../core-client/types";
import type { CoreModules } from "../core-runtime/CoreModules";
import { createHash } from "node:crypto";
import { splitSearchText } from "@nodex/agent-runtime/palette-search";
import { STRONG_RANK_LIMIT } from "@nodex/agent-runtime/orchestration/SessionSearchText";
import * as Effect from "effect/Effect";
import { z } from "zod";
import { CHAT_SEARCH_MAX_LIMIT } from "../../shared/chat-search";
import type { ChatSearchMatch } from "../../shared/chat-search";
import type {
  FindCoverage,
  FindHit,
  FindPhase,
  FindRequest,
  FindResponse,
} from "../../shared/find";
import type { PageSearchResult } from "../../shared/types";
import { chatArchiveTier } from "../chat-search/ChatSearchRanking";
import type { ChatSearch } from "../chat-search/ChatSearch";
import type { LibraryModule } from "../library-application/LibraryModule";

const identity = z.string().trim().min(1).max(256);
export const findRequestSchema = z.strictObject({
  query: z
    .string()
    .trim()
    .refine((query) => Array.from(query).length <= 200),
  kinds: z
    .array(z.enum(["page", "block", "chat"]))
    .min(1)
    .max(3),
  place: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("everywhere") }),
    z.strictObject({ kind: z.literal("project"), projectId: identity }),
  ]),
  limit: z.number().int().min(1).max(160),
  cursor: z.string().max(128).optional(),
  preferredProjectId: identity.optional(),
  recentPageIds: z.array(identity).max(100).optional(),
  startedChatsOnly: z.boolean().optional(),
  excludePageIds: z.array(identity).max(100).optional(),
  dataSourceIds: z.array(identity).max(100).optional(),
});
export const findPhaseSchema = z.enum(["instant", "complete"]);

function pageHit(page: PageSearchResult): FindHit {
  const text = page.textRank ?? null;
  return {
    kind: "page",
    identity: page.pageId,
    title: page.title,
    location: { projectId: page.projectId, label: page.locationLabel },
    evidence: page.matches.map((match) => ({
      field: match.source,
      parts: match.parts,
      ...(match.source === "body"
        ? { anchor: { kind: "block" as const, pageId: page.pageId, blockId: match.blockId } }
        : {}),
    })),
    rank: { text, strong: text !== null && text < 24, ordered: page.ordered ?? false },
    archived: page.archived ?? false,
    page,
  };
}

function chatHit(chatMatch: ChatSearchMatch): FindHit {
  const { chat, rank, titleRanges, hint, excerpt, historyMatch } = chatMatch;
  const raw = rank ? Math.round((1 - rank.wordQuality) * 32) : null;
  const strong = raw !== null && raw < STRONG_RANK_LIMIT;
  // Share the same field positions as Pages: key, ID, title, metadata, body, context/action.
  const text = raw === null ? null : strong ? raw + 8 : raw + 12;
  return {
    kind: "chat",
    identity: chat.sessionId,
    title: chat.title,
    location: { projectId: chat.projectId, label: chat.projectName },
    evidence: [
      ...(titleRanges.length
        ? [{ field: "title", parts: splitSearchText(chat.title, titleRanges) }]
        : []),
      ...(hint ? [{ field: hint.label, parts: splitSearchText(hint.text, hint.ranges) }] : []),
      ...(excerpt
        ? [
            {
              field: "message",
              parts: splitSearchText(excerpt.text, excerpt.ranges),
              ...(historyMatch ? { anchor: { kind: "chat_item" as const, ...historyMatch } } : {}),
            },
          ]
        : []),
    ],
    rank: { text, strong, ordered: !!rank && rank.quality > rank.wordQuality },
    archived: chat.archived ?? false,
    chatMatch,
  };
}

export function findBlockSource(core: CoreModules["Service"]) {
  return (request: FindRequest) =>
    core.library
      .read({
        kind: "project_block_search",
        query: request.query,
        project_id: request.place.kind === "project" ? request.place.projectId : null,
        preferred_project_id: request.preferredProjectId ?? null,
        limit: 100,
      })
      .pipe(
        Effect.map((snapshot) => {
          if (snapshot.value.kind !== "project_block_search")
            throw new Error("Core returned a non-Block search response");
          return snapshot.value;
        }),
      );
}

type BlockSearchResult = Extract<LibraryReadSnapshot["value"], { kind: "project_block_search" }>;
function blockHit(block: BlockSearchResult["items"][number]): FindHit {
  return {
    kind: "block",
    identity: block.block_id,
    pageId: block.page_id,
    title: block.title,
    location: { projectId: block.project_id ?? null, label: block.location_label },
    evidence: [
      {
        field: block.source,
        parts: block.parts,
        anchor: { kind: "block", pageId: block.page_id, blockId: block.block_id },
      },
    ],
    rank: { text: block.text_rank, strong: block.text_rank < 24, ordered: block.ordered },
    archived: block.archived,
  };
}

export const findHitKey = (hit: FindHit): string => `${hit.kind}:${hit.identity}`;
function archiveTier(hit: FindHit): number {
  if (hit.kind === "chat") return chatArchiveTier(hit.archived, hit.chatMatch.rank?.word);
  return hit.archived ? 3 : 0;
}

function placement(a: FindHit, b: FindHit, projectId: string | undefined): number {
  return (
    archiveTier(a) - archiveTier(b) ||
    Number(projectId !== undefined && b.location.projectId === projectId) -
      Number(projectId !== undefined && a.location.projectId === projectId)
  );
}

function compareRank(a: FindHit, b: FindHit): number {
  return (
    (a.rank.text ?? Infinity) - (b.rank.text ?? Infinity) ||
    Number(b.rank.ordered) - Number(a.rank.ordered)
  );
}

// Enrichment may improve evidence and insert newly discovered rows. Keep the relative
// positions of surviving instant rows within their placement group.
function preserveInstantOrder(
  ranked: readonly FindHit[],
  instantKeys: readonly string[],
  preferredProjectId: string | undefined,
): readonly FindHit[] {
  const positions = new Map(instantKeys.map((key, index) => [key, index]));
  const surviving = ranked
    .filter((hit) => positions.has(findHitKey(hit)))
    .sort(
      (a, b) =>
        placement(a, b, preferredProjectId) ||
        positions.get(findHitKey(a))! - positions.get(findHitKey(b))!,
    );
  let next = 0;
  return ranked.map((hit) => (positions.has(findHitKey(hit)) ? surviving[next++] : hit));
}

function windowHits(
  hits: readonly FindHit[],
  request: FindRequest,
  phase: FindPhase,
): Pick<FindResponse, "hits" | "nextCursor" | "truncated"> | null {
  const { cursor, limit: _limit, ...subject } = request;
  const revision = createHash("sha256")
    .update(JSON.stringify([subject, phase, hits.map(findHitKey)]))
    .digest("base64url");
  const [previous, offset] = cursor?.split(".") ?? [revision, "0"];
  const start = Number(offset);
  if (previous !== revision || !Number.isSafeInteger(start) || start < 0 || start > hits.length)
    return null;
  const end = start + request.limit;
  return {
    hits: hits.slice(start, end),
    nextCursor: end < hits.length ? `${revision}.${end}` : null,
    truncated: end < hits.length,
  };
}

type FindSources<R> = Pick<LibraryModule["Service"], "searchPages"> & {
  searchBlocks: ReturnType<typeof findBlockSource>;
  search: (
    input: Parameters<ChatSearch["Service"]["search"]>[0],
  ) => Effect.Effect<Effect.Success<ReturnType<ChatSearch["Service"]["search"]>>, unknown, R>;
  searchMessages: (
    input: Parameters<ChatSearch["Service"]["searchMessages"]>[0],
  ) => Effect.Effect<
    Effect.Success<ReturnType<ChatSearch["Service"]["searchMessages"]>>,
    unknown,
    R
  >;
};

export function makeFindService<R>(sources: FindSources<R>) {
  const candidates = Effect.fn("Find.candidates")(function* (
    request: FindRequest,
    phase: FindPhase,
  ) {
    const instant = phase === "instant";
    const projectId = request.place.kind === "project" ? request.place.projectId : undefined;
    const pageSearch = request.kinds.includes("page")
      ? sources
          .searchPages({
            query: request.query,
            instant,
            projectFilterIds: projectId ? [projectId] : undefined,
            preferredProjectId: request.preferredProjectId,
            recentPageIds: request.recentPageIds ? [...request.recentPageIds] : undefined,
            excludePageIds: request.excludePageIds ? [...request.excludePageIds] : undefined,
            dataSourceIds: request.dataSourceIds ? [...request.dataSourceIds] : undefined,
            limit: 100,
          })
          .pipe(Effect.option)
      : Effect.succeed(null);
    const chatInput = {
      query: request.query,
      projectId,
      preferredProjectId: request.preferredProjectId,
      startedOnly: request.startedChatsOnly,
      includeArchived: true,
      limit: CHAT_SEARCH_MAX_LIMIT,
    };
    const chatSearch = !request.kinds.includes("chat")
      ? Effect.succeed(null)
      : instant || !request.query
        ? sources.search({ ...chatInput, instant }).pipe(Effect.option)
        : sources.searchMessages(chatInput).pipe(Effect.option);
    const wantsBlocks = request.kinds.includes("block");
    const blocksSearch =
      !instant && wantsBlocks
        ? sources.searchBlocks(request).pipe(Effect.option)
        : Effect.succeed(null);
    const [pages, chats, blocks] = yield* Effect.all([pageSearch, chatSearch, blocksSearch], {
      concurrency: 3,
    });
    const blockResult = blocks?._tag === "Some" ? blocks.value : null;
    const pageResult = pages?._tag === "Some" ? pages.value : null;
    const chatResult = chats?._tag === "Some" ? chats.value : null;
    const coverage: FindCoverage[] = [];
    if (pages)
      coverage.push({
        source: "pages",
        state: pageResult?.coverage ?? (pageResult ? "complete" : "unavailable"),
        truncated: pageResult?.truncated,
      });
    if (wantsBlocks)
      coverage.push({
        source: "blocks",
        state: instant ? "pending" : (blockResult?.coverage ?? "unavailable"),
        truncated: blockResult?.truncated,
      });
    if (chats) {
      coverage.push({
        source: "chat_catalog",
        truncated: chatResult?.truncated,
        state: !chatResult
          ? "unavailable"
          : "loading" in chatResult && chatResult.loading
            ? "pending"
            : ("complete" in chatResult && !chatResult.complete) ||
                ("catalogComplete" in chatResult && chatResult.catalogComplete === false)
              ? "partial"
              : "complete",
      });
      if (chatResult && "sources" in chatResult) coverage.push(...chatResult.sources);
      else if (request.query)
        coverage.push({ source: "runtime", state: instant ? "pending" : "unavailable" });
    }
    const hits = [
      ...(pageResult?.results ?? []).map(pageHit),
      ...(chatResult?.matches ?? []).map(chatHit),
      ...(blockResult?.items ?? []).map(blockHit),
    ].sort((a, b) => placement(a, b, request.preferredProjectId) || compareRank(a, b));
    return {
      hits,
      coverage,
      truncated: coverage.some((source) => source.truncated),
    };
  });

  return Effect.fn("Find.search")(function* (
    request: FindRequest,
    phase: FindPhase,
    previousKeys?: readonly string[],
  ) {
    const complete = phase === "complete" && request.query.length > 0 && !previousKeys;
    const [result, earlier] = yield* Effect.all(
      [
        candidates(request, phase),
        complete ? candidates(request, "instant") : Effect.succeed(null),
      ],
      { concurrency: 2 },
    );
    const unavailableKinds = new Set(
      result.coverage.flatMap(({ source, state }) =>
        state !== "unavailable"
          ? []
          : source === "pages"
            ? ["page"]
            : source === "chat_catalog"
              ? ["chat"]
              : [],
      ),
    );
    const recovery =
      earlier ??
      (previousKeys?.length && unavailableKinds.size
        ? yield* candidates(request, "instant")
        : null);
    const retained = recovery?.hits.filter((hit) => unavailableKinds.has(hit.kind)) ?? [];
    const enriched = retained.length
      ? [...result.hits, ...retained].sort(
          (a, b) => placement(a, b, request.preferredProjectId) || compareRank(a, b),
        )
      : result.hits;
    const instantKeys = previousKeys ?? earlier?.hits.map(findHitKey);
    const ranked = instantKeys
      ? preserveInstantOrder(enriched, instantKeys, request.preferredProjectId)
      : enriched;
    const window = windowHits(ranked, request, phase);
    if (!window) return yield* Effect.fail(new Error("Find cursor is stale"));
    const topCandidate =
      !request.cursor && request.query
        ? result.hits.reduce<FindHit | undefined>(
            (best, hit) =>
              !best || (archiveTier(hit) - archiveTier(best) || compareRank(hit, best)) < 0
                ? hit
                : best,
            undefined,
          )
        : undefined;
    const returned = new Set(window.hits.map(findHitKey));
    const omitted = ranked.filter((hit) => !returned.has(findHitKey(hit)));
    return {
      ...window,
      phase,
      coverage: result.coverage.map((source) => {
        const kind =
          source.source === "pages"
            ? "page"
            : source.source === "blocks"
              ? "block"
              : source.source === "chat_catalog"
                ? "chat"
                : null;
        return kind && !request.cursor && omitted.some((hit) => hit.kind === kind)
          ? { ...source, truncated: true }
          : source;
      }),
      topResult: topCandidate?.rank.strong ? topCandidate : undefined,
      truncated: result.truncated || window.truncated,
    } satisfies FindResponse;
  });
}
