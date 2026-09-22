import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import {
  discoverCodexSubagentDescendants,
  type CodexSubagentDiscoverySnapshot,
} from "./CodexSubagentDiscovery";
import { projectCodexConversationTurn } from "./CodexConversationSnapshotProjection";
import type { SubagentConversation } from "../../shared/codex-subagent-row-model";
import { conversationFollowerRequest } from "../../shared/codex-thread-follower-request";
import type { CodexCanonicalConversationState } from "../../shared/types";
import { collectCodexSubagentInteractionReferences } from "../../shared/codex-subagent-interaction";
import { conversationTurnsWithOverlay } from "../../shared/codex-conversation-state/codex-conversation-state";
import { createHash, randomUUID } from "node:crypto";
import type { Thread } from "@nodex/codex-app-server-protocol/v2";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { isCodexAgentBackendBinding } from "../../shared/agent-backend";
import { cappedApproximateValueBytes } from "../../shared/codex-bounded-value-size";
import {
  CODEX_SUBAGENT_DISCOVERY_PAGE_LIMIT,
  CODEX_SUBAGENT_OVERVIEW_INITIAL_ACTIVE_LIMIT,
  CODEX_SUBAGENT_OVERVIEW_INITIAL_DONE_LIMIT,
  projectCodexSubagentThreadStatus,
  selectCodexSubagentStatusEvidence,
} from "../../shared/codex-subagent-overview";
import { extractCodexThreadSubagentMetadata } from "../../shared/codex-subagent-metadata";
import type {
  CodexSelectedSubagentHydrateInput,
  CodexSelectedSubagentHydrateResult,
  CodexSubagentOverviewReadInput,
  CodexSubagentOverviewWindow,
} from "../../shared/types";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway, codexGatewayGenerationFence } from "../codex-runtime/CodexGateway";
import { projectCodexGatewayThreadReadThread } from "../codex-runtime/CodexGatewayProtocolProjection";
import { CoreModules } from "../core-runtime/CoreModules";
import { createOperationId } from "../core-runtime/operation-identity";
import type { CodexServerNotification } from "../codex-runtime/CodexApplicationProtocol";
import { projectCodexThreadDirectoryMaterialization } from "./CodexThreadDirectoryProjection";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexThreadDirectory, type CodexThreadDirectoryEntry } from "./CodexThreadDirectory";
import { CodexConversations } from "./CodexConversations";
import { CodexMainConversationManagers } from "./CodexMainConversationManagers";
import {
  projectCodexSubagentOverviewWindow,
  type CoreSubagentOverviewLike,
} from "./CodexSubagentDirectoryProjection";
import { parseThreadStatus } from "./CodexThreadCatalogProjection";

/** Canonical residency is available even when no window has built a presentation. */
const hasSelectedSubagentHistory = (entry: CodexThreadDirectoryEntry | null): boolean => {
  const state = entry?.canonical;
  if (state) {
    const turns = conversationTurnsWithOverlay(state);
    if (turns.length > 0) return turns.some((turn) => turn.itemsView !== "notLoaded");
    return (
      state.turnHistory?.history.isComplete ??
      (state.resumeState === "resumed" && state.turnsPagination?.hasLoadedOldest !== false)
    );
  }
  const snapshot = entry?.snapshot;
  if (!snapshot) return false;
  const pagination = snapshot.turnPagination;
  if (pagination?.itemsView === "notLoaded") return false;
  return (
    snapshot.turns.length > 0 ||
    (pagination !== undefined && (pagination.loadedTurnCount > 0 || pagination.hasLoadedOldest))
  );
};

const DISCOVERY_PAGE_TIMEOUT_MS = 10_000;
const KNOWN_SUBAGENT_ADMISSION_LIMIT = 4_096;
const PENDING_STATUS_EVIDENCE_LIMIT = 4_096;
const PENDING_SPAWN_OBSERVATION_LIMIT = 4_096;
const PENDING_SPAWN_OBSERVATION_ENTRY_BYTES = 256 * 1_024;
const PENDING_SPAWN_OBSERVATION_TOTAL_BYTES = 8 * 1_024 * 1_024;

type CoreSubagentOverview = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { readonly kind: "subagent_overview_window" }
>["overview"];

type CoreSubagentOverviewItem = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { readonly kind: "subagent_overview_item" }
>;

interface SubagentUniverse {
  readonly host_id: string;
  readonly source_epoch: string;
  readonly generation: number;
  readonly root_thread_id: string;
}

interface RootContext {
  readonly root: CodexThreadDirectoryEntry;
  readonly capability: CodexAppServerCapabilitySnapshot;
  readonly universe: SubagentUniverse;
}

type SubagentIdentityResolution =
  | { readonly kind: "subagent"; readonly context: RootContext }
  | { readonly kind: "root" }
  | { readonly kind: "unresolved" };

type PendingSpawnObservation =
  | {
      readonly kind: "thread";
      readonly hostId: string;
      readonly generation: number;
      readonly occurrenceToken: number;
      readonly thread: Thread;
    }
  | {
      readonly kind: "activity";
      readonly hostId: string;
      readonly generation: number;
      readonly occurrenceToken: number;
      readonly parentThreadId: string;
      readonly childThreadId: string;
      readonly agentPath: string;
      readonly observedAtMs: number;
    };

interface PendingSpawnEntry {
  readonly observation: PendingSpawnObservation;
  readonly bytes: number;
}

interface PendingStatusEvidence {
  readonly hostId: string;
  readonly generation: number;
  readonly rootThreadId: string | null;
  readonly threadId: string;
  readonly status: "active" | "waiting" | "done" | "unknown";
  readonly kind: "notification" | "completion" | "reconciliation";
  readonly sourceRevision: number;
  readonly observedAtMs: number;
  readonly requiresMultiAgentV2: boolean;
}

type StatusEvidencePrecondition =
  | { readonly mode: "absent" }
  | {
      readonly mode: "exact";
      readonly evidence_kind: "metadata" | "notification" | "completion" | "reconciliation";
      readonly source_revision: number;
      readonly observed_at_ms: number;
    };

export interface CodexSubagentNotificationObservation {
  readonly hostId: string;
  readonly generation: number;
  readonly notification: CodexServerNotification;
  readonly occurrenceToken: number;
  readonly observedAtMs: number;
}

export interface CodexSubagentInterruptSnapshot {
  /** False when discovery has not reached an authoritative end for this host generation. */
  readonly discoveryComplete: boolean;
  readonly interruptedThreadIds: readonly string[];
  readonly failed: ReadonlyArray<{ readonly threadId: string; readonly reason: string }>;
  readonly unresolvedThreadIds: readonly string[];
}

interface InterruptDescendant {
  readonly threadId: string;
  readonly active: boolean;
}
interface InterruptDescendantSnapshot {
  readonly rows: readonly InterruptDescendant[];
  readonly complete: boolean;
}

/** Stop resident work first, then refresh metadata and interrupt remaining active Turns once. */
export const interruptSubagentDescendants = (input: {
  readonly known: Effect.Effect<InterruptDescendantSnapshot, CodexSubagentDirectoryError>;
  readonly discover: Effect.Effect<InterruptDescendantSnapshot, CodexSubagentDirectoryError>;
  readonly resident: (threadId: string) => CodexCanonicalConversationState | null;
  readonly interruptResident: (
    threadId: string,
  ) => Effect.Effect<string | null, CodexSubagentDirectoryError>;
  readonly readLatestTurn: (
    threadId: string,
  ) => Effect.Effect<
    { readonly id: string; readonly status: string } | null,
    CodexSubagentDirectoryError
  >;
  readonly interruptTurn: (
    threadId: string,
    turnId: string,
  ) => Effect.Effect<unknown, CodexSubagentDirectoryError>;
  readonly warn: (threadId: string | null, cause: unknown) => Effect.Effect<void>;
}): Effect.Effect<CodexSubagentInterruptSnapshot> =>
  Effect.gen(function* () {
    const interrupted = new Set<string>();
    const failed: Array<{ threadId: string; reason: string }> = [];
    const warn = (threadId: string, cause: unknown) => {
      failed.push({ threadId, reason: cause instanceof Error ? cause.message : String(cause) });
      return input.warn(threadId, cause);
    };
    const known = yield* input.known.pipe(
      Effect.catch((cause) =>
        input
          .warn(null, cause)
          .pipe(Effect.as({ rows: [], complete: false } as InterruptDescendantSnapshot)),
      ),
    );
    yield* Effect.forEach(
      known.rows,
      (row) =>
        Effect.gen(function* () {
          const resident = input.resident(row.threadId);
          const runtimeStatus = resident?.threadRuntimeStatus;
          const active =
            conversationTurnsWithOverlay(resident).some((turn) => turn.status === "inProgress") ||
            (resident?.resumeState !== "needs_resume" &&
            runtimeStatus &&
            runtimeStatus.type !== "notLoaded"
              ? runtimeStatus.type === "active"
              : row.active || runtimeStatus?.type === "active");
          if (!active) return;
          if ((yield* input.interruptResident(row.threadId)) !== null)
            interrupted.add(row.threadId);
        }).pipe(Effect.catch((cause) => warn(row.threadId, cause))),
      { concurrency: "unbounded" },
    );

    const discovered = yield* input.discover.pipe(
      Effect.catch((cause) => input.warn(null, cause).pipe(Effect.as(null))),
    );
    if (discovered)
      yield* Effect.forEach(
        discovered.rows,
        (row) =>
          Effect.gen(function* () {
            if (!row.active || interrupted.has(row.threadId)) return;
            if (
              input.resident(row.threadId) &&
              (yield* input.interruptResident(row.threadId)) !== null
            ) {
              interrupted.add(row.threadId);
              return;
            }
            const turn = yield* input.readLatestTurn(row.threadId);
            if (turn?.status !== "inProgress") return;
            yield* input.interruptTurn(row.threadId, turn.id);
            interrupted.add(row.threadId);
          }).pipe(Effect.catch((cause) => warn(row.threadId, cause))),
        { concurrency: "unbounded" },
      );
    return {
      discoveryComplete: discovered?.complete ?? false,
      interruptedThreadIds: [...interrupted],
      failed,
      unresolvedThreadIds: [],
    };
  });

