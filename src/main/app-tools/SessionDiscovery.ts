import * as Clock from "effect/Clock";
import {
  CHAT_ATTENTION_LANES,
  compareChatAttention,
  type ChatAttentionLane,
} from "../../shared/chat-attention-lane";
import type { SessionActivity } from "../agent-runtime/AgentRuntimeSessionActivity";
import { projectSessionAttention, type SessionAttention } from "./SessionAttention";
import { resolveSessionScope } from "../../shared/nodex-app-tools/session-scope";
import type { components } from "@nodex/core-protocol";
import { createHash } from "node:crypto";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { ThreadActiveFlag } from "@nodex/codex-app-server-protocol/v2";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CoreModules } from "../core-runtime/CoreModules";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { SESSION_HISTORY_CURSOR_MAX_CHARS } from "../../shared/nodex-app-tools/session-history";

type ListingItem =
  components["schemas"]["CollectionWindow_ProjectWorkspaceSessionListingItem"]["items"][number];
type CatalogPage = AgentRuntimeOperations["sessions.catalog"]["output"];
type CatalogInput = AgentRuntimeOperations["sessions.catalog"]["input"];
type CatalogItem = CatalogPage["items"][number];

export interface SessionDiscoveryInput {
  readonly archived: boolean;
  readonly scope?: "project" | "profile";
  readonly projectlessOnly?: boolean;
  readonly limit: number;
  readonly cursor?: string;
  readonly projectId?: string;
  readonly query?: string;
  readonly statuses?: readonly string[];
  readonly lanes?: readonly ChatAttentionLane[];
  readonly order?: "recency" | "attention";
  /** Internal bounded metadata candidate stream for global ranked search. */
  readonly searchCandidates?: boolean;
  readonly includeSubagents?: boolean;
}

interface SessionListingMetadata {
  readonly sessionId: string;
  readonly execution: { readonly threadId: string } | null;
  readonly executionTitle: string | null;
  readonly binding:
    | { readonly kind: "runtime"; readonly runtimeId: string; readonly threadId: string }
    | { readonly kind: "native"; readonly hostId: string; readonly threadId: string }
    | null;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly opens: {
    readonly openedAt: number;
    readonly score: number;
    readonly picks: readonly never[];
  } | null;
  readonly threadId: string | null;
  readonly title: string;
  readonly preview: string;
  readonly backend: string | null;
  readonly status: {
    readonly status_type: string;
    readonly active_flags: readonly ThreadActiveFlag[];
  };
  readonly archived: boolean;
  readonly recencyAt: number | null;
  readonly createdBy: "user" | "agent" | "system" | null;
  readonly creationSource: string | null;
  readonly createdAt: string;
  readonly latestUserAuthoredMessageAt: string | null;
  readonly activityEvidence?: { readonly at: string; readonly provenance: "user_role" };
  readonly updatedAt: string | null;
  readonly activeRunId: string | null;
  readonly worktreePath: string | null;
  readonly latestRunId: string | null;
  readonly runStatus: string | null;
  readonly activityRunStatus: string | null;
  readonly agent: { readonly providerInstanceId: string; readonly model: string } | null;
  readonly runtimeMode: string | null;
  readonly interactionMode: string | null;
  readonly parentThreadId: string | null;
  readonly relationshipToParent: "fork" | "subagent" | null;
  readonly branch: string | null;
  readonly pullRequests: CatalogItem["pullRequests"];
  readonly itemCount: number | null;
  readonly itemCountCoverage: "complete" | "local" | "unavailable";
  readonly metadataCoverage: "complete" | "partial";
  readonly placement: {
    readonly kind: "pinned" | "section" | "default";
    readonly source: "session" | "project";
    readonly sectionId?: string;
  };
}

export interface SessionListingSummary extends SessionListingMetadata {
  readonly attention: SessionAttention;
}

