import { resolveSessionScope } from "../../shared/nodex-app-tools/session-scope";
import type { components } from "@nodex/core-protocol";
import { createHash } from "node:crypto";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
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
  readonly settled?: boolean;
  readonly snoozed?: boolean;
  /** Internal bounded metadata candidate stream for global ranked search. */
  readonly searchCandidates?: boolean;
  readonly includeSubagents?: boolean;
}

export interface SessionListingSummary {
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
  readonly backend: "codex" | "acp" | "claude" | "opencode" | null;
  readonly status: { readonly status_type: string; readonly active_flags: readonly string[] };
  readonly archived: boolean;
  readonly pinned: boolean;
  readonly recencyAt: number | null;
  readonly createdBy: "user" | "agent" | "system" | null;
  readonly creationSource: string | null;
  readonly createdAt: string;
  readonly latestUserAuthoredMessageAt: string | null;
  readonly activityEvidence?: { readonly at: string; readonly provenance: "user_role" };
  readonly updatedAt: string | null;
  readonly activeRunId: string | null;
  readonly worktreePath: string | null;
  readonly titleRegeneration: CatalogItem["titleRegeneration"];
  readonly latestRunId: string | null;
  readonly runStatus: string | null;
  readonly activityRunStatus: string | null;
  readonly agent: { readonly providerInstanceId: string; readonly model: string } | null;
  readonly runtimeMode: string | null;
  readonly interactionMode: string | null;
  readonly parentThreadId: string | null;
  readonly relationshipToParent: "fork" | "subagent" | null;
  readonly branch: string | null;
  readonly settled: boolean | null;
  readonly settledAt: string | null;
  readonly snoozed: boolean | null;
  readonly snoozedUntil: string | null;
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
const backendOf = (driver: string | null): SessionListingSummary["backend"] =>
  driver === null
    ? null
    : driver === "codex"
      ? "codex"
      : driver === "claudeAgent"
        ? "claude"
        : driver === "opencode"
          ? "opencode"
          : "acp";

const placementOf = (item: ListingItem): SessionListingSummary["placement"] => {
  if (item.task.session.pinned) return { kind: "pinned", source: "session" };
  if (item.direct_section_id)
    return { kind: "section", source: "session", sectionId: item.direct_section_id };
  if (item.project_section_id)
    return { kind: "section", source: "project", sectionId: item.project_section_id };
  if (item.project_pinned) return { kind: "pinned", source: "project" };
  return { kind: "default", source: item.task.session.project_id ? "project" : "session" };
};
export const summaryOf = (item: ListingItem, runtime?: CatalogItem): SessionListingSummary => ({
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
  backend: runtime
    ? backendOf(runtime.providerDriver)
    : (item.task.thread?.backend_binding.kind ?? null),
  status: runtime
    ? { status_type: runtime.status, active_flags: runtime.activeFlags }
    : (item.task.thread?.status ?? { status_type: "idle", active_flags: [] }),
  archived: item.task.session.archived,
  pinned: item.task.session.pinned,
  recencyAt: runtime
    ? runtime.recencyAt === null
      ? null
      : Date.parse(runtime.recencyAt)
    : (item.task.thread?.recency_at ?? null),
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
  titleRegeneration: runtime?.titleRegeneration ?? null,
  latestRunId: runtime?.latestRunId ?? null,
  runStatus: runtime?.runStatus ?? null,
  activityRunStatus: runtime?.activityRunStatus ?? null,
  agent: runtime
    ? { providerInstanceId: runtime.providerInstanceId, model: runtime.model }
    : item.task.thread?.model_id
      ? {
          providerInstanceId: item.task.thread.backend_binding.kind,
          model: item.task.thread.model_id,
        }
      : null,
  runtimeMode: runtime?.runtimeMode ?? null,
  interactionMode: runtime?.interactionMode ?? null,
  parentThreadId: runtime?.parentThreadId ?? item.task.thread?.parent_thread_id ?? null,
  relationshipToParent:
    runtime?.relationshipToParent ?? (item.task.thread?.forked_from_id ? "fork" : null),
  branch: runtime?.branch ?? null,
  settled: runtime?.settled ?? null,
  settledAt: runtime?.settledAt ?? null,
  snoozed: runtime?.snoozed ?? null,
  snoozedUntil: runtime?.snoozedUntil ?? null,
  pullRequests: runtime?.pullRequests ?? [],
  itemCount: runtime?.itemCount ?? null,
  itemCountCoverage: runtime?.itemCountCoverage ?? "unavailable",
  metadataCoverage: runtime ? "complete" : "partial",
  placement: placementOf(item),
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
  if (input.settled !== undefined && session.settled !== input.settled) return false;
  if (input.snoozed !== undefined && session.snoozed !== input.snoozed) return false;
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
  settled: Schema.NullOr(Schema.Boolean),
  snoozed: Schema.NullOr(Schema.Boolean),
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
) {
  const empty = emptyPage("core", position.core, position.coreDone);
  if (position.coreDone) return empty;
  const result = yield* core.workspace
    .read(
      {
        kind: "session_window",
        archived: input.archived,
        native_only: true,
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
    const summary = summaryOf(item);
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
    frontier: last
      ? (last.task.thread?.recency_at ?? Date.parse(last.task.session.created_at))
      : null,
  } satisfies SourcePage;
});

/** Runtime rows are admitted only by their exact, current Core Session binding and placement. */
const readRuntime = Effect.fn("SessionDiscovery.runtime")(function* (
  { core, sessionCatalog }: Dependencies,
  input: SessionDiscoveryInput,
  position: Position,
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
  const placement = yield* core.workspace
    .read(
      {
        kind: "session_window",
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
    if (bound === undefined || !matches(summaryOf(bound, item), input)) {
      if (candidates.length === 0) prefix = item.cursor;
      continue;
    }
    candidates.push({
      source: "runtime",
      summary: summaryOf(bound, item),
      cursor: item.cursor,
      sortAt: Date.parse(item.recencyAt ?? item.createdAt),
      stableId: item.threadId,
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
          settled: input.settled ?? null,
          snoozed: input.snoozed ?? null,
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
      [readNative(dependencies.core, input, position), readRuntime(dependencies, input, position)],
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