export class CodexSubagentDirectoryError extends Schema.TaggedError<CodexSubagentDirectoryError>()(
  "CodexSubagentDirectoryError",
  {
    operation: Schema.Literals(["discover", "hydrate", "read", "status", "lifecycle"]),
    rootThreadId: Schema.String,
    threadId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {}

export class CodexSubagentDirectory extends Context.Service<
  CodexSubagentDirectory,
  {
    readonly readOverview: (
      input: CodexSubagentOverviewReadInput,
    ) => Effect.Effect<CodexSubagentOverviewWindow, CodexSubagentDirectoryError>;
    /** Reads only the durable projection; incomplete universes are repaired off the caller lane. */
    readonly readKnownOverview: (input: {
      readonly rootThreadId: string;
    }) => Effect.Effect<CodexSubagentOverviewWindow, CodexSubagentDirectoryError>;
    readonly hydrateSelected: (
      input: CodexSelectedSubagentHydrateInput,
    ) => Effect.Effect<CodexSelectedSubagentHydrateResult>;
    /** Commits status/topology evidence without subscribing to a child conversation. */
    readonly observeNotification: (
      input: CodexSubagentNotificationObservation,
    ) => Effect.Effect<void, CodexSubagentDirectoryError>;
    /** Re-establishes loaded roots after one physical app-server generation is replaced. */
    readonly reconcileAfterReconnect: (input: {
      readonly loadedThreadIds: readonly string[];
    }) => Effect.Effect<void>;
    readonly settleInterruptedSubtree: (
      rootThreadId: string,
    ) => Effect.Effect<CodexSubagentInterruptSnapshot, CodexSubagentDirectoryError>;
    readonly observe: (threadId: string) => void;
    readonly shouldDropDelta: (
      method: CodexServerNotification["method"],
      threadId: string | null,
    ) => boolean;
    readonly clear: (threadId: string) => void;
  }
>()("nodex/main/codex-application/CodexSubagentDirectory") {}

const BACKGROUND_DELTA_METHODS = new Set<CodexServerNotification["method"]>([
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
] satisfies readonly CodexServerNotification["method"][]);

const stablePageIdentity = (input: {
  readonly universe: SubagentUniverse;
  readonly coordinate: string;
}): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        universe: input.universe,
        coordinate: input.coordinate,
      }),
    )
    .digest("hex");

const topologyParents = (rootThreadId: string, threadIds: Iterable<string>): readonly string[] => {
  const parents = [rootThreadId];
  const seen = new Set(parents);
  for (const rawThreadId of threadIds) {
    const threadId = rawThreadId.trim();
    if (!threadId || seen.has(threadId)) continue;
    seen.add(threadId);
    parents.push(threadId);
  }
  return parents;
};

const deterministicObservationTime = (thread: Thread): number => {
  const seconds = Math.max(thread.updatedAt ?? 0, thread.createdAt ?? 0, 0);
  return Number.isSafeInteger(seconds) ? seconds * 1_000 : 0;
};

/**
 * Multi-Agent V2 intentionally emits a compact activity item before a full child Thread row.
 * Materialize that positive identity fact directly so the live owner never needs a competing
 * app-server connection merely to discover the child it just spawned.
 */
const projectStartedSubagentThreadShell = (input: {
  readonly parent: CodexThreadDirectoryEntry;
  readonly threadId: string;
  readonly agentPath: string;
  readonly observedAtMs: number;
}): Thread => {
  const observedAtSeconds = Math.max(0, Math.trunc(input.observedAtMs / 1_000));
  const pathSegments = input.agentPath
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const agentName = pathSegments.at(-1) ?? null;
  return {
    model: null,
    reasoningEffort: null,
    id: input.threadId,
    environments: null,
    extra: null,
    sessionId: input.parent.durable.threadId,
    forkedFromId: null,
    parentThreadId: input.parent.durable.threadId,
    preview: "",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: input.parent.durable.projectId,
    historyMode: "paginated",
    createdAt: observedAtSeconds,
    updatedAt: observedAtSeconds,
    recencyAt: observedAtSeconds,
    status: { type: "active", activeFlags: [] },
    path: null,
    cwd: input.parent.durable.cwd ?? "",
    cliVersion: "",
    originator: null,
    source: {
      subAgent: {
        thread_spawn: {
          parent_thread_id: input.parent.durable.threadId,
          depth: Math.max(1, pathSegments.length - 1),
          agent_path: input.agentPath || null,
          agent_nickname: null,
          agent_role: null,
        },
      },
    },
    canAcceptDirectInput: null,
    threadSource: "subAgentThreadSpawn",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: agentName,
    daybreakEnabled: null,
    modelProvider: input.parent.canonical?.modelProvider ?? "",
    turns: [],
  };
};

const emptySelectedResult = (
  input: CodexSelectedSubagentHydrateInput,
  errorMessage: string,
): CodexSelectedSubagentHydrateResult => ({
  rootThreadId: input.rootThreadId,
  threadId: input.threadId,
  revision: 0,
  fidelity: "metadata",
  checkpoint: null,
  canInteract: false,
  outcome: "failed",
  errorMessage,
});

const discoveryKey = (context: RootContext): string =>
  `${context.universe.host_id}\0${context.universe.source_epoch}\0${context.universe.generation}\0${context.universe.root_thread_id}`;

export const make: Effect.Effect<
  CodexSubagentDirectory["Service"],
  never,
  | CodexAppServerCapabilities
  | CodexApplicationEventHub
  | CodexConversations
  | ConversationEntityMap
  | CodexMainConversationManagers
  | CodexGateway
  | CodexThreadDirectory
  | CoreModules
  | Scope.Scope