export interface SessionDiscoveryResult {
  readonly sessions: readonly SessionListingSummary[];
  readonly nextCursor: string | null;
  readonly projectionRevision: number;
  readonly searchRevision: number;
  readonly sources: readonly {
    readonly source: "core" | "runtime";
    readonly availability: "available" | "unavailable";
    readonly reason?: string;
  }[];
  /** Internal byte-budget continuation coordinates; never expose this array as tool content. */
  readonly entryCursors: readonly string[];
}

export class SessionDiscoveryError extends Schema.TaggedError<SessionDiscoveryError>()(
  "SessionDiscoveryError",
  {
    reason: Schema.Literals(["invalid_cursor", "cursor_stale", "source_limit", "unavailable"]),
    cause: Schema.Defect(),
  },
) {}

interface Dependencies {
  readonly core: CoreModules["Service"];
  readonly sessionActivity?: Effect.Effect<ReadonlyMap<string, SessionActivity>>;
  readonly sessionCatalog?: (
    input: CatalogInput,
  ) => Effect.Effect<CatalogPage & { readonly runtimeId: string | null }, unknown>;
}

const Cursor = Schema.Struct({
  version: Schema.Literal(1),
  scope: Schema.String,
  core: Schema.NullOr(Schema.String),
  runtime: Schema.NullOr(Schema.String),
  runtimeId: Schema.NullOr(Schema.String),
  coreDone: Schema.Boolean,
  runtimeDone: Schema.Boolean,
});
type Position = typeof Cursor.Type;
const decodePosition = Schema.decodeEffect(Schema.fromJsonString(Cursor));
const encodePosition = Schema.encodeSync(Schema.fromJsonString(Cursor));
const encode = (position: Position) =>
  `nxd1.${Buffer.from(encodePosition(position)).toString("base64url")}`;

const placementOf = (item: ListingItem): SessionListingSummary["placement"] => {
  if (item.task.session.pinned) return { kind: "pinned", source: "session" };
  if (item.direct_section_id)
    return { kind: "section", source: "session", sectionId: item.direct_section_id };
  if (item.project_section_id)
    return { kind: "section", source: "project", sectionId: item.project_section_id };
  if (item.project_pinned) return { kind: "pinned", source: "project" };
  return { kind: "default", source: item.task.session.project_id ? "project" : "session" };
};
interface LiveAttention {
  readonly now: number;
  readonly bySession: ReadonlyMap<string, SessionActivity>;
}

const catalogAttentionStatus = (runtime: CatalogItem) => ({
  status_type: ["preparing", "starting", "running"].includes(
    runtime.activityRunStatus ?? runtime.runStatus ?? "",
  )
    ? "active"
    : "idle",
  active_flags: runtime.activeFlags,
});

export const summaryOf = (item: ListingItem, runtime?: CatalogItem): SessionListingMetadata => ({
  sessionId: item.task.session.id,
  execution: runtime
    ? { threadId: runtime.threadId }
    : item.task.session.execution_ref
      ? { threadId: item.task.session.execution_ref.thread_id }
      : null,
  executionTitle: runtime?.relationshipToParent === "subagent" ? runtime.title : null,
  binding: item.task.session.execution_ref
    ? {
        kind: "runtime",
        runtimeId: item.task.session.execution_ref.runtime_id,
        threadId: item.task.session.execution_ref.thread_id,
      }
    : item.task.thread
      ? {
          kind: "native",
          hostId: item.task.thread.execution_host_id,
          threadId: item.task.thread.thread_id,
        }
      : null,
  projectId: item.task.session.project_id ?? null,
  projectName: item.project_name ?? null,
  opens: item.opens ? { openedAt: item.opens.opened_at, score: item.opens.score, picks: [] } : null,
  threadId: runtime?.threadId ?? item.task.thread?.thread_id ?? null,
  title: item.task.session.display_title,
  preview: runtime?.preview ?? item.task.thread?.thread_preview ?? "",
  backend: runtime ? runtime.providerDriver : (item.task.thread?.backend_binding.driver ?? null),
  status: runtime
    ? { status_type: runtime.status, active_flags: runtime.activeFlags }
    : (item.task.thread?.status ?? { status_type: "idle", active_flags: [] }),
  archived: item.task.session.archived,
  recencyAt: runtime
    ? runtime.recencyAt === null
      ? null
      : Date.parse(runtime.recencyAt)
    : item.task.session.activity_at,
  createdBy: runtime?.createdBy ?? null,
  creationSource: runtime?.creationSource ?? item.task.thread?.thread_source ?? null,
  createdAt: runtime?.createdAt ?? item.task.session.created_at,
  latestUserAuthoredMessageAt: runtime?.latestUserAuthoredMessageAt ?? null,
  updatedAt:
    runtime?.updatedAt ??
    (typeof item.task.thread?.updated_at === "number"
      ? new Date(item.task.thread.updated_at).toISOString()
      : null),
  activeRunId: runtime?.activeRunId ?? null,
  worktreePath: runtime?.worktreePath ?? item.task.thread?.managed_worktree_path ?? null,
  latestRunId: runtime?.latestRunId ?? null,
  runStatus: runtime?.runStatus ?? null,
  activityRunStatus: runtime?.activityRunStatus ?? null,
  agent: runtime
    ? { providerInstanceId: runtime.providerInstanceId, model: runtime.model }
    : item.task.thread?.model_id
      ? {
          providerInstanceId: item.task.thread.backend_binding.instanceId,
          model: item.task.thread.model_id,
        }
      : null,
  runtimeMode: runtime?.runtimeMode ?? null,
  interactionMode: runtime?.interactionMode ?? null,
  parentThreadId: runtime?.parentThreadId ?? item.task.thread?.parent_thread_id ?? null,
  relationshipToParent:
    runtime?.relationshipToParent ?? (item.task.thread?.forked_from_id ? "fork" : null),
  branch: runtime?.branch ?? null,
  pullRequests: runtime?.pullRequests ?? [],
  itemCount: runtime?.itemCount ?? null,
  itemCountCoverage: runtime?.itemCountCoverage ?? "unavailable",
  metadataCoverage: runtime ? "complete" : "partial",
  placement: placementOf(item),
});

const summarizeCandidate = (
  item: ListingItem,
  live: LiveAttention,
  runtime?: CatalogItem,
): SessionListingSummary => ({
  ...summaryOf(item, runtime),
  attention: projectSessionAttention(
    item.task.session,
    item.member_requests ?? undefined,
    !runtime
      ? item.task.thread?.status
      : runtime.relationshipToParent === "subagent"
        ? undefined
        : catalogAttentionStatus(runtime),
    live.bySession.get(item.task.session.id),
    live.now,
  ),
});

const statusOf = (
  details: AgentRuntimeOperations["sessions.metadata"]["output"][number],
): "active" | "idle" | "systemError" => {
  const status = details.activityRunStatus ?? details.runStatus;
  if (status === "failed") return "systemError";
  return ["preparing", "starting", "running", "waiting"].includes(status ?? "") ? "active" : "idle";
};
export const withSessionMetadata = (
  session: SessionListingMetadata,
  details: AgentRuntimeOperations["sessions.metadata"]["output"][number],
): SessionListingMetadata => ({
  ...session,
  threadId: details.threadId,
  preview: details.preview,
  backend: details.providerDriver,
  recencyAt: details.recencyAt === null ? null : Date.parse(details.recencyAt),
  status: { status_type: statusOf(details), active_flags: details.activeFlags },
  createdBy: details.createdBy,
  creationSource: details.creationSource,
  createdAt: details.createdAt,
  latestUserAuthoredMessageAt: details.latestUserAuthoredMessageAt,
  updatedAt: details.updatedAt,
  activeRunId: details.activeRunId,
  worktreePath: details.worktreePath,
  latestRunId: details.latestRunId,
  runStatus: details.runStatus,
  activityRunStatus: details.activityRunStatus,
  runtimeMode: details.runtimeMode,
  interactionMode: details.interactionMode,
  parentThreadId: details.parentThreadId,
  relationshipToParent: details.relationshipToParent,
  branch: details.branch,
  pullRequests: details.pullRequests,
  itemCount: details.itemCount,
  itemCountCoverage: details.itemCountCoverage,
  agent:
    details.providerInstanceId === null || details.model === null
      ? null
      : { providerInstanceId: details.providerInstanceId, model: details.model },
  metadataCoverage: "complete",
});