> = Effect.gen(function* () {
  const ownerScope = yield* Scope.Scope;
  const capabilities = yield* CodexAppServerCapabilities;
  const events = yield* CodexApplicationEventHub;
  const conversations = yield* CodexConversations;
  const entities = yield* ConversationEntityMap;
  const managers = yield* CodexMainConversationManagers;
  const gateway = yield* CodexGateway;
  const threadDirectory = yield* CodexThreadDirectory;
  const core = yield* CoreModules;
  const discoveries = yield* FiberMap.make<
    string,
    CodexSubagentDiscoverySnapshot,
    CodexSubagentDirectoryError
  >();
  const runDiscovery = yield* FiberMap.runtime(discoveries)();
  const discoverySnapshots = new Map<string, CodexSubagentDiscoverySnapshot>();
  const statusRepairs = yield* FiberMap.make<string, void>();
  const runStatusRepair = yield* FiberMap.runtime(statusRepairs)();
  const known = new Map<string, boolean>();
  const knownRoots = new Set<string>();
  const pendingStatusEvidence = new Map<string, PendingStatusEvidence>();
  const pendingSpawnObservations = new Map<string, PendingSpawnEntry>();
  let pendingSpawnObservationBytes = 0;
  let flushPendingSpawnObservations: (
    materializedThreadIds: readonly string[],
    publishInvalidation?: boolean,
  ) => Effect.Effect<void, CodexSubagentDirectoryError> = () => Effect.void;
  let schedulePendingStatusRepair: (context: RootContext) => void = () => undefined;

  const interactionReferences = (parentThreadId: string | null | undefined) =>
    collectCodexSubagentInteractionReferences(
      conversationTurnsWithOverlay(
        parentThreadId ? conversations.read(parentThreadId)?.canonicalState : null,
      ),
    );

  const hasResidentConversation = (threadId: string): boolean => {
    const resident = conversations.read(threadId);
    return resident?.canonicalState != null || resident?.snapshot != null;
  };

  const projectOverview = (
    overview: CoreSubagentOverviewLike,
    discovered: readonly Thread[] = [],
  ): CodexSubagentOverviewWindow => {
    const skeletons = new Map(
      discovered.filter((thread) => thread.turns.length > 0).map((thread) => [thread.id, thread]),
    );
    const ids = new Set([overview.universe.root_thread_id]);
    for (const item of [...overview.active.items, ...overview.done.items]) {
      ids.add(item.thread.thread_id);
      if (item.thread.parent_thread_id) ids.add(item.thread.parent_thread_id);
    }
    const knownConversationsById: Record<string, SubagentConversation> = {};
    for (const threadId of ids) {
      const resident = conversations.read(threadId);
      const state = resident?.canonicalState;
      if (!state) {
        if (resident?.snapshot) knownConversationsById[threadId] = resident.snapshot;
        else {
          const thread = skeletons.get(threadId);
          if (thread)
            knownConversationsById[threadId] = {
              threadId,
              turns: thread.turns.map((turn) => ({
                threadId,
                turnId: turn.id,
                status: turn.status,
                itemIds: [],
                items: [],
                turnStartedAtMs: turn.startedAt == null ? null : turn.startedAt * 1_000,
                completedAt: turn.completedAt == null ? null : turn.completedAt * 1_000,
                durationMs: turn.durationMs,
              })),
            };
        }
        continue;
      }
      const metadata = extractCodexThreadSubagentMetadata({ source: state.source });
      knownConversationsById[threadId] = {
        threadId,
        parentThreadId: state.parentThreadId,
        source: state.source,
        resumeState: state.resumeState,
        agentNickname: state.agentNickname,
        agentRole: metadata.agentRole,
        createdAt: state.createdAt,
        updatedAt: state.recencyAt,
        threadRuntimeStatus: state.threadRuntimeStatus,
        turns: conversationTurnsWithOverlay(state).map((turn, turnIndex) =>
          projectCodexConversationTurn({
            threadId,
            turnIndex,
            beforeTurn: null,
            afterTurn: turn,
            current: null,
            observedAtMs: state.updatedAt,
          }),
        ),
      };
    }
    return projectCodexSubagentOverviewWindow(overview, () => false, {
      parentTurns: knownConversationsById[overview.universe.root_thread_id]?.turns ?? [],
      cachedConversationIds: overview.universe.host_id
        ? entities
            .forHost(overview.universe.host_id)
            .filter(
              (entity) => entity.readCanonicalState() !== null || entity.readSnapshot() !== null,
            )
            .map((entity) => entity.threadId)
        : Object.keys(knownConversationsById),
      sourceLinkedThreadIds: discovered.map((thread) => thread.id),
      knownConversationsById,
    });
  };

  const observedSubagentThreadIds = (
    rootThreadId: string,
    knownParentThreadIds: Iterable<string> = [],
  ): ReadonlySet<string> => {
    const ids = new Set<string>();
    for (const parentThreadId of topologyParents(rootThreadId, knownParentThreadIds)) {
      const state = conversations.read(parentThreadId)?.canonicalState;
      if (!state) continue;
      for (const turn of conversationTurnsWithOverlay(state)) {
        for (const item of turn.items) {
          if (item.type === "collabAgentToolCall") {
            if (item.tool !== "spawnAgent") continue;
            for (const rawThreadId of item.receiverThreadIds) {
              const threadId = rawThreadId.trim();
              if (threadId && threadId !== rootThreadId) ids.add(threadId);
            }
            continue;
          }
          if (item.type !== "subAgentActivity" || item.kind !== "started") continue;
          const threadId = item.agentThreadId.trim();
          if (threadId && threadId !== rootThreadId) ids.add(threadId);
        }
      }
    }
    return ids;
  };

  const error = (
    operation: CodexSubagentDirectoryError["operation"],
    rootThreadId: string,
    cause: unknown,
    threadId?: string,
  ) =>
    new CodexSubagentDirectoryError({
      operation,
      rootThreadId,
      cause,
      ...(threadId === undefined ? {} : { threadId }),
    });

  const runOwned = <A>(
    operation: Effect.Effect<A, CodexSubagentDirectoryError>,
  ): Effect.Effect<A, CodexSubagentDirectoryError> =>
    Effect.acquireUseRelease(
      operation.pipe(Effect.forkIn(ownerScope, { startImmediately: true })),
      Fiber.join,
      Fiber.interrupt,
    );

  const remember = (threadId: string, attached: boolean): boolean => {
    const normalized = threadId.trim();
    if (!normalized) return false;
    const current = known.get(normalized) ?? false;
    known.delete(normalized);
    while (known.size >= KNOWN_SUBAGENT_ADMISSION_LIMIT) {
      const oldest = known.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      known.delete(oldest);
    }
    known.set(normalized, current || attached);
    return true;
  };

  const rememberRoot = (threadId: string): void => {
    const normalized = threadId.trim();
    if (!normalized) return;
    knownRoots.delete(normalized);
    while (knownRoots.size >= KNOWN_SUBAGENT_ADMISSION_LIMIT) {
      const oldest = knownRoots.values().next().value;
      if (oldest === undefined) break;
      knownRoots.delete(oldest);
    }
    knownRoots.add(normalized);
  };

  const pendingEvidenceKey = (hostId: string, generation: number, threadId: string): string =>
    `${hostId}\0${generation}\0${threadId}`;

  const rememberPendingSpawnObservation = (observation: PendingSpawnObservation): void => {
    const threadId =
      observation.kind === "thread"
        ? observation.thread.id.trim()
        : observation.childThreadId.trim();
    if (!threadId) return;
    const bytes = cappedApproximateValueBytes(observation, PENDING_SPAWN_OBSERVATION_ENTRY_BYTES);
    if (bytes > PENDING_SPAWN_OBSERVATION_ENTRY_BYTES) return;
    const key = pendingEvidenceKey(observation.hostId, observation.generation, threadId);
    const replaced = pendingSpawnObservations.get(key);
    if (replaced) pendingSpawnObservationBytes -= replaced.bytes;
    pendingSpawnObservations.delete(key);
    while (
      pendingSpawnObservations.size >= PENDING_SPAWN_OBSERVATION_LIMIT ||
      pendingSpawnObservationBytes + bytes > PENDING_SPAWN_OBSERVATION_TOTAL_BYTES
    ) {
      const oldest = pendingSpawnObservations.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      pendingSpawnObservationBytes -= pendingSpawnObservations.get(oldest)?.bytes ?? 0;
      pendingSpawnObservations.delete(oldest);
    }
    pendingSpawnObservations.set(key, { observation, bytes });
    pendingSpawnObservationBytes += bytes;
  };

  const rememberPendingStatusEvidence = (incoming: PendingStatusEvidence): void => {
    const key = pendingEvidenceKey(incoming.hostId, incoming.generation, incoming.threadId);
    const current = pendingStatusEvidence.get(key);
    const currentEvidence = current
      ? {
          status: current.status,
          kind: current.kind,
          sourceRevision: current.sourceRevision,
          observedAtMs: current.observedAtMs,
        }
      : null;
    const incomingEvidence = {
      status: incoming.status,
      kind: incoming.kind,
      sourceRevision: incoming.sourceRevision,
      observedAtMs: incoming.observedAtMs,
    };
    const selected = selectCodexSubagentStatusEvidence(currentEvidence, incomingEvidence);
    const source = current && selected === currentEvidence ? current : incoming;
    pendingStatusEvidence.delete(key);
    while (pendingStatusEvidence.size >= PENDING_STATUS_EVIDENCE_LIMIT) {
      const oldest = pendingStatusEvidence.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      pendingStatusEvidence.delete(oldest);
    }
    pendingStatusEvidence.set(key, {
      ...source,
      status: selected.status,
      kind: selected.kind === "metadata" ? source.kind : selected.kind,
      sourceRevision: selected.sourceRevision,
      observedAtMs: selected.observedAtMs,
    });
  };

  const resolveRootContext = Effect.fn("CodexSubagentDirectory.resolveRootContext")(function* (
    rawRootThreadId: string,
  ): Effect.fn.Return<RootContext, CodexSubagentDirectoryError> {
    const rootThreadId = rawRootThreadId.trim();
    if (!rootThreadId) {
      return yield* error("read", rawRootThreadId, new Error("Root Thread id is required"));
    }
    const root = yield* threadDirectory
      .resolve({ threadId: rootThreadId, fidelity: "durable" })
      .pipe(Effect.mapError((cause) => error("read", rootThreadId, cause)));
    if (!root) {
      return yield* error("read", rootThreadId, new Error("Root Thread was not found"));
    }
    if (!isCodexAgentBackendBinding(root.durable.backendBinding)) {
      return yield* error(
        "read",
        rootThreadId,
        new Error("Subagent discovery requires a native Codex Thread"),
      );
    }
    rememberRoot(rootThreadId);
    const capability = yield* capabilities
      .forHost(root.durable.executionHostId)
      .pipe(Effect.mapError((cause) => error("read", rootThreadId, cause)));
    return {
      root,
      capability,
      universe: {
        host_id: capability.hostId,
        source_epoch: capability.sourceEpoch ?? `${capability.hostId}:${capability.userAgent}`,
        generation: capability.generation,
        root_thread_id: rootThreadId,
      },
    };
  });

  const readOverviewPage = Effect.fn("CodexSubagentDirectory.readOverviewPage")(function* (
    context: RootContext,
    input: {
      readonly activeAfter: string | null;
      readonly activeFirst: number;
      readonly doneAfter: string | null;
      readonly doneFirst: number;
    },
  ): Effect.fn.Return<CoreSubagentOverview, CodexSubagentDirectoryError> {
    const response = yield* core.workspace
      .read(
        {
          kind: "subagent_overview_window",
          universe: context.universe,
          active_window: { after: input.activeAfter, first: input.activeFirst },
          done_window: { after: input.doneAfter, first: input.doneFirst },
        },
        { class: "background", deadlineMs: DISCOVERY_PAGE_TIMEOUT_MS },
      )
      .pipe(Effect.mapError((cause) => error("read", context.universe.root_thread_id, cause)));
    if (response.value.kind !== "subagent_overview_window") {
      return yield* error(
        "read",
        context.universe.root_thread_id,
        new Error("Core returned the wrong Subagent overview read variant"),
      );
    }
    return response.value.overview;
  });

  const readOverviewItem = Effect.fn("CodexSubagentDirectory.readOverviewItem")(function* (
    context: RootContext,
    threadId: string,
  ): Effect.fn.Return<CoreSubagentOverviewItem, CodexSubagentDirectoryError> {
    const response = yield* core.workspace
      .read(
        { kind: "subagent_overview_item", universe: context.universe, thread_id: threadId },
        { class: "interactive", deadlineMs: DISCOVERY_PAGE_TIMEOUT_MS },
      )
      .pipe(
        Effect.mapError((cause) => error("read", context.universe.root_thread_id, cause, threadId)),
      );
    if (response.value.kind !== "subagent_overview_item") {
      return yield* error(
        "read",
        context.universe.root_thread_id,
        new Error("Core returned the wrong Subagent overview item read variant"),
        threadId,
      );
    }
    return response.value;
  });

  const isDescendant = Effect.fn("CodexSubagentDirectory.isDescendant")(function* (
    rootThreadId: string,
    threadId: string,
  ): Effect.fn.Return<boolean, CodexSubagentDirectoryError> {
    if (rootThreadId === threadId) return false;
    const visited = new Set<string>();
    let current = threadId;
    for (let depth = 0; depth < 128 && !visited.has(current); depth += 1) {
      visited.add(current);
      const entry = yield* threadDirectory
        .resolve({ threadId: current, fidelity: "durable" })
        .pipe(Effect.mapError((cause) => error("read", rootThreadId, cause, threadId)));
      const parentThreadId = entry?.durable.parentThreadId?.trim();
      if (!parentThreadId) return false;
      if (parentThreadId === rootThreadId) return true;
      current = parentThreadId;
    }
    return false;
  });

  const publishOverviewInvalidation = (context: RootContext) =>
    Effect.sync(() => {
      events.publish({
        kind: "codex",
        value: {
          type: "subagentOverviewInvalidated",
          rootThreadId: context.universe.root_thread_id,
        },
      });
    });

  const applyStatusEvidence = Effect.fn("CodexSubagentDirectory.applyStatusEvidence")(function* (
    context: RootContext,
    threadId: string,
    status: "active" | "waiting" | "done" | "unknown",
    evidenceKind: "notification" | "completion" | "reconciliation",
    sourceRevision: number,
    observedAtMs: number,
    precondition?: StatusEvidencePrecondition,
    publishInvalidation = true,
  ): Effect.fn.Return<void, CodexSubagentDirectoryError> {
    const apply = core.workspace
      .apply(
        {
          operationId: createOperationId("subagent-directory.status"),
          intent: {
            kind: "observe_subagent_status_evidence",
            universe: context.universe,
            thread_id: threadId,
            status,
            evidence_kind: evidenceKind,
            source_revision: Math.max(0, Math.trunc(sourceRevision)),
            observed_at_ms: Math.max(0, Math.trunc(observedAtMs)),
            ...(precondition ? { precondition } : {}),
          },
        },
        { class: "interactive", deadlineMs: DISCOVERY_PAGE_TIMEOUT_MS },
      )
      .pipe(
        Effect.mapError((cause) =>
          error("status", context.universe.root_thread_id, cause, threadId),
        ),
      );
    // Core may have committed immediately before the caller is interrupted or observes a
    // transport failure. A false-positive invalidation is harmless because the renderer
    // re-reads the durable projection; omitting it can leave an active row stale forever.
    yield* publishInvalidation
      ? apply.pipe(Effect.ensuring(publishOverviewInvalidation(context)))
      : apply;
  });

  const bufferStatusEvidence = Effect.fn("CodexSubagentDirectory.bufferStatusEvidence")(function* (
    pending: PendingStatusEvidence,
  ): Effect.fn.Return<void, CodexSubagentDirectoryError> {
    const capability = yield* capabilities
      .forHost(pending.hostId)
      .pipe(
        Effect.mapError((cause) =>
          error("status", pending.rootThreadId ?? pending.threadId, cause, pending.threadId),
        ),
      );
    if (capability.generation !== pending.generation) return;
    if (pending.requiresMultiAgentV2 && !capability.flags.multiAgentV2Protocol) return;
    yield* core.workspace
      .apply(
        {
          operationId: createOperationId("subagent-directory.status-buffer"),
          intent: {
            kind: "buffer_subagent_status_evidence",
            host_id: pending.hostId,
            source_epoch: capability.sourceEpoch ?? `${capability.hostId}:${capability.userAgent}`,
            generation: pending.generation,
            thread_id: pending.threadId,
            status: pending.status,
            evidence_kind: pending.kind,
            source_revision: Math.max(0, Math.trunc(pending.sourceRevision)),
            observed_at_ms: Math.max(0, Math.trunc(pending.observedAtMs)),
          },
        },
        { class: "interactive", deadlineMs: DISCOVERY_PAGE_TIMEOUT_MS },
      )
      .pipe(
        Effect.mapError((cause) =>
          error("status", pending.rootThreadId ?? pending.threadId, cause, pending.threadId),
        ),
      );
  });

  /** A later identity observation flushes this bounded fallback through applyStatusEvidence. */
  const bufferStatusEvidenceBeforeIdentity = Effect.fn(
    "CodexSubagentDirectory.bufferStatusEvidenceBeforeIdentity",
  )(function* (pending: PendingStatusEvidence): Effect.fn.Return<void> {
    yield* bufferStatusEvidence(pending).pipe(
      Effect.catch((cause) => {
        rememberPendingStatusEvidence(pending);
        return Effect.logWarning(
          "Could not durably buffer early Subagent status evidence; retaining it in memory",
        ).pipe(
          Effect.annotateLogs({
            hostId: pending.hostId,
            generation: pending.generation,
            threadId: pending.threadId,
            cause,
          }),
        );
      }),
    );
  });

  const flushPendingStatusEvidence = Effect.fn("CodexSubagentDirectory.flushPendingStatusEvidence")(
    function* (
      context: RootContext,
      threadIds: readonly string[],
      publishInvalidation = true,
    ): Effect.fn.Return<void, CodexSubagentDirectoryError> {
      for (const threadId of threadIds) {
        const key = pendingEvidenceKey(
          context.universe.host_id,
          context.universe.generation,
          threadId,
        );
        const buffered = pendingStatusEvidence.get(key);
        if (!buffered) continue;
        const pending =
          buffered.rootThreadId === context.universe.root_thread_id
            ? buffered
            : { ...buffered, rootThreadId: context.universe.root_thread_id };
        if (pending !== buffered) pendingStatusEvidence.set(key, pending);
        if (pending.requiresMultiAgentV2 && !context.capability.flags.multiAgentV2Protocol) {
          pendingStatusEvidence.delete(key);
          continue;
        }
        const applied = yield* applyStatusEvidence(
          context,
          threadId,
          pending.status,
          pending.kind,
          pending.sourceRevision,
          pending.observedAtMs,
          undefined,
          publishInvalidation,
        ).pipe(Effect.result);
        if (applied._tag === "Failure") {
          schedulePendingStatusRepair(context);
          continue;
        }
        if (pendingStatusEvidence.get(key) === pending) pendingStatusEvidence.delete(key);
      }
    },
  );

  const applyDiscoveryPage = Effect.fn("CodexSubagentDirectory.applyDiscoveryPage")(function* (
    context: RootContext,
    coordinate: string,
    threads: readonly Thread[],
    continuation: string | null,
    complete: boolean,
    flushPendingSpawns = true,
    publishInvalidation = true,
  ): Effect.fn.Return<void, CodexSubagentDirectoryError> {
    if (threads.length > CODEX_SUBAGENT_DISCOVERY_PAGE_LIMIT) {
      return yield* error(
        "discover",
        context.universe.root_thread_id,
        new Error("Subagent discovery page exceeded its row budget"),
      );
    }

    const pageThreadIds = new Set(threads.map((thread) => thread.id));
    const orderedThreads: Thread[] = [];
    const orderedThreadIds = new Set<string>();
    const remainingThreads = [...threads];
    while (remainingThreads.length > 0) {
      const nextIndex = remainingThreads.findIndex((thread) => {
        const parentThreadId = extractCodexThreadSubagentMetadata(thread).parentThreadId;
        return (
          !parentThreadId ||
          parentThreadId === context.universe.root_thread_id ||
          orderedThreadIds.has(parentThreadId) ||
          !pageThreadIds.has(parentThreadId)
        );
      });
      if (nextIndex < 0) {
        return yield* error(
          "discover",
          context.universe.root_thread_id,
          new Error("Subagent discovery page contains a cyclic parent graph"),
        );
      }
      const [thread] = remainingThreads.splice(nextIndex, 1);
      if (!thread) continue;
      orderedThreads.push(thread);
      orderedThreadIds.add(thread.id);
    }

    const observations = [];
    for (const thread of orderedThreads) {
      if (thread.turns.length > 0) {
        return yield* error(
          "discover",
          context.universe.root_thread_id,
          new Error("Subagent discovery returned inline transcript history"),
          thread.id,
        );
      }
      const parentThreadId = extractCodexThreadSubagentMetadata(thread).parentThreadId;
      if (!parentThreadId) continue;
      const existing = yield* threadDirectory
        .resolve({ threadId: thread.id, fidelity: "durable" })
        .pipe(
          Effect.mapError((cause) =>
            error("discover", context.universe.root_thread_id, cause, thread.id),
          ),
        );
      const parent =
        parentThreadId === context.universe.root_thread_id
          ? context.root
          : yield* threadDirectory
              .resolve({ threadId: parentThreadId, fidelity: "durable" })
              .pipe(
                Effect.mapError((cause) =>
                  error("discover", context.universe.root_thread_id, cause, parentThreadId),
                ),
              );
      const observedAtMs = deterministicObservationTime(thread);
      const materialization = projectCodexThreadDirectoryMaterialization({
        thread,
        existing: existing?.durable ?? null,
        parent: parent?.durable ?? context.root.durable,
        explicitParentThreadId: parentThreadId,
        observedExecutionHostId: context.universe.host_id,
        fallbackCwd: context.root.durable.cwd,
        nowMs: observedAtMs,
      });
      if (!materialization) continue;
      remember(thread.id, false);
      observations.push({
        thread_id: thread.id,
        parent_thread_id: parentThreadId,
        patch: materialization.patch,
        source_revision: Math.max(0, Math.trunc(thread.updatedAt ?? thread.createdAt ?? 0)),
        observed_at_ms: observedAtMs,
      });
    }

    const apply = core.workspace
      .apply(
        {
          operationId: createOperationId("subagent-directory.discovery-page"),
          intent: {
            kind: "observe_subagent_discovery_page",
            universe: context.universe,
            page_identity: stablePageIdentity({
              universe: context.universe,
              coordinate,
            }),
            observations,
            continuation,
            complete,
          },
        },
        { class: "background", deadlineMs: DISCOVERY_PAGE_TIMEOUT_MS },
      )
      .pipe(Effect.mapError((cause) => error("discover", context.universe.root_thread_id, cause)));
    // Discovery has the same commit/receipt ambiguity as status evidence. Always tell observers
    // to re-read unless a larger atomic reconciliation batch owns the single final invalidation.
    yield* publishInvalidation
      ? apply.pipe(Effect.ensuring(publishOverviewInvalidation(context)))
      : apply;
    yield* flushPendingStatusEvidence(
      context,
      observations.map((observation) => observation.thread_id),
      publishInvalidation,
    );
    if (flushPendingSpawns) {
      yield* flushPendingSpawnObservations(
        observations.map((observation) => observation.thread_id),
        publishInvalidation,
      );
    }
  });

  const reconcileDiscoveryStatus = Effect.fn("CodexSubagentDirectory.reconcileDiscoveryStatus")(
    function* (
      context: RootContext,
      item: CoreSubagentOverview["active"]["items"][number],
      runtimeAtStart: Thread["status"] | undefined,
      status: Thread["status"] = { type: "idle" },
      absent = true,
    ): Effect.fn.Return<void, CodexSubagentDirectoryError> {
      const threadId = item.thread.thread_id;
      yield* entities.runCommand(
        threadId,
        Effect.gen(function* () {
          if (
            !(yield* capabilities
              .isCurrent(context.capability)
              .pipe(
                Effect.mapError((cause) =>
                  error("discover", context.universe.root_thread_id, cause),
                ),
              ))
          )
            return;
          const entity = entities.current(threadId);
          const currentRuntime = conversations.read(threadId)?.canonicalState?.threadRuntimeStatus;
          // Runtime objects are immutable notification evidence. Unchanged evidence is stale.
          if (
            currentRuntime !== runtimeAtStart &&
            currentRuntime &&
            (!absent || currentRuntime.type === "active" || currentRuntime.type === "systemError")
          )
            return;
          const authority = yield* readOverviewItem(context, threadId);
          if (!authority.item) return;
          const evidence = item.evidence;
          const currentEvidence = authority.item.evidence;
          if (
            (currentEvidence?.kind ?? null) !== (evidence?.kind ?? null) ||
            currentEvidence?.source_revision !== evidence?.source_revision ||
            currentEvidence?.observed_at_ms !== evidence?.observed_at_ms
          )
            return;
          const precondition: StatusEvidencePrecondition = evidence
            ? {
                mode: "exact",
                evidence_kind: evidence.kind,
                source_revision: evidence.source_revision,
                observed_at_ms: evidence.observed_at_ms,
              }
            : { mode: "absent" };
          const observedAtMs = Math.max(
            yield* Clock.currentTimeMillis,
            (evidence?.observed_at_ms ?? 0) + 1,
          );
          const parsedStatus = parseThreadStatus(status);
          yield* applyStatusEvidence(
            context,
            threadId,
            projectCodexSubagentThreadStatus({
              statusType: parsedStatus.statusType,
              activeFlags: parsedStatus.statusActiveFlags,
            }),
            "reconciliation",
            evidence?.source_revision ?? 0,
            observedAtMs,
            precondition,
            false,
          );
          const accepted = yield* readOverviewItem(context, threadId);
          if (
            accepted.item?.evidence?.kind !== "reconciliation" ||
            accepted.item.evidence.source_revision !== (evidence?.source_revision ?? 0) ||
            accepted.item.evidence.observed_at_ms !== observedAtMs
          )
            return;
          // The causal lane also owns status notifications, so the evidence check and the durable
          // and resident transitions cannot interleave with a newer notification for this Thread.
          yield* core.workspace
            .apply({
              operationId: createOperationId("subagent-directory.discovery-status"),
              intent: {
                kind: "update_thread",
                thread_id: threadId,
                patch: {
                  status: {
                    status_type: parsedStatus.statusType,
                    active_flags: parsedStatus.statusActiveFlags,
                  },
                },
              },
            })
            .pipe(
              Effect.mapError((cause) =>
                error("discover", context.universe.root_thread_id, cause, threadId),
              ),
            );
          entity?.mutateCanonicalState((draft) => {
            draft.threadRuntimeStatus = status;
          }, observedAtMs);
          events.publish({
            kind: "codex",
            value: {
              type: "threadStatus",
              threadId,
              statusType: parsedStatus.statusType,
              statusActiveFlags: parsedStatus.statusActiveFlags,
            },
          });
        }),
      );
    },
  );

  /** Capture absence authority before remote I/O; a later notification must win the CAS. */
  const discover = Effect.fn("CodexSubagentDirectory.discover")(function* (
    context: RootContext,
  ): Effect.fn.Return<CodexSubagentDiscoverySnapshot, CodexSubagentDirectoryError> {
    const before = yield* readAllOverview(context);
    const previous = [...before.active.items, ...before.done.items];
    const runtimeAtStart = new Map(
      previous.map((item) => [
        item.thread.thread_id,
        conversations.read(item.thread.thread_id)?.canonicalState?.threadRuntimeStatus,
      ]),
    );
    const requestOptions = {
      priority: "background" as const,
      source: "collab_hydration" as const,
      conversationId: context.universe.root_thread_id,
      widgetId: "subagent-overview:discovery",
      timeoutMs: DISCOVERY_PAGE_TIMEOUT_MS,
      ...codexGatewayGenerationFence(context.capability),
    };
    const snapshot = yield* discoverCodexSubagentDescendants({
      rootThreadId: context.universe.root_thread_id,
      rootCreatedAtMs: context.root.durable.createdAt,
      listSupported: context.universe.host_id !== "durable",
      ancestorFilter: context.capability.flags.subagentAncestorFilter,
      observedSpawnedThreadIds: (parentThreadId) => [...observedSubagentThreadIds(parentThreadId)],
      isResident: hasResidentConversation,
      list: (params) =>
        gateway.requestOnHost(context.universe.host_id, "thread/list", params, requestOptions),
      read: (threadId) =>
        gateway
          .requestOnHost(
            context.universe.host_id,
            "thread/read",
            {
              threadId,
              includeTurns: false,
            },
            requestOptions,
          )
          .pipe(Effect.map((response) => projectCodexGatewayThreadReadThread(response.thread))),
      turns: (threadId, cursor) =>
        gateway.requestOnHost(
          context.universe.host_id,
          "thread/turns/list",
          {
            threadId,
            cursor,
            limit: 5,
            sortDirection: "asc",
            itemsView: "full",
          },
          requestOptions,
        ),
    }).pipe(Effect.mapError((cause) => error("discover", context.universe.root_thread_id, cause)));
    const currentGeneration = yield* capabilities
      .isCurrent(context.capability)
      .pipe(Effect.mapError((cause) => error("discover", context.universe.root_thread_id, cause)));
    if (!currentGeneration) return { ...snapshot, complete: false };
    // Core transport uses batches; the completed scan and its topology are not truncated.
    const scanId = randomUUID();
    const pending = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
    const ordered: Thread[] = [];
    while (pending.size > 0) {
      const ready = [...pending.values()].filter((thread) => {
        const parent = extractCodexThreadSubagentMetadata(thread).parentThreadId;
        return !parent || !pending.has(parent);
      });
      if (ready.length === 0) {
        return yield* error(
          "discover",
          context.universe.root_thread_id,
          new Error("Subagent discovery contains a cyclic parent graph"),
        );
      }
      for (const thread of ready) {
        pending.delete(thread.id);
        ordered.push({ ...thread, turns: [] });
      }
    }
    for (
      let offset = 0;
      offset < Math.max(1, ordered.length);
      offset += CODEX_SUBAGENT_DISCOVERY_PAGE_LIMIT
    ) {
      yield* applyDiscoveryPage(
        context,
        `${scanId}:${offset}`,
        ordered.slice(offset, offset + CODEX_SUBAGENT_DISCOVERY_PAGE_LIMIT),
        null,
        snapshot.complete && offset + CODEX_SUBAGENT_DISCOVERY_PAGE_LIMIT >= ordered.length,
        true,
        false,
      );
    }
    const previousById = new Map(previous.map((item) => [item.thread.thread_id, item]));
    for (const thread of snapshot.threads) {
      const item = previousById.get(thread.id);
      if (!item?.thread.status) continue;
      const parsed = parseThreadStatus(thread.status);
      const canonical = runtimeAtStart.get(thread.id);
      if (
        item.thread.status.status_type === parsed.statusType &&
        JSON.stringify(item.thread.status.active_flags) ===
          JSON.stringify(parsed.statusActiveFlags) &&
        (!canonical || canonical.type === thread.status.type)
      )
        continue;
      yield* reconcileDiscoveryStatus(context, item, canonical, thread.status, false);
    }
    discoverySnapshots.set(discoveryKey(context), snapshot);
    if (!snapshot.complete) return snapshot;
    const present = new Set(snapshot.threads.map((thread) => thread.id));
    for (const item of previous) {
      if (present.has(item.thread.thread_id)) continue;
      yield* reconcileDiscoveryStatus(context, item, runtimeAtStart.get(item.thread.thread_id));
    }
    return snapshot;
  });

  const startDiscovery = (context: RootContext, publishInvalidation = true) => {
    const key = discoveryKey(context);
    const existing = FiberMap.getUnsafe(discoveries, key);
    if (existing._tag === "Some") return existing.value;
    return runDiscovery(
      key,
      discover(context).pipe(
        Effect.tapCause((cause) =>
          Effect.logWarning("Could not discover Subagents").pipe(
            Effect.annotateLogs({ rootThreadId: context.universe.root_thread_id, cause }),
          ),
        ),
        Effect.ensuring(publishInvalidation ? publishOverviewInvalidation(context) : Effect.void),
      ),
    );
  };

  const scheduleDiscoveryRepair = (context: RootContext): void => {
    startDiscovery(context);
  };

  schedulePendingStatusRepair = (context: RootContext): void => {
    const repairKey = `status\0${context.universe.host_id}\0${context.universe.generation}\0${context.universe.root_thread_id}`;
    if (FiberMap.hasUnsafe(statusRepairs, repairKey)) return;
    const evidencePrefix = `${context.universe.host_id}\0${context.universe.generation}\0`;
    runStatusRepair(
      repairKey,
      Effect.gen(function* () {
        let retryDelayMs = 100;
        while (true) {
          const current = yield* capabilities
            .isCurrent(context.capability)
            .pipe(Effect.catch(() => Effect.succeed(false)));
          const pending = [...pendingStatusEvidence.entries()].filter(
            ([key, evidence]) =>
              key.startsWith(evidencePrefix) &&
              evidence.rootThreadId === context.universe.root_thread_id,
          );
          if (!current) {
            for (const [key] of pending) pendingStatusEvidence.delete(key);
            return;
          }
          if (pending.length === 0) return;

          const outcomes = yield* Effect.forEach(
            pending,
            ([key, evidence]) => {
              if (evidence.requiresMultiAgentV2 && !context.capability.flags.multiAgentV2Protocol) {
                return Effect.succeed({ key, evidence, applied: true });
              }
              return applyStatusEvidence(
                context,
                evidence.threadId,
                evidence.status,
                evidence.kind,
                evidence.sourceRevision,
                evidence.observedAtMs,
              ).pipe(
                Effect.as({ key, evidence, applied: true }),
                Effect.catch(() => Effect.succeed({ key, evidence, applied: false })),
              );
            },
            { concurrency: 2 },
          );
          let failed = false;
          for (const outcome of outcomes) {
            if (!outcome.applied) {
              failed = true;
              continue;
            }
            if (pendingStatusEvidence.get(outcome.key) === outcome.evidence) {
              pendingStatusEvidence.delete(outcome.key);
            }
          }
          if (!failed) return;
          yield* Effect.sleep(`${retryDelayMs} millis`);
          retryDelayMs = Math.min(retryDelayMs * 2, 5_000);
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not repair buffered Subagent status evidence").pipe(
            Effect.annotateLogs({
              rootThreadId: context.universe.root_thread_id,
              generation: context.universe.generation,
              cause,
            }),
          ),
        ),
        Effect.asVoid,
      ),
    );
  };

  /** Read raw Core cursors to completion before shared row projection can regroup or hide rows. */
  const readAllOverview = Effect.fn("CodexSubagentDirectory.readAllOverview")(function* (
    context: RootContext,
  ): Effect.fn.Return<CoreSubagentOverview, CodexSubagentDirectoryError> {
    for (;;) {
      const active: Array<CoreSubagentOverview["active"]["items"][number]> = [];
      const done: Array<CoreSubagentOverview["done"]["items"][number]> = [];
      let activeAfter: string | null = null;
      let doneAfter: string | null = null;
      let activeComplete = false;
      let doneComplete = false;
      let first: CoreSubagentOverview | null = null;
      const activeCursors = new Set<string>();
      const doneCursors = new Set<string>();
      for (;;) {
        const current: CoreSubagentOverview = yield* readOverviewPage(context, {
          activeAfter,
          activeFirst: activeComplete ? 1 : CODEX_SUBAGENT_DISCOVERY_PAGE_LIMIT,
          doneAfter,
          doneFirst: doneComplete ? 1 : CODEX_SUBAGENT_DISCOVERY_PAGE_LIMIT,
        });
        first ??= current;
        if (current.projection_revision !== first.projection_revision) break;
        if (!activeComplete) {
          active.push(...current.active.items);
          activeAfter = current.active.next_cursor ?? null;
          activeComplete = activeAfter === null;
          if (activeAfter !== null && activeCursors.has(activeAfter)) {
            return yield* error(
              "read",
              context.universe.root_thread_id,
              new Error("Core active overview cursor repeated"),
            );
          }
          if (activeAfter !== null) activeCursors.add(activeAfter);
        }
        if (!doneComplete) {
          done.push(...current.done.items);
          doneAfter = current.done.next_cursor ?? null;
          doneComplete = doneAfter === null;
          if (doneAfter !== null && doneCursors.has(doneAfter)) {
            return yield* error(
              "read",
              context.universe.root_thread_id,
              new Error("Core done overview cursor repeated"),
            );
          }
          if (doneAfter !== null) doneCursors.add(doneAfter);
        }
        if (activeComplete && doneComplete)
          return {
            ...first,
            active: { ...first.active, items: active, next_cursor: null },
            done: { ...first.done, items: done, next_cursor: null },
          };
      }
      yield* Effect.yieldNow;
    }
  });

  const readExpanded = Effect.fn("CodexSubagentDirectory.readExpanded")(function* (
    context: RootContext,
  ): Effect.fn.Return<CodexSubagentOverviewWindow, CodexSubagentDirectoryError> {
    const overview = yield* readAllOverview(context);
    const snapshot = discoverySnapshots.get(discoveryKey(context));
    if (!snapshot?.complete) return projectOverview(overview, snapshot?.threads);
    const present = new Set(snapshot.threads.map((thread) => thread.id));
    const retained = new Set<string>();
    for (const parent of [
      context.universe.root_thread_id,
      ...overview.active.items.map((item) => item.thread.thread_id),
      ...overview.done.items.map((item) => item.thread.thread_id),
    ]) {
      for (const threadId of interactionReferences(parent).keys()) retained.add(threadId);
    }
    const visible = (item: CoreSubagentOverview["active"]["items"][number]) =>
      present.has(item.thread.thread_id) ||
      retained.has(item.thread.thread_id) ||
      hasResidentConversation(item.thread.thread_id) ||
      (conversations.read(item.thread.thread_id)?.canonicalState?.threadRuntimeStatus?.type ??
        item.thread.status.status_type) === "active";
    return projectOverview(
      {
        ...overview,
        active: { ...overview.active, items: overview.active.items.filter(visible) },
        done: { ...overview.done, items: overview.done.items.filter(visible) },
      },
      snapshot.threads,
    );
  });

  const initialOverview = (overview: CodexSubagentOverviewWindow): CodexSubagentOverviewWindow => ({
    ...overview,
    active: {
      ...overview.active,
      rows: overview.active.rows.slice(0, CODEX_SUBAGENT_OVERVIEW_INITIAL_ACTIVE_LIMIT),
    },
    done: {
      ...overview.done,
      rows: overview.done.rows.slice(0, CODEX_SUBAGENT_OVERVIEW_INITIAL_DONE_LIMIT),
    },
  });

  const readOverview = Effect.fn("CodexSubagentDirectory.readOverview")(function* (
    input: CodexSubagentOverviewReadInput,
  ): Effect.fn.Return<CodexSubagentOverviewWindow, CodexSubagentDirectoryError> {
    const context = yield* resolveRootContext(input.rootThreadId);
    const current = yield* readAllOverview(context);
    const key = discoveryKey(context);
    const running = FiberMap.getUnsafe(discoveries, key);
    if (running._tag === "Some") yield* Fiber.join(running.value);
    else if (!current.discovery_complete) {
      // A concurrent caller may have finished while this caller's Core read was in flight.
      const latest = yield* readAllOverview(context);
      if (!latest.discovery_complete) yield* Fiber.join(startDiscovery(context));
    }
    const overview = yield* readExpanded(context);
    return input.mode === "expanded" ? overview : initialOverview(overview);
  });

  const readKnownOverview = Effect.fn("CodexSubagentDirectory.readKnownOverview")(
    function* (input: {
      readonly rootThreadId: string;
    }): Effect.fn.Return<CodexSubagentOverviewWindow, CodexSubagentDirectoryError> {
      const context = yield* resolveRootContext(input.rootThreadId);
      const overview = yield* readExpanded(context);
      if (overview.completeness !== "complete") scheduleDiscoveryRepair(context);
      return initialOverview(overview);
    },
  );

  const resolveReconnectRootThreadId = Effect.fn(
    "CodexSubagentDirectory.resolveReconnectRootThreadId",
  )(function* (rawThreadId: string): Effect.fn.Return<string | null, CodexSubagentDirectoryError> {
    const originThreadId = rawThreadId.trim();
    if (!originThreadId) return null;
    const visited = new Set<string>();
    let threadId = originThreadId;
    for (let depth = 0; depth < 128 && !visited.has(threadId); depth += 1) {
      visited.add(threadId);
      const entry = yield* threadDirectory
        .resolve({ threadId, fidelity: "durable" })
        .pipe(Effect.mapError((cause) => error("read", originThreadId, cause, originThreadId)));
      if (!entry) return null;
      const parentThreadId = entry.durable.parentThreadId?.trim() ?? "";
      if (!parentThreadId) {
        return entry.durable.threadSource === "subAgentThreadSpawn" ? null : threadId;
      }
      threadId = parentThreadId;
    }
    return null;
  });

  const refreshReconnectMetadata = (context: RootContext) =>
    Fiber.join(startDiscovery(context, false));

  const reconcileReconnectRoot = Effect.fn("CodexSubagentDirectory.reconcileReconnectRoot")(
    function* (context: RootContext): Effect.fn.Return<void, CodexSubagentDirectoryError> {
      // Establish the endpoint universe, then replace its metadata with one complete discovery.
      yield* applyDiscoveryPage(
        context,
        `reconnect-bootstrap:${context.universe.host_id}:${context.universe.generation}`,
        [],
        null,
        false,
        true,
        false,
      );
      yield* refreshReconnectMetadata(context).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not refresh Subagent metadata after Codex reconnected").pipe(
            Effect.annotateLogs({
              rootThreadId: context.universe.root_thread_id,
              generation: context.universe.generation,
              cause,
            }),
          ),
        ),
      );
    },
  );

  const reconcileAfterReconnect = Effect.fn("CodexSubagentDirectory.reconcileAfterReconnect")(
    function* (input: { readonly loadedThreadIds: readonly string[] }) {
      const candidates = yield* Effect.forEach(
        [...new Set(input.loadedThreadIds.map((threadId) => threadId.trim()).filter(Boolean))],
        (threadId) =>
          resolveReconnectRootThreadId(threadId).pipe(Effect.catch(() => Effect.succeed(null))),
        { concurrency: 2 },
      );
      const rootThreadIds = [...new Set(candidates.filter((threadId) => threadId !== null))].filter(
        (threadId) => knownRoots.has(threadId),
      );
      yield* Effect.forEach(
        rootThreadIds,
        (rootThreadId) =>
          resolveRootContext(rootThreadId).pipe(
            Effect.flatMap((context) =>
              reconcileReconnectRoot(context).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Could not reconcile Subagents after Codex reconnected").pipe(
                    Effect.annotateLogs({
                      rootThreadId,
                      generation: context.universe.generation,
                      cause,
                    }),
                  ),
                ),
                Effect.ensuring(publishOverviewInvalidation(context)),
              ),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not resolve a Subagent root after Codex reconnected").pipe(
                Effect.annotateLogs({ rootThreadId, cause }),
              ),
            ),
          ),
        { concurrency: 2, discard: true },
      );
    },
  );

  const readInterruptDescendants = (context: RootContext) =>
    readAllOverview(context).pipe(
      Effect.map((page) => ({
        rows: [...page.active.items, ...page.done.items]
          .filter((item) => !item.thread.archived)
          .map((item) => ({
            threadId: item.thread.thread_id,
            active: item.thread.status?.status_type === "active",
          })),
        complete: page.discovery_complete,
      })),
    );

  const settleInterruptedSubtree = Effect.fn("CodexSubagentDirectory.settleInterruptedSubtree")(
    function* (rootThreadId: string) {
      const context = yield* resolveRootContext(rootThreadId);
      const hostId = context.universe.host_id;
      const generation = context.universe.generation;
      const scheduling = {
        expectedHostId: hostId,
        expectedGeneration: generation,
        conversationId: rootThreadId,
      };
      const interruptResident = Effect.fn("CodexSubagentDirectory.interruptResident")(function* (
        threadId: string,
      ) {
        if (!conversations.read(threadId)?.canonicalState) return null;
        const manager = managers.current(hostId);
        if (!manager) return null;
        yield* Effect.try({
          try: () => manager.assertCurrent(generation),
          catch: (cause) => error("lifecycle", rootThreadId, cause, threadId),
        });
        const request = conversationFollowerRequest("thread-follower-interrupt-turn", {
          conversationId: threadId,
          mode: "descendant-cleanup",
        });
        const result =
          manager.stream.getRole(threadId)?.role === "owner"
            ? yield* managers.dispatchFollowerRequest(hostId, request)
            : yield* Effect.tryPromise({
                try: async () => {
                  manager.assertCurrent(generation);
                  const response = await manager.coordination.requestThreadFollower({
                    hostId,
                    request,
                  });
                  manager.assertCurrent(generation);
                  if (response.resultType !== "success") {
                    // Metadata notifications can create canonical state without a live owner.
                    // Owner absence leaves this child eligible for the native Turn fallback.
                    if (
                      response.error === "no-client-found" ||
                      response.error.startsWith("no-client-found:")
                    )
                      return { interruptedTurnId: null };
                    throw new Error(response.error);
                  }
                  return response.result;
                },
                catch: (cause) => error("lifecycle", rootThreadId, cause, threadId),
              });
        return yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            interruptedTurnId: Schema.NullOr(Schema.String),
          }),
        )(result).pipe(Effect.map((result) => result.interruptedTurnId));
      });
      return yield* interruptSubagentDescendants({
        known: readInterruptDescendants(context),
        discover: Effect.suspend(() => Fiber.join(startDiscovery(context))).pipe(
          Effect.map((snapshot) => ({
            rows: snapshot.threads.map((thread) => ({
              threadId: thread.id,
              active: thread.status.type === "active",
            })),
            complete: snapshot.complete,
          })),
        ),
        resident: (threadId) => conversations.read(threadId)?.canonicalState ?? null,
        interruptResident: (threadId) =>
          interruptResident(threadId).pipe(
            Effect.mapError((cause) => error("lifecycle", rootThreadId, cause, threadId)),
          ),
        readLatestTurn: (threadId) =>
          gateway
            .requestOnHost(
              hostId,
              "thread/turns/list",
              {
                threadId,
                cursor: null,
                limit: 1,
                sortDirection: "desc",
                itemsView: "notLoaded",
              },
              scheduling,
            )
            .pipe(
              Effect.map((page) => page.data[0] ?? null),
              Effect.mapError((cause) => error("lifecycle", rootThreadId, cause, threadId)),
            ),
        interruptTurn: (threadId, turnId) =>
          gateway
            .requestOnHost(
              hostId,
              "turn/interrupt",
              {
                threadId,
                turnId,
              },
              { ...scheduling, priority: "critical" },
            )
            .pipe(Effect.mapError((cause) => error("lifecycle", rootThreadId, cause, threadId))),
        warn: (threadId, cause) =>
          Effect.logWarning("Could not interrupt Subagent descendant").pipe(
            Effect.annotateLogs({ rootThreadId, threadId, cause }),
          ),
      });
    },
  );

  const resolveSubagentIdentity = Effect.fn("CodexSubagentDirectory.resolveSubagentIdentity")(
    function* (
      threadId: string,
    ): Effect.fn.Return<SubagentIdentityResolution, CodexSubagentDirectoryError> {
      const visited = new Set<string>();
      let currentThreadId = threadId.trim();
      let observedParent = false;
      for (
        let depth = 0;
        depth < 128 && currentThreadId && !visited.has(currentThreadId);
        depth += 1
      ) {
        visited.add(currentThreadId);
        const entry = yield* threadDirectory
          .resolve({ threadId: currentThreadId, fidelity: "durable" })
          .pipe(Effect.mapError((cause) => error("status", threadId, cause, threadId)));
        if (!entry) return { kind: "unresolved" };
        const parentThreadId = entry.durable.parentThreadId?.trim() ?? "";
        if (!parentThreadId) {
          if (observedParent) {
            return { kind: "subagent", context: yield* resolveRootContext(currentThreadId) };
          }
          return entry.durable.threadSource === "subAgentThreadSpawn"
            ? { kind: "unresolved" }
            : { kind: "root" };
        }
        observedParent = true;
        currentThreadId = parentThreadId;
      }
      return { kind: "unresolved" };
    },
  );

  const resolveSubagentContext = Effect.fn("CodexSubagentDirectory.resolveSubagentContext")(
    function* (
      threadId: string,
    ): Effect.fn.Return<RootContext | null, CodexSubagentDirectoryError> {
      const identity = yield* resolveSubagentIdentity(threadId);
      return identity.kind === "subagent" ? identity.context : null;
    },
  );

  const resolveSpawnParentContext = Effect.fn("CodexSubagentDirectory.resolveSpawnParentContext")(
    function* (
      parentThreadId: string,
    ): Effect.fn.Return<RootContext | null, CodexSubagentDirectoryError> {
      const parent = yield* threadDirectory
        .resolve({ threadId: parentThreadId, fidelity: "durable" })
        .pipe(Effect.mapError((cause) => error("status", parentThreadId, cause, parentThreadId)));
      if (!parent) return null;
      if (parent.durable.parentThreadId) return yield* resolveSubagentContext(parentThreadId);
      // A Subagent shell can be observed before its parent edge. Never reinterpret that shell as a
      // root: retain the child notification until the parent's discovery page commits the edge.
      if (parent.durable.threadSource === "subAgentThreadSpawn") return null;
      return yield* resolveRootContext(parentThreadId);
    },
  );

  flushPendingSpawnObservations = Effect.fn("CodexSubagentDirectory.flushPendingSpawnObservations")(
    function* (
      materializedThreadIds: readonly string[],
      publishInvalidation = true,
    ): Effect.fn.Return<void, CodexSubagentDirectoryError> {
      let frontier = new Set(
        materializedThreadIds.map((threadId) => threadId.trim()).filter(Boolean),
      );
      for (let depth = 0; depth < 128 && frontier.size > 0; depth += 1) {
        const nextFrontier = new Set<string>();
        for (const [key, entry] of pendingSpawnObservations) {
          const observation = entry.observation;
          const parentThreadId =
            observation.kind === "thread"
              ? (extractCodexThreadSubagentMetadata(observation.thread).parentThreadId?.trim() ??
                "")
              : observation.parentThreadId.trim();
          if (!frontier.has(parentThreadId)) continue;
          const context = yield* resolveSpawnParentContext(parentThreadId);
          if (!context) continue;
          if (
            context.universe.host_id !== observation.hostId ||
            context.universe.generation !== observation.generation
          ) {
            pendingSpawnObservations.delete(key);
            pendingSpawnObservationBytes -= entry.bytes;
            continue;
          }
          const thread =
            observation.kind === "thread"
              ? observation.thread
              : yield* threadDirectory
                  .resolve({ threadId: parentThreadId, fidelity: "durable" })
                  .pipe(
                    Effect.mapError((cause) =>
                      error("status", context.universe.root_thread_id, cause, parentThreadId),
                    ),
                    Effect.flatMap((parent) =>
                      parent
                        ? Effect.succeed(
                            projectStartedSubagentThreadShell({
                              parent,
                              threadId: observation.childThreadId,
                              agentPath: observation.agentPath,
                              observedAtMs: observation.observedAtMs,
                            }),
                          )
                        : Effect.succeed(null),
                    ),
                  );
          if (!thread) continue;
          pendingSpawnObservations.delete(key);
          pendingSpawnObservationBytes -= entry.bytes;
          const threadId = thread.id.trim();
          yield* applyDiscoveryPage(
            context,
            `notification:${observation.hostId}:${observation.generation}:${observation.occurrenceToken}:${threadId}`,
            [thread],
            null,
            false,
            false,
            publishInvalidation,
          );
          if (threadId) nextFrontier.add(threadId);
        }
        frontier = nextFrontier;
      }
    },
  );

  const observeNotification = Effect.fn("CodexSubagentDirectory.observeNotification")(function* (
    input: CodexSubagentNotificationObservation,
  ) {
    const notification = input.notification;
    const notificationThreadId = (() => {
      if (notification.method === "thread/started") return notification.params.thread.id;
      if ("threadId" in notification.params && typeof notification.params.threadId === "string") {
        return notification.params.threadId;
      }
      return null;
    })();

    if (notification.method === "thread/started") {
      const parentThreadId = extractCodexThreadSubagentMetadata(
        notification.params.thread,
      ).parentThreadId;
      if (!parentThreadId) return;
      const context = yield* resolveSpawnParentContext(parentThreadId);
      if (!context) {
        rememberPendingSpawnObservation({
          kind: "thread",
          hostId: input.hostId,
          generation: input.generation,
          occurrenceToken: input.occurrenceToken,
          thread: notification.params.thread,
        });
        return;
      }
      if (
        context.universe.host_id !== input.hostId ||
        context.universe.generation !== input.generation
      ) {
        return;
      }
      yield* applyDiscoveryPage(
        context,
        `notification:${input.hostId}:${input.generation}:${input.occurrenceToken}:${notification.params.thread.id}`,
        [notification.params.thread],
        null,
        false,
      );
      return;
    }

    if (
      notification.method === "item/completed" &&
      notification.params.item.type === "subAgentActivity"
    ) {
      if (notification.params.item.kind === "started") {
        const parentThreadId = notification.params.threadId.trim();
        if (!parentThreadId) return;
        const context = yield* resolveSpawnParentContext(parentThreadId);
        if (!context) {
          rememberPendingSpawnObservation({
            kind: "activity",
            hostId: input.hostId,
            generation: input.generation,
            occurrenceToken: input.occurrenceToken,
            parentThreadId,
            childThreadId: notification.params.item.agentThreadId,
            agentPath: notification.params.item.agentPath,
            observedAtMs: input.observedAtMs,
          });
          return;
        }
        if (
          context.universe.host_id !== input.hostId ||
          context.universe.generation !== input.generation
        ) {
          return;
        }
        const childThreadId = notification.params.item.agentThreadId.trim();
        if (!childThreadId) return;
        const parent = yield* threadDirectory
          .resolve({ threadId: parentThreadId, fidelity: "durable" })
          .pipe(
            Effect.mapError((cause) =>
              error("status", context.universe.root_thread_id, cause, parentThreadId),
            ),
          );
        if (!parent) return;
        yield* applyDiscoveryPage(
          context,
          `activity:${input.hostId}:${input.generation}:${input.occurrenceToken}:${childThreadId}`,
          [
            projectStartedSubagentThreadShell({
              parent,
              threadId: childThreadId,
              agentPath: notification.params.item.agentPath,
              observedAtMs: input.observedAtMs,
            }),
          ],
          null,
          false,
        );
        return;
      }
      if (
        notification.params.item.kind !== "completed" &&
        notification.params.item.kind !== "interrupted"
      ) {
        return;
      }
      const childThreadId = notification.params.item.agentThreadId.trim();
      if (!childThreadId) return;
      const identity = yield* resolveSubagentIdentity(childThreadId);
      if (identity.kind === "root") return;
      if (identity.kind === "unresolved") {
        yield* bufferStatusEvidenceBeforeIdentity({
          hostId: input.hostId,
          generation: input.generation,
          rootThreadId: null,
          threadId: childThreadId,
          status: "done",
          kind: "completion",
          sourceRevision: input.occurrenceToken,
          observedAtMs: input.observedAtMs,
          requiresMultiAgentV2: true,
        });
        return;
      }
      const context = identity.context;
      if (
        context.universe.host_id !== input.hostId ||
        context.universe.generation !== input.generation
      ) {
        return;
      }
      if (!context.capability.flags.multiAgentV2Protocol) return;
      yield* applyStatusEvidence(
        context,
        childThreadId,
        "done",
        "completion",
        input.occurrenceToken,
        input.observedAtMs,
      ).pipe(
        Effect.catch((cause) => {
          rememberPendingStatusEvidence({
            hostId: input.hostId,
            generation: input.generation,
            rootThreadId: context.universe.root_thread_id,
            threadId: childThreadId,
            status: "done",
            kind: "completion",
            sourceRevision: input.occurrenceToken,
            observedAtMs: input.observedAtMs,
            requiresMultiAgentV2: true,
          });
          schedulePendingStatusRepair(context);
          scheduleDiscoveryRepair(context);
          // Keep the in-process repair hot, but also fail the owning notification consequence.
          // The application inbox will fence and reconnect this exact Endpoint generation, so a
          // Main crash cannot acknowledge-and-lose the strongest completion observation.
          return Effect.fail(cause);
        }),
      );
      return;
    }

    if (!notificationThreadId) return;
    if (notification.method === "thread/archived" || notification.method === "thread/deleted") {
      const context = yield* resolveSubagentContext(notificationThreadId);
      if (
        context &&
        context.universe.host_id === input.hostId &&
        context.universe.generation === input.generation
      ) {
        yield* publishOverviewInvalidation(context);
      }
      return;
    }
    let evidence: {
      readonly status: "active" | "waiting" | "done" | "unknown";
      readonly kind: "notification" | "completion";
    } | null = null;
    if (notification.method === "thread/status/changed") {
      const status = parseThreadStatus(notification.params.status);
      evidence = {
        status: projectCodexSubagentThreadStatus({
          statusType: status.statusType,
          activeFlags: status.statusActiveFlags,
        }),
        kind: "notification",
      };
    } else if (notification.method === "turn/started") {
      evidence = { status: "active", kind: "notification" };
    } else if (
      notification.method === "turn/completed" &&
      notification.params.turn.status !== "inProgress"
    ) {
      evidence =
        notification.params.turn.status === "interrupted"
          ? { status: "unknown", kind: "notification" }
          : { status: "done", kind: "completion" };
    }
    if (!evidence) return;

    const identity = yield* resolveSubagentIdentity(notificationThreadId);
    if (identity.kind === "root") return;
    if (identity.kind === "unresolved") {
      yield* bufferStatusEvidenceBeforeIdentity({
        hostId: input.hostId,
        generation: input.generation,
        rootThreadId: null,
        threadId: notificationThreadId,
        status: evidence.status,
        kind: evidence.kind,
        sourceRevision: input.occurrenceToken,
        observedAtMs: input.observedAtMs,
        requiresMultiAgentV2: false,
      });
      return;
    }
    const context = identity.context;
    if (
      context.universe.host_id !== input.hostId ||
      context.universe.generation !== input.generation
    ) {
      return;
    }

    yield* applyStatusEvidence(
      context,
      notificationThreadId,
      evidence.status,
      evidence.kind,
      input.occurrenceToken,
      input.observedAtMs,
    ).pipe(
      Effect.catch((cause) => {
        rememberPendingStatusEvidence({
          hostId: input.hostId,
          generation: input.generation,
          rootThreadId: context.universe.root_thread_id,
          threadId: notificationThreadId,
          status: evidence.status,
          kind: evidence.kind,
          sourceRevision: input.occurrenceToken,
          observedAtMs: input.observedAtMs,
          requiresMultiAgentV2: context.capability.flags.multiAgentV2Protocol,
        });
        schedulePendingStatusRepair(context);
        scheduleDiscoveryRepair(context);
        return Effect.fail(cause);
      }),
    );
  });

  const hydrateSelected = (input: CodexSelectedSubagentHydrateInput) =>
    runOwned(
      Effect.gen(function* () {
        const rootThreadId = input.rootThreadId.trim();
        const threadId = input.threadId.trim();
        const normalizedInput = { rootThreadId, threadId };
        if (!rootThreadId || !threadId)
          return emptySelectedResult(normalizedInput, "Thread id is required");
        const rootGeneration = conversations.read(rootThreadId)?.generation;
        const childGeneration = conversations.read(threadId)?.generation;
        let accepted = yield* isDescendant(rootThreadId, threadId);
        if (!accepted) {
          yield* readOverview({ rootThreadId, mode: "expanded" });
          accepted = yield* isDescendant(rootThreadId, threadId);
        }
        if (!accepted) {
          return emptySelectedResult(
            normalizedInput,
            "Selected Thread is not a Subagent descendant",
          );
        }

        const rootContext = yield* resolveRootContext(rootThreadId);
        const resident = yield* threadDirectory
          .resolve({ threadId, fidelity: "durable" })
          .pipe(Effect.mapError((cause) => error("hydrate", rootThreadId, cause, threadId)));
        const hasSparseResidentHistory = hasSelectedSubagentHistory(resident);
        const selected = hasSparseResidentHistory
          ? resident
          : yield* threadDirectory
              .resolve({ threadId, fidelity: "tail" })
              .pipe(Effect.mapError((cause) => error("hydrate", rootThreadId, cause, threadId)));
        if (!selected)
          return emptySelectedResult(normalizedInput, "Selected Thread is unavailable");

        const selectedGeneration = conversations.read(threadId)?.generation;
        if (childGeneration !== undefined && selectedGeneration !== childGeneration)
          return emptySelectedResult(normalizedInput, "Selected Thread changed while opening");
        if (hasSelectedSubagentHistory(selected))
          yield* managers
            .shareResident(rootContext.capability.hostId, threadId)
            .pipe(Effect.mapError((cause) => error("hydrate", rootThreadId, cause, threadId)));
        const overviewItem = yield* readOverviewItem(rootContext, threadId);
        if (!overviewItem.item)
          return emptySelectedResult(
            normalizedInput,
            "Selected Thread is outside the current Subagent projection",
          );
        const hostCurrent = yield* capabilities.isCurrent(rootContext.capability);
        const view = conversations.read(threadId);
        if (
          !hostCurrent ||
          conversations.read(rootThreadId)?.generation !== rootGeneration ||
          view?.generation !== selectedGeneration
        )
          return emptySelectedResult(normalizedInput, "Selected Thread changed while opening");

        // Authority lookup can yield while the same entity releases its history.
        const current = view
          ? { ...selected, canonical: view.canonicalState, snapshot: view.snapshot }
          : selected;
        const attachedSparse = hasSelectedSubagentHistory(current);
        const fidelity = !attachedSparse
          ? "metadata"
          : hasSparseResidentHistory
            ? "residentSparse"
            : "attachedSparse";
        const snapshot = current.snapshot;
        remember(threadId, true);
        const checkpoint = view
          ? JSON.stringify(view.historyCheckpoint)
          : snapshot
            ? JSON.stringify([
                snapshot.conversationEntityGeneration ?? 0,
                snapshot.historyTopologyGeneration ?? 0,
                snapshot.historyMutationRevision ?? 0,
              ])
            : null;
        return {
          rootThreadId,
          threadId,
          revision: overviewItem.projection_revision,
          fidelity,
          checkpoint,
          canInteract:
            interactionReferences(selected.durable.parentThreadId).get(threadId)?.canInteract ===
              true &&
            !selected.summary.archived &&
            !overviewItem.item.thread.archived &&
            fidelity !== "metadata",
          outcome: fidelity === "metadata" ? "unavailable" : "ready",
          errorMessage:
            fidelity === "metadata" ? "This Agent does not expose bounded history" : null,
        } satisfies CodexSelectedSubagentHydrateResult;
      }).pipe(
        Effect.catch((cause) =>
          Effect.succeed(
            emptySelectedResult(
              input,
              cause instanceof Error ? cause.message : "Could not open the selected Subagent",
            ),
          ),
        ),
      ),
    ).pipe(
      Effect.catch((cause) =>
        Effect.succeed(
          emptySelectedResult(
            input,
            cause instanceof Error ? cause.message : "Could not open the selected Subagent",
          ),
        ),
      ),
    );

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      discoverySnapshots.clear();
      known.clear();
      knownRoots.clear();
      pendingStatusEvidence.clear();
      pendingSpawnObservations.clear();
      pendingSpawnObservationBytes = 0;
    }),
  );

  return CodexSubagentDirectory.of({
    readOverview: (input) => runOwned(readOverview(input)),
    readKnownOverview: (input) => runOwned(readKnownOverview(input)),
    hydrateSelected,
    observeNotification: (input) => runOwned(observeNotification(input)),
    reconcileAfterReconnect: (input) =>
      runOwned(reconcileAfterReconnect(input)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not start Subagent reconnect reconciliation").pipe(
            Effect.annotateLogs({ cause }),
          ),
        ),
      ),
    settleInterruptedSubtree: (rootThreadId) => runOwned(settleInterruptedSubtree(rootThreadId)),
    observe: (threadId) => {
      remember(threadId, false);
    },
    shouldDropDelta: (method, threadId) => {
      const normalized = threadId?.trim() ?? "";
      return (
        normalized.length > 0 &&
        BACKGROUND_DELTA_METHODS.has(method) &&
        known.get(normalized) === false
      );
    },
    clear: (threadId) => {
      known.delete(threadId.trim());
    },
  });
});