const matches = (session: SessionListingSummary, input: SessionDiscoveryInput) => {
  if (input.projectlessOnly && session.projectId !== null) return false;
  if (
    input.statuses &&
    !input.statuses.includes(session.status.status_type) &&
    (session.runStatus === null || !input.statuses.includes(session.runStatus)) &&
    (session.activityRunStatus === null || !input.statuses.includes(session.activityRunStatus))
  )
    return false;
  if (
    input.lanes &&
    (session.attention.lane === null || !input.lanes.includes(session.attention.lane))
  )
    return false;
  if (input.searchCandidates || !input.query) return true;
  const needle = input.query.trim().toLowerCase();
  return (
    session.title.toLowerCase().includes(needle) ||
    session.preview.toLowerCase().includes(needle) ||
    (session.executionTitle?.toLowerCase().includes(needle) ?? false)
  );
};

interface Candidate {
  readonly source: "core" | "runtime";
  readonly summary: SessionListingSummary;
  readonly sortAt: number;
  readonly stableId: string;
  readonly pinnedOrder: number | null;
  readonly cursor: string;
}

interface SourcePage {
  readonly source: "core" | "runtime";
  readonly candidates: readonly Candidate[];
  readonly availability: "available" | "unavailable";
  readonly reason?: string;
  readonly revision: number;
  readonly searchRevision: number;
  readonly last: string | null;
  readonly lastEligible: string | null;
  readonly hasMore: boolean;
  readonly frontier: number | null;
  readonly position: string | null;
  readonly done: boolean;
  readonly runtimeId?: string | null;
}
const emptyPage = (
  source: SourcePage["source"],
  position: string | null,
  done: boolean,
): SourcePage => ({
  source,
  candidates: [],
  availability: "available",
  revision: 0,
  searchRevision: 0,
  last: null,
  lastEligible: null,
  hasMore: false,
  frontier: null,
  position,
  done,
});
const unavailable = (page: SourcePage, reason: string): SourcePage => ({
  ...page,
  availability: "unavailable",
  reason,
});
const Scope = Schema.Struct({
  profileId: Schema.NullOr(Schema.String),
  storeEpoch: Schema.NullOr(Schema.String),
  archived: Schema.Boolean,
  projectId: Schema.NullOr(Schema.String),
  query: Schema.String,
  statuses: Schema.Array(Schema.String),
  lanes: Schema.NullOr(Schema.Array(Schema.Literals(CHAT_ATTENTION_LANES))),
  order: Schema.Literals(["recency", "attention"]),
  searchCandidates: Schema.Boolean,
  includeSubagents: Schema.Boolean,
  projectlessOnly: Schema.Boolean,
});
const encodeScope = Schema.encodeSync(Schema.fromJsonString(Scope));

/** Core's source includes native conversations and Threadless drafts. */
const readNative = Effect.fn("SessionDiscovery.native")(function* (
  core: Dependencies["core"],
  input: SessionDiscoveryInput,
  position: Position,
  live: LiveAttention,
) {
  const empty = emptyPage("core", position.core, position.coreDone);
  if (position.coreDone) return empty;
  const provenance = yield* CoreApplicationAgent;
  const result = yield* core.workspace
    .read(
      {
        kind: "session_window",
        ...(provenance ? { provenance } : {}),
        archived: input.archived,
        native_only: true,
        ...(input.order === "attention" ? { order: "identity" as const } : {}),
        ...(input.projectlessOnly ? { projectless_only: true } : {}),
        ...(input.projectId === undefined ? {} : { project_id: input.projectId }),
        ...(input.query === undefined || input.searchCandidates ? {} : { query: input.query }),
        window: { ...(position.core === null ? {} : { after: position.core }), first: 100 },
      },
      { deadlineMs: 10_000 },
    )
    .pipe(Effect.result);
  if (result._tag === "Failure" || result.success.value.kind !== "session_window")
    return unavailable(empty, "Session catalog is unavailable");
  const window = result.success.value.sessions;
  const candidates: Candidate[] = [];
  let prefix = position.core;
  for (const item of window.items) {
    const summary = summarizeCandidate(item, live);
    if (!matches(summary, input)) {
      if (candidates.length === 0) prefix = item.cursor;
      continue;
    }
    candidates.push({
      source: "core",
      summary,
      cursor: item.cursor,
      sortAt: item.task.thread?.recency_at ?? Date.parse(item.task.session.created_at),
      stableId: item.task.session.id,
      pinnedOrder: item.task.session.pinned_order ?? null,
    });
  }
  const last = window.items.at(-1);
  return {
    ...empty,
    candidates,
    position: prefix,
    revision: window.authority.projection_revision,
    searchRevision: result.success.value.search_revision,
    last: last?.cursor ?? null,
    lastEligible: candidates.at(-1)?.cursor ?? null,
    hasMore: window.next_cursor !== null,
    done: candidates.length === 0 && window.next_cursor === null,
    frontier: last?.task.session.activity_at ?? null,
  } satisfies SourcePage;
});

/** Runtime rows are admitted only by their exact, current Core Session binding and placement. */
const readRuntime = Effect.fn("SessionDiscovery.runtime")(function* (
  { core, sessionCatalog }: Dependencies,
  input: SessionDiscoveryInput,
  position: Position,
  live: LiveAttention,
) {
  const empty = emptyPage(
    "runtime",
    position.runtime,
    position.runtimeDone || sessionCatalog === undefined,
  );
  if (empty.done || sessionCatalog === undefined) return empty;
  const result = yield* sessionCatalog({
    ...(position.runtime === null ? {} : { cursor: position.runtime }),
    includeSubagents: !input.searchCandidates && (input.includeSubagents ?? true),
    limit: 100,
  }).pipe(Effect.result);
  if (result._tag === "Failure") return unavailable(empty, "Execution catalog is unavailable");
  const page = result.success;
  if (position.runtimeId !== null && page.runtimeId !== position.runtimeId)
    return yield* new SessionDiscoveryError({
      reason: "invalid_cursor",
      cause: new Error("Session cursor belongs to another execution store"),
    });
  if (page.runtimeId === null || page.items.length === 0)
    return { ...empty, done: true, runtimeId: page.runtimeId };
  const provenance = yield* CoreApplicationAgent;
  const placement = yield* core.workspace
    .read(
      {
        kind: "session_window",
        ...(provenance ? { provenance } : {}),
        archived: input.archived,
        ...(input.projectId === undefined ? {} : { project_id: input.projectId }),
        execution_refs: page.items.map((item) => ({
          runtime_id: page.runtimeId!,
          thread_id: item.rootThreadId ?? item.threadId,
        })),
        window: { first: 100 },
      },
      { deadlineMs: 10_000 },
    )
    .pipe(Effect.result);
  if (placement._tag === "Failure" || placement.success.value.kind !== "session_window")
    return unavailable(empty, "Session placement is unavailable");
  const window = placement.success.value.sessions;
  const byThread = new Map(
    window.items.map((item) => [item.task.session.execution_ref?.thread_id, item]),
  );
  const candidates: Candidate[] = [];
  let prefix = position.runtime;
  for (const item of page.items) {
    const bound = byThread.get(item.rootThreadId ?? item.threadId);
    const summary = bound && summarizeCandidate(bound, live, item);
    if (summary === undefined || !matches(summary, input)) {
      if (candidates.length === 0) prefix = item.cursor;
      continue;
    }
    candidates.push({
      source: "runtime",
      summary,
      cursor: item.cursor,
      sortAt: Date.parse(item.recencyAt ?? item.createdAt),
      stableId: item.threadId,
      pinnedOrder: bound?.task.session.pinned_order ?? null,
    });
  }
  const last = page.items.at(-1)!;
  return {
    ...empty,
    candidates,
    runtimeId: page.runtimeId,
    revision: window.authority.projection_revision,
    searchRevision: placement.success.value.search_revision,
    last: last.cursor,
    lastEligible: candidates.at(-1)?.cursor ?? null,
    hasMore: page.nextCursor !== null,
    frontier: Date.parse(last.recencyAt ?? last.createdAt),
    position: prefix,
    done: candidates.length === 0 && page.nextCursor === null,
  } satisfies SourcePage;
});

const AttentionCursor = Schema.Struct({
  scope: Schema.String,
  ordering: Schema.String,
  offset: Schema.Int,
});
const decodeAttentionCursor = Schema.decodeEffect(Schema.fromJsonString(AttentionCursor));
const encodeAttentionCursor = Schema.encodeSync(Schema.fromJsonString(AttentionCursor));
const ATTENTION_WINDOW_LIMIT = 100;

/** A recency frontier cannot prove anything about an unseen chat's attention rank. */
const collectAttentionSource = Effect.fn("SessionDiscovery.attentionSource")(function* (
  start: Position,
  readPage: (position: Position) => Effect.Effect<SourcePage, SessionDiscoveryError>,
) {
  let position = start;
  const candidates = new Map<string, Candidate>();
  for (let pageIndex = 0; pageIndex < ATTENTION_WINDOW_LIMIT; pageIndex += 1) {
    const page = yield* readPage(position);
    for (const candidate of page.candidates) candidates.set(candidate.stableId, candidate);
    if (!page.hasMore)
      return {
        ...page,
        candidates: [...candidates.values()],
        runtimeId: page.runtimeId ?? position.runtimeId,
      };
    const cursor = page.source === "core" ? position.core : position.runtime;
    if (page.last === null || page.last === cursor)
      return yield* new SessionDiscoveryError({
        reason: "cursor_stale",
        cause: new Error("Session source did not advance"),
      });
    position =
      page.source === "core"
        ? { ...position, core: page.last }
        : { ...position, runtime: page.last, runtimeId: page.runtimeId ?? null };
  }
  return yield* new SessionDiscoveryError({
    reason: "source_limit",
    cause: new Error("Too many Sessions to sort by attention. Narrow the Project or query."),
  });
});

const attentionPlacement = ({ summary, pinnedOrder }: Candidate) =>
  summary.attention.lane === null
    ? []
    : [
        {
          lane: summary.attention.lane,
          id: summary.sessionId,
          attentionAt: summary.attention.attentionAt,
          snoozedUntil: summary.attention.snoozedUntil,
          settledAt:
            summary.attention.settledAt === null ? null : Date.parse(summary.attention.settledAt),
          stopped: summary.attention.waitingOn !== null,
          pinnedOrder,
        },
      ];

const readAttentionPage = Effect.fn("SessionDiscovery.attentionPage")(function* (
  dependencies: Dependencies,
  input: SessionDiscoveryInput,
  start: Position,
  live: LiveAttention,
) {
  const { scope } = start;
  let cursor: typeof AttentionCursor.Type | null = null;
  if (input.cursor !== undefined) {
    if (!input.cursor.startsWith("nxa1.") || input.cursor.length > SESSION_HISTORY_CURSOR_MAX_CHARS)
      return yield* new SessionDiscoveryError({
        reason: "invalid_cursor",
        cause: new Error("Attention cursor is malformed"),
      });
    cursor = yield* decodeAttentionCursor(
      Buffer.from(input.cursor.slice(5), "base64url").toString("utf8"),
    ).pipe(
      Effect.mapError((cause) => new SessionDiscoveryError({ reason: "invalid_cursor", cause })),
    );
    if (cursor.scope !== scope || cursor.offset <= 0)
      return yield* new SessionDiscoveryError({
        reason: "invalid_cursor",
        cause: new Error("Attention cursor belongs to another query"),
      });
  }
  const [native, runtime] = yield* Effect.all(
    [
      collectAttentionSource(start, (position) =>
        readNative(dependencies.core, input, position, live),
      ),
      collectAttentionSource(start, (position) => readRuntime(dependencies, input, position, live)),
    ],
    { concurrency: 2 },
  );
  const ordered = [...native.candidates, ...runtime.candidates]
    .flatMap((candidate) =>
      attentionPlacement(candidate).map((placement) => ({
        ...placement,
        candidate,
      })),
    )
    .sort(
      (left, right) =>
        compareChatAttention(left, right) ||
        left.id.localeCompare(right.id) ||
        left.candidate.stableId.localeCompare(right.candidate.stableId),
    );
  const sources = [native, runtime].map(({ source, availability, reason }) => ({
    source,
    availability,
    ...(reason === undefined ? {} : { reason }),
  }));
  // Cursor offsets are safe only while the same rows still occupy the same positions.
  const ordering = createHash("sha256")
    .update(
      JSON.stringify([
        sources,
        runtime.runtimeId ?? null,
        ordered.map(({ lane, id, candidate }) => [lane, id, candidate.stableId]),
      ]),
    )
    .digest("base64url");
  if (cursor && (cursor.ordering !== ordering || cursor.offset >= ordered.length))
    return yield* new SessionDiscoveryError({
      reason: "cursor_stale",
      cause: new Error("Session attention order changed. Start a new listing."),
    });
  const offset = cursor?.offset ?? 0;
  const sessions = ordered
    .slice(offset, offset + input.limit)
    .map(({ candidate }) => candidate.summary);
  const entryCursors = sessions.map(
    (_, index) =>
      `nxa1.${Buffer.from(encodeAttentionCursor({ scope, ordering, offset: offset + index + 1 })).toString("base64url")}`,
  );
  return {
    sessions,
    entryCursors,
    projectionRevision: Math.max(native.revision, runtime.revision),
    searchRevision: Math.max(native.searchRevision, runtime.searchRevision),
    sources,
    nextCursor: offset + sessions.length < ordered.length ? (entryCursors.at(-1) ?? null) : null,
  } satisfies SessionDiscoveryResult;
});

/**
 * Merges bounded, owner-authored keyset streams. Core validates current placement for every
 * Runtime candidate; discovery never copies Runtime history facts into Core or hydrates bodies.
 */
export const make = (dependencies: Dependencies) =>
  Effect.fn("SessionDiscovery.list")(function* (input: SessionDiscoveryInput) {
    const provenance = yield* CoreApplicationAgent;
    if (input.scope !== undefined)
      input = {
        ...input,
        ...resolveSessionScope(input, provenance?.authority.actor_project_id ?? null),
      };
    const scope = createHash("sha256")
      .update(
        encodeScope({
          profileId: provenance?.profile_id ?? null,
          storeEpoch: provenance?.authority?.store_epoch ?? null,
          archived: input.archived,
          projectId: input.projectId ?? null,
          query: input.query?.trim() ?? "",
          statuses: [...(input.statuses ?? [])].sort(),
          lanes: input.lanes === undefined ? null : [...new Set(input.lanes)].sort(),
          order: input.order ?? "recency",
          searchCandidates: input.searchCandidates ?? false,
          includeSubagents: !input.searchCandidates && (input.includeSubagents ?? true),
          projectlessOnly: input.projectlessOnly ?? false,
        }),
      )
      .digest("base64url");
    let position: Position = {
      version: 1,
      scope,
      core: null,
      runtime: null,
      runtimeId: null,
      coreDone: false,
      runtimeDone: dependencies.sessionCatalog === undefined,
    };
    const live = {
      now: yield* Clock.currentTimeMillis,
      bySession: yield* (
        dependencies.sessionActivity ?? Effect.succeed(new Map<string, SessionActivity>())
      ),
    };
    if (input.order === "attention")
      return yield* readAttentionPage(dependencies, input, position, live);
    if (input.cursor !== undefined) {
      if (
        !input.cursor.startsWith("nxd1.") ||
        input.cursor.length > SESSION_HISTORY_CURSOR_MAX_CHARS
      )
        return yield* new SessionDiscoveryError({
          reason: "invalid_cursor",
          cause: new Error("Session cursor is malformed"),
        });
      position = yield* decodePosition(
        Buffer.from(input.cursor.slice(5), "base64url").toString("utf8"),
      ).pipe(
        Effect.mapError((cause) => new SessionDiscoveryError({ reason: "invalid_cursor", cause })),
      );
      if (position.scope !== scope)
        return yield* new SessionDiscoveryError({
          reason: "invalid_cursor",
          cause: new Error("Session cursor belongs to another query"),
        });
    }
    const [native, runtime] = yield* Effect.all(
      [
        readNative(dependencies.core, input, position, live),
        readRuntime(dependencies, input, position, live),
      ],
      { concurrency: 2 },
    );
    position = {
      ...position,
      core: native.position,
      coreDone: native.done,
      runtime: runtime.position,
      runtimeId: runtime.runtimeId ?? position.runtimeId,
      runtimeDone: runtime.done,
    };
    // A sparse Runtime page establishes a frontier. Older native rows wait until the next
    // Runtime window proves they cannot be overtaken by a matching Session.
    const ordered = [...native.candidates, ...runtime.candidates]
      .filter(
        (item) =>
          (item.source === "runtime" ||
            !runtime.hasMore ||
            runtime.frontier === null ||
            item.sortAt >= runtime.frontier) &&
          (item.source === "core" ||
            !native.hasMore ||
            native.frontier === null ||
            item.sortAt > native.frontier),
      )
      .sort(
        (left, right) =>
          right.sortAt - left.sortAt ||
          left.source.localeCompare(right.source) ||
          left.stableId.localeCompare(right.stableId),
      );
    const sessions: SessionListingSummary[] = [];
    const entryCursors: string[] = [];
    for (const item of ordered.slice(0, input.limit)) {
      position =
        item.source === "core"
          ? {
              ...position,
              core: item.cursor === native.lastEligible ? native.last : item.cursor,
              coreDone: item.cursor === native.lastEligible && !native.hasMore,
            }
          : {
              ...position,
              runtime: item.cursor === runtime.lastEligible ? runtime.last : item.cursor,
              runtimeDone: item.cursor === runtime.lastEligible && !runtime.hasMore,
            };
      sessions.push(item.summary);
      entryCursors.push(encode(position));
    }
    return {
      sessions,
      entryCursors,
      projectionRevision: Math.max(native.revision, runtime.revision),
      searchRevision: Math.max(native.searchRevision, runtime.searchRevision),
      sources: [native, runtime].map(({ source, availability, reason }) => ({
        source,
        availability,
        ...(reason === undefined ? {} : { reason }),
      })),
      nextCursor: position.coreDone && position.runtimeDone ? null : encode(position),
    } satisfies SessionDiscoveryResult;
  });
