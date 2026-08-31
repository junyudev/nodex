import { createHash, randomUUID } from "node:crypto";
import type { Thread, ThreadListParams, Turn } from "@nodex/codex-app-server-protocol/v2";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
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
  CODEX_SUBAGENT_LIFECYCLE_BATCH_LIMIT,
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
import { CoreModuleResponseError } from "../core-client/core-client";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway, codexGatewayGenerationFence } from "../codex-runtime/CodexGateway";
import { projectCodexGatewayThreadReadThread } from "../codex-runtime/CodexGatewayProtocolProjection";
import {
  isCodexThreadLifecycleAlreadyAppliedRequestError,
  isCodexThreadStopAlreadySettledRequestError,
} from "../codex-runtime/CodexRuntimeError";
import { CoreModules } from "../core-runtime/CoreModules";
import { CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { createOperationId } from "../core-runtime/operation-identity";
import type { CodexServerNotification } from "../codex-runtime/CodexApplicationProtocol";
import { projectCodexThreadDirectoryMaterialization } from "./CodexThreadDirectoryProjection";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexThreadDirectory, type CodexThreadDirectoryEntry } from "./CodexThreadDirectory";
import { CodexConversations } from "./CodexConversations";
import {
  projectCodexSubagentOverviewWindow,
  type CoreSubagentOverviewLike,
} from "./CodexSubagentDirectoryProjection";
import { parseThreadStatus } from "./CodexThreadCatalogProjection";

const DISCOVERY_PAGE_BYTES = 8 * 1024 * 1024;
const TOPOLOGY_PASS_BYTES = 8 * 1024 * 1024;
const TOPOLOGY_TOTAL_BYTES = 64 * 1024 * 1024;
const TOPOLOGY_TOTAL_PAGES = 200;
const TOPOLOGY_TOTAL_TIME_MS = 5 * 60_000;
const DISCOVERY_PASS_DEADLINE_MS = 30_000;
const DISCOVERY_PAGE_TIMEOUT_MS = 10_000;
const DISCOVERY_MAX_PAGES_PER_PASS = 10;
const EXPANDED_WINDOW_PAGE_SIZE = 200;
const EXPANDED_WINDOW_MAX_PAGES = 32;
const EXPANDED_WINDOW_MAX_SNAPSHOT_ATTEMPTS = 3;
const LIFECYCLE_MAX_PAGES = Math.ceil(
  (1 + EXPANDED_WINDOW_PAGE_SIZE * EXPANDED_WINDOW_MAX_PAGES) /
    CODEX_SUBAGENT_LIFECYCLE_BATCH_LIMIT,
);
const LIFECYCLE_POSTCONDITION_BYTES = 64 * 1024 * 1024;
const LIFECYCLE_POSTCONDITION_DEADLINE_MS = 30_000;
const INTERRUPT_SETTLEMENT_BUDGET_MS = 4_750;
const INTERRUPT_COMPLETION_GRACE_MS = 500;
const RECONNECT_ROOT_RECONCILIATION_BUDGET_MS = 15_000;
const RECONNECT_UNRESOLVED_LIMIT = 32;
const KNOWN_SUBAGENT_ADMISSION_LIMIT = 4_096;
const PENDING_STATUS_EVIDENCE_LIMIT = 4_096;
const PENDING_SPAWN_OBSERVATION_LIMIT = 4_096;
const PENDING_SPAWN_OBSERVATION_ENTRY_BYTES = 256 * 1_024;
const PENDING_SPAWN_OBSERVATION_TOTAL_BYTES = 8 * 1_024 * 1_024;
const LIFECYCLE_QUARANTINE_LIMIT = 1_024;
const LEGACY_DISCOVERY_FRONTIER_LIMIT = 1 + EXPANDED_WINDOW_PAGE_SIZE * EXPANDED_WINDOW_MAX_PAGES;
const LEGACY_DISCOVERY_CONTINUATION_BYTES = 512 * 1024;
const LEGACY_DISCOVERY_CONTINUATION_PREFIX = "subagent-bfs-v1:";
const ANCESTOR_DISCOVERY_CONTINUATION_PREFIX = "subagent-ancestor-v1:";

type CoreSubagentOverview = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { readonly kind: "subagent_overview_window" }
>["overview"];

type CoreSubagentLifecycle = Extract<
  ProjectWorkspaceReadSnapshot["value"],
  { readonly kind: "subagent_lifecycle_batch" }
>["lifecycle"];

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

interface LegacyDiscoveryState {
  readonly phase: "list" | "topology";
  readonly scanId: string;
  readonly parents: readonly string[];
  readonly parentIndex: number;
  readonly cursor: string | null;
  readonly repairRound: number;
  readonly scannedPages: number;
  readonly scannedBytes: number;
  readonly spentMs: number;
}

type AncestorDiscoveryState =
  | {
      readonly phase: "list";
      readonly scanId: string;
      readonly cursor: string | null;
      readonly useStateDbOnly: boolean;
      readonly seenObservedThreadIds: readonly string[];
      readonly knownThreadIds: readonly string[];
      readonly requiresTopologyRepair: boolean;
    }
  | {
      readonly phase: "repair";
      readonly scanId: string;
      readonly repairRound: number;
      readonly seenObservedThreadIds: readonly string[];
      readonly knownThreadIds: readonly string[];
      readonly requiresTopologyRepair: true;
    }
  | {
      readonly phase: "topology";
      readonly scanId: string;
      readonly parents: readonly string[];
      readonly parentIndex: number;
      readonly cursor: string | null;
      readonly repairRound: number;
      readonly scannedPages: number;
      readonly scannedBytes: number;
      readonly spentMs: number;
    };

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

export interface CodexSubagentLifecycleSnapshot {
  readonly operationId: string;
  readonly action: "archive" | "delete";
  readonly expectedCount: number;
  readonly processedCount: number;
  readonly unresolvedCount: number;
  readonly complete: boolean;
}

export interface CodexSubagentInterruptSnapshot {
  /** False when discovery has not reached an authoritative end for this host generation. */
  readonly discoveryComplete: boolean;
  readonly interruptedThreadIds: readonly string[];
  readonly failed: ReadonlyArray<{ readonly threadId: string; readonly reason: string }>;
  readonly unresolvedThreadIds: readonly string[];
}

type CodexSubagentInterruptOutcome =
  | { readonly threadId: string; readonly outcome: "settled" | "interrupted" }
  | { readonly threadId: string; readonly outcome: "unresolved" }
  | { readonly threadId: string; readonly outcome: "failed"; readonly reason: string };

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
    readonly beginLifecycle: (input: {
      readonly rootThreadId: string;
      readonly action: "archive" | "delete";
    }) => Effect.Effect<CodexSubagentLifecycleSnapshot, CodexSubagentDirectoryError>;
    /** Reconciles the durable expected closure without requiring the root Thread to still exist. */
    readonly reconcileLifecycle: (input: {
      readonly operationId: string;
    }) => Effect.Effect<CodexSubagentLifecycleSnapshot, CodexSubagentDirectoryError>;
    readonly settleInterruptedSubtree: (
      rootThreadId: string,
      options?: { readonly deadlineAtMs: number },
    ) => Effect.Effect<CodexSubagentInterruptSnapshot, CodexSubagentDirectoryError>;
    readonly shouldDeferLifecycleNotification: (
      threadId: string,
      method: "thread/archived" | "thread/deleted",
    ) => Effect.Effect<boolean, CodexSubagentDirectoryError>;
    readonly releaseLifecycleQuarantine: (
      rootThreadId: string,
      action: "archive" | "delete",
    ) => void;
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
    id: input.threadId,
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
    modelProvider: input.parent.canonical?.protocol.modelProvider ?? "",
    turns: [],
  };
};

const isCoreNotFound = (cause: unknown): boolean => {
  if (cause instanceof CodexSubagentDirectoryError) return isCoreNotFound(cause.cause);
  return (
    cause instanceof CoreRuntimeError &&
    cause.cause instanceof CoreModuleResponseError &&
    cause.cause.coreError.code === "not_found"
  );
};

const encodeLegacyDiscoveryState = (state: LegacyDiscoveryState): string => {
  const encoded = `${LEGACY_DISCOVERY_CONTINUATION_PREFIX}${JSON.stringify(state)}`;
  if (Buffer.byteLength(encoded, "utf8") > LEGACY_DISCOVERY_CONTINUATION_BYTES) {
    throw new Error("Legacy Subagent discovery continuation exceeded its byte budget");
  }
  return encoded;
};

const decodeLegacyDiscoveryState = (
  continuation: string | null,
  rootThreadId: string,
): LegacyDiscoveryState => {
  if (continuation === null)
    return {
      phase: "list",
      scanId: randomUUID(),
      parents: [rootThreadId],
      parentIndex: 0,
      cursor: null,
      repairRound: 0,
      scannedPages: 0,
      scannedBytes: 0,
      spentMs: 0,
    };
  if (!continuation.startsWith(LEGACY_DISCOVERY_CONTINUATION_PREFIX)) {
    throw new Error("Legacy Subagent discovery continuation is incompatible");
  }
  if (Buffer.byteLength(continuation, "utf8") > LEGACY_DISCOVERY_CONTINUATION_BYTES) {
    throw new Error("Legacy Subagent discovery continuation exceeded its byte budget");
  }
  const value: unknown = JSON.parse(
    continuation.slice(LEGACY_DISCOVERY_CONTINUATION_PREFIX.length),
  );
  if (typeof value !== "object" || value === null) {
    throw new Error("Legacy Subagent discovery continuation is invalid");
  }
  const record = value as Record<string, unknown>;
  const phase = record.phase ?? "list";
  const scanId = typeof record.scanId === "string" ? record.scanId : randomUUID();
  const parents = Array.isArray(record.parents)
    ? record.parents.filter(
        (parent): parent is string => typeof parent === "string" && parent.length > 0,
      )
    : [];
  const parentIndex = record.parentIndex;
  const cursor = record.cursor;
  const repairRound = record.repairRound ?? 0;
  const scannedPages = record.scannedPages ?? 0;
  const scannedBytes = record.scannedBytes ?? 0;
  const spentMs = record.spentMs ?? 0;
  if (
    (phase !== "list" && phase !== "topology") ||
    parents.length === 0 ||
    parents.length > LEGACY_DISCOVERY_FRONTIER_LIMIT ||
    parents[0] !== rootThreadId ||
    new Set(parents).size !== parents.length ||
    typeof parentIndex !== "number" ||
    !Number.isSafeInteger(parentIndex) ||
    parentIndex < 0 ||
    parentIndex > parents.length ||
    (cursor !== null && typeof cursor !== "string") ||
    typeof repairRound !== "number" ||
    !Number.isSafeInteger(repairRound) ||
    repairRound < 0 ||
    typeof scannedPages !== "number" ||
    !Number.isSafeInteger(scannedPages) ||
    scannedPages < 0 ||
    typeof scannedBytes !== "number" ||
    !Number.isSafeInteger(scannedBytes) ||
    scannedBytes < 0 ||
    typeof spentMs !== "number" ||
    !Number.isSafeInteger(spentMs) ||
    spentMs < 0 ||
    scanId.length === 0
  ) {
    throw new Error("Legacy Subagent discovery continuation is invalid");
  }
  return {
    phase,
    scanId,
    parents,
    parentIndex,
    cursor,
    repairRound,
    scannedPages,
    scannedBytes,
    spentMs,
  };
};

const encodeAncestorDiscoveryState = (state: AncestorDiscoveryState): string => {
  const encoded = `${ANCESTOR_DISCOVERY_CONTINUATION_PREFIX}${JSON.stringify(state)}`;
  if (Buffer.byteLength(encoded, "utf8") > LEGACY_DISCOVERY_CONTINUATION_BYTES) {
    throw new Error("Subagent ancestor discovery continuation exceeded its byte budget");
  }
  return encoded;
};

const decodeAncestorDiscoveryState = (continuation: string | null): AncestorDiscoveryState => {
  if (continuation === null) {
    return {
      phase: "list",
      scanId: randomUUID(),
      cursor: null,
      useStateDbOnly: true,
      seenObservedThreadIds: [],
      knownThreadIds: [],
      requiresTopologyRepair: false,
    };
  }
  if (!continuation.startsWith(ANCESTOR_DISCOVERY_CONTINUATION_PREFIX)) {
    return {
      phase: "list",
      scanId: randomUUID(),
      cursor: continuation,
      useStateDbOnly: true,
      seenObservedThreadIds: [],
      knownThreadIds: [],
      requiresTopologyRepair: false,
    };
  }
  if (Buffer.byteLength(continuation, "utf8") > LEGACY_DISCOVERY_CONTINUATION_BYTES) {
    throw new Error("Subagent ancestor discovery continuation exceeded its byte budget");
  }
  const value: unknown = JSON.parse(
    continuation.slice(ANCESTOR_DISCOVERY_CONTINUATION_PREFIX.length),
  );
  if (typeof value !== "object" || value === null) {
    throw new Error("Subagent ancestor discovery continuation is invalid");
  }
  const record = value as Record<string, unknown>;
  const phase = record.phase;
  const scanId = record.scanId;
  const seenObservedThreadIds = Array.isArray(record.seenObservedThreadIds)
    ? record.seenObservedThreadIds.filter(
        (threadId): threadId is string => typeof threadId === "string" && threadId.length > 0,
      )
    : [];
  const knownThreadIds = Array.isArray(record.knownThreadIds)
    ? record.knownThreadIds.filter(
        (threadId): threadId is string => typeof threadId === "string" && threadId.length > 0,
      )
    : [];
  if (
    (phase !== "list" && phase !== "repair" && phase !== "topology") ||
    typeof scanId !== "string" ||
    scanId.length === 0 ||
    seenObservedThreadIds.length > LEGACY_DISCOVERY_FRONTIER_LIMIT ||
    new Set(seenObservedThreadIds).size !== seenObservedThreadIds.length ||
    knownThreadIds.length > LEGACY_DISCOVERY_FRONTIER_LIMIT ||
    new Set(knownThreadIds).size !== knownThreadIds.length
  ) {
    throw new Error("Subagent ancestor discovery continuation is invalid");
  }
  if (phase === "repair") {
    const repairRound = record.repairRound ?? 0;
    if (typeof repairRound !== "number" || !Number.isSafeInteger(repairRound) || repairRound < 0) {
      throw new Error("Subagent ancestor discovery continuation is invalid");
    }
    return {
      phase,
      scanId,
      repairRound,
      seenObservedThreadIds,
      knownThreadIds,
      requiresTopologyRepair: true,
    };
  }
  if (phase === "topology") {
    const parents = Array.isArray(record.parents)
      ? record.parents.filter(
          (threadId): threadId is string => typeof threadId === "string" && threadId.length > 0,
        )
      : [];
    const parentIndex = record.parentIndex;
    const cursor = record.cursor;
    const repairRound = record.repairRound ?? 0;
    const scannedPages = record.scannedPages ?? 0;
    const scannedBytes = record.scannedBytes ?? 0;
    const spentMs = record.spentMs ?? 0;
    if (
      parents.length === 0 ||
      parents.length > LEGACY_DISCOVERY_FRONTIER_LIMIT ||
      new Set(parents).size !== parents.length ||
      typeof parentIndex !== "number" ||
      !Number.isSafeInteger(parentIndex) ||
      parentIndex < 0 ||
      parentIndex > parents.length ||
      (cursor !== null && typeof cursor !== "string") ||
      typeof repairRound !== "number" ||
      !Number.isSafeInteger(repairRound) ||
      repairRound < 0 ||
      typeof scannedPages !== "number" ||
      !Number.isSafeInteger(scannedPages) ||
      scannedPages < 0 ||
      typeof scannedBytes !== "number" ||
      !Number.isSafeInteger(scannedBytes) ||
      scannedBytes < 0 ||
      typeof spentMs !== "number" ||
      !Number.isSafeInteger(spentMs) ||
      spentMs < 0
    ) {
      throw new Error("Subagent ancestor discovery continuation is invalid");
    }
    return {
      phase,
      scanId,
      parents,
      parentIndex,
      cursor,
      repairRound,
      scannedPages,
      scannedBytes,
      spentMs,
    };
  }
  const cursor = record.cursor;
  const requiresTopologyRepair = record.requiresTopologyRepair ?? false;
  if (
    (cursor !== null && typeof cursor !== "string") ||
    typeof record.useStateDbOnly !== "boolean" ||
    typeof requiresTopologyRepair !== "boolean"
  ) {
    throw new Error("Subagent ancestor discovery continuation is invalid");
  }
  return {
    phase,
    scanId,
    cursor,
    useStateDbOnly: record.useStateDbOnly,
    seenObservedThreadIds,
    knownThreadIds,
    requiresTopologyRepair,
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

const lifecycleOperationId = (context: RootContext, action: "archive" | "delete"): string =>
  `subagent-lifecycle:${createHash("sha256")
    .update(JSON.stringify([context.universe.host_id, context.universe.root_thread_id, action]))
    .digest("hex")}`;

const projectLifecycleSnapshot = (
  lifecycle: CoreSubagentLifecycle,
): CodexSubagentLifecycleSnapshot => ({
  operationId: lifecycle.lifecycle_operation_id,
  action: lifecycle.action,
  expectedCount: lifecycle.expected_count,
  processedCount: lifecycle.processed_count,
  unresolvedCount: lifecycle.unresolved_count,
  complete: lifecycle.complete,
});

const discoveryKey = (context: RootContext): string =>
  `${context.universe.host_id}\0${context.universe.generation}\0${context.universe.root_thread_id}`;

export const make: Effect.Effect<
  CodexSubagentDirectory["Service"],
  never,
  | CodexAppServerCapabilities
  | CodexApplicationEventHub
  | CodexConversations
  | CodexGateway
  | CodexThreadDirectory
  | CoreModules
  | Scope.Scope
> = Effect.gen(function* () {
  const ownerScope = yield* Scope.Scope;
  const capabilities = yield* CodexAppServerCapabilities;
  const events = yield* CodexApplicationEventHub;
  const conversations = yield* CodexConversations;
  const gateway = yield* CodexGateway;
  const threadDirectory = yield* CodexThreadDirectory;
  const core = yield* CoreModules;
  const discoveries = yield* FiberMap.make<string, void, CodexSubagentDirectoryError>();
  const runDiscovery = yield* FiberMap.runtime(discoveries)();
  const foregroundDiscoveries = yield* FiberMap.make<string, void, CodexSubagentDirectoryError>();
  const runForegroundDiscovery = yield* FiberMap.runtime(foregroundDiscoveries)();
  const statusRepairs = yield* FiberMap.make<string, void>();
  const runStatusRepair = yield* FiberMap.runtime(statusRepairs)();
  const known = new Map<string, boolean>();
  const knownRoots = new Set<string>();
  const pendingStatusEvidence = new Map<string, PendingStatusEvidence>();
  const pendingSpawnObservations = new Map<string, PendingSpawnEntry>();
  let pendingSpawnObservationBytes = 0;
  const lifecycleQuarantines = new Map<string, "archive" | "delete">();
  let flushPendingSpawnObservations: (
    materializedThreadIds: readonly string[],
    publishInvalidation?: boolean,
  ) => Effect.Effect<void, CodexSubagentDirectoryError> = () => Effect.void;
  let schedulePendingStatusRepair: (context: RootContext) => void = () => undefined;

  const hasLiveRootOwner = (context: RootContext): boolean => {
    const conversation = conversations.read(context.universe.root_thread_id);
    if (!conversation) return false;
    if (context.root.durable.statusType === "active") return true;
    return (
      conversation.canonicalState?.turns.some((turn) => turn.protocol?.status === "inProgress") ===
      true
    );
  };

  const observedSubagentThreadIds = (
    rootThreadId: string,
    knownParentThreadIds: Iterable<string> = [],
  ): ReadonlySet<string> => {
    const ids = new Set<string>();
    for (const parentThreadId of topologyParents(rootThreadId, knownParentThreadIds)) {
      const state = conversations.read(parentThreadId)?.canonicalState;
      if (!state) continue;
      for (const turn of state.turns) {
        for (const item of turn.items) {
          if (item.type === "collabAgentToolCall") {
            if (item.tool !== "spawnAgent") continue;
            for (const rawThreadId of item.receiverThreadIds) {
              const threadId = rawThreadId.trim();
              if (threadId && threadId !== rootThreadId) ids.add(threadId);
            }
            continue;
          }
          if (item.type !== "subAgentActivity") continue;
          const threadId = item.agentThreadId.trim();
          if (threadId && threadId !== rootThreadId) ids.add(threadId);
        }
      }
    }
    return ids;
  };

  const referencedSubagentThreadIds = (turns: readonly Turn[]): ReadonlySet<string> => {
    const ids = new Set<string>();
    for (const turn of turns) {
      for (const item of turn.items) {
        if (item.type === "collabAgentToolCall") {
          if (item.tool !== "spawnAgent") continue;
          for (const rawThreadId of item.receiverThreadIds) {
            const threadId = rawThreadId.trim();
            if (threadId) ids.add(threadId);
          }
          continue;
        }
        if (item.type !== "subAgentActivity") continue;
        const threadId = item.agentThreadId.trim();
        if (threadId) ids.add(threadId);
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

  const requestDiscoveryPage = (
    context: RootContext,
    cursor: string | null,
    useStateDbOnly: boolean,
  ) => {
    const params: ThreadListParams = {
      cursor,
      limit: CODEX_SUBAGENT_DISCOVERY_PAGE_LIMIT,
      sortKey: "created_at",
      sortDirection: "desc",
      sourceKinds: ["subAgentThreadSpawn"],
      archived: false,
      useStateDbOnly,
      ancestorThreadId: context.universe.root_thread_id,
    };
    return gateway.requestOnHost(context.universe.host_id, "thread/list", params, {
      priority: "background",
      source: "collab_hydration",
      conversationId: context.universe.root_thread_id,
      widgetId: "subagent-overview:discovery",
      coalesce: true,
      timeoutMs: DISCOVERY_PAGE_TIMEOUT_MS,
      ...codexGatewayGenerationFence(context.capability),
    });
  };

  const requestLegacyDiscoveryPage = (
    context: RootContext,
    parentThreadId: string,
    cursor: string | null,
    useStateDbOnly: boolean,
  ) =>
    gateway.requestOnHost(
      context.universe.host_id,
      "thread/list",
      {
        cursor,
        limit: CODEX_SUBAGENT_DISCOVERY_PAGE_LIMIT,
        sortKey: "created_at",
        sortDirection: "desc",
        sourceKinds: ["subAgentThreadSpawn"],
        archived: false,
        useStateDbOnly,
        parentThreadId,
      },
      {
        priority: "background",
        source: "collab_hydration",
        conversationId: context.universe.root_thread_id,
        widgetId: "subagent-overview:legacy-discovery",
        coalesce: true,
        timeoutMs: DISCOVERY_PAGE_TIMEOUT_MS,
        ...codexGatewayGenerationFence(context.capability),
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
    if (cappedApproximateValueBytes(threads, DISCOVERY_PAGE_BYTES) > DISCOVERY_PAGE_BYTES) {
      return yield* error(
        "discover",
        context.universe.root_thread_id,
        new Error("Subagent discovery page exceeded its byte budget"),
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

  const scanTopologyPage = Effect.fn("CodexSubagentDirectory.scanTopologyPage")(function* (
    context: RootContext,
    state: {
      readonly parents: readonly string[];
      readonly parentIndex: number;
      readonly cursor: string | null;
      readonly repairRound: number;
    },
  ): Effect.fn.Return<
    {
      readonly threads: readonly Thread[];
      readonly parents: readonly string[];
      readonly parentIndex: number;
      readonly cursor: string | null;
      readonly repairRound: number;
      readonly complete: boolean;
      readonly madeProgress: boolean;
      readonly responseBytes: number;
    },
    CodexSubagentDirectoryError
  > {
    if (state.parentIndex >= state.parents.length) {
      return { ...state, threads: [], complete: true, madeProgress: true, responseBytes: 0 };
    }
    const parentThreadId = state.parents[state.parentIndex]!;
    const response: ClientRequestResponsesByMethod["thread/turns/list"] = yield* gateway
      .requestOnHost(
        context.universe.host_id,
        "thread/turns/list",
        {
          threadId: parentThreadId,
          cursor: state.cursor,
          limit: 5,
          sortDirection: "asc",
          itemsView: "full",
        },
        {
          priority: "background",
          source: "collab_hydration",
          conversationId: context.universe.root_thread_id,
          widgetId: "subagent-overview:topology-repair",
          coalesce: true,
          timeoutMs: DISCOVERY_PAGE_TIMEOUT_MS,
          ...codexGatewayGenerationFence(context.capability),
        },
      )
      .pipe(Effect.mapError((cause) => error("discover", context.universe.root_thread_id, cause)));
    const responseBytes = cappedApproximateValueBytes(response.data, DISCOVERY_PAGE_BYTES);
    if (responseBytes > DISCOVERY_PAGE_BYTES) {
      return {
        ...state,
        threads: [],
        complete: false,
        madeProgress: false,
        responseBytes,
      };
    }
    const nextCursor = response.nextCursor ?? null;
    if (nextCursor !== null && nextCursor === state.cursor) {
      return {
        ...state,
        threads: [],
        repairRound: state.repairRound + 1,
        complete: false,
        madeProgress: false,
        responseBytes,
      };
    }

    const knownThreadIds = new Set(state.parents);
    const referencedThreadIds = [
      ...referencedSubagentThreadIds(response.data as unknown as readonly Turn[]),
    ].filter((threadId) => threadId !== parentThreadId && !knownThreadIds.has(threadId));
    if (referencedThreadIds.length > CODEX_SUBAGENT_DISCOVERY_PAGE_LIMIT) {
      return {
        ...state,
        threads: [],
        repairRound: state.repairRound + 1,
        complete: false,
        madeProgress: false,
        responseBytes: DISCOVERY_PAGE_BYTES + 1,
      };
    }
    const candidates = yield* Effect.forEach(
      referencedThreadIds,
      (threadId) =>
        gateway
          .requestOnHost(
            context.universe.host_id,
            "thread/read",
            { threadId, includeTurns: false },
            {
              priority: "background",
              source: "collab_hydration",
              conversationId: context.universe.root_thread_id,
              widgetId: "subagent-overview:topology-metadata",
              coalesce: true,
              timeoutMs: DISCOVERY_PAGE_TIMEOUT_MS,
              ...codexGatewayGenerationFence(context.capability),
            },
          )
          .pipe(
            Effect.map((result) => projectCodexGatewayThreadReadThread(result.thread)),
            Effect.map((thread) => {
              const observedParent = extractCodexThreadSubagentMetadata(thread).parentThreadId;
              return thread.id === threadId &&
                thread.turns.length === 0 &&
                observedParent === parentThreadId
                ? ({ _tag: "Verified", thread } as const)
                : ({ _tag: "Unresolved" } as const);
            }),
            Effect.catch(() => Effect.succeed({ _tag: "Unresolved" } as const)),
          ),
      { concurrency: 2 },
    );
    const unresolved = candidates.some((candidate) => candidate._tag === "Unresolved");
    if (unresolved) {
      return {
        ...state,
        threads: [],
        repairRound: state.repairRound + 1,
        complete: false,
        madeProgress: false,
        responseBytes,
      };
    }
    const threads = candidates.flatMap((candidate) =>
      candidate._tag === "Verified" ? [candidate.thread] : [],
    );
    const metadataBytes = cappedApproximateValueBytes(threads, DISCOVERY_PAGE_BYTES);
    const totalResponseBytes = responseBytes + metadataBytes;
    if (metadataBytes > DISCOVERY_PAGE_BYTES || totalResponseBytes > DISCOVERY_PAGE_BYTES) {
      return {
        ...state,
        threads: [],
        repairRound: state.repairRound + 1,
        complete: false,
        madeProgress: false,
        responseBytes: DISCOVERY_PAGE_BYTES + 1,
      };
    }
    const parents = [...state.parents];
    for (const thread of threads) {
      if (parents.length >= LEGACY_DISCOVERY_FRONTIER_LIMIT) {
        return {
          ...state,
          threads: [],
          repairRound: state.repairRound + 1,
          complete: false,
          madeProgress: false,
          responseBytes: DISCOVERY_PAGE_BYTES + 1,
        };
      }
      parents.push(thread.id);
    }
    const parentIndex = nextCursor === null ? state.parentIndex + 1 : state.parentIndex;
    return {
      threads,
      parents,
      parentIndex,
      cursor: nextCursor,
      repairRound: 0,
      complete: parentIndex >= parents.length,
      madeProgress: true,
      responseBytes: totalResponseBytes,
    };
  });

  const discoverLegacyPages = Effect.fn("CodexSubagentDirectory.discoverLegacyPages")(function* (
    context: RootContext,
    initialContinuation: string | null,
    maximumPages: number,
  ): Effect.fn.Return<string | null, CodexSubagentDirectoryError> {
    let state = yield* Effect.try({
      try: () => decodeLegacyDiscoveryState(initialContinuation, context.universe.root_thread_id),
      catch: (cause) => error("discover", context.universe.root_thread_id, cause),
    });
    const startedAtMs = yield* Clock.currentTimeMillis;
    let topologyBytes = 0;

    for (let page = 0; page < maximumPages; page += 1) {
      if ((yield* Clock.currentTimeMillis) - startedAtMs >= DISCOVERY_PASS_DEADLINE_MS) {
        return yield* Effect.try({
          try: () => encodeLegacyDiscoveryState(state),
          catch: (cause) => error("discover", context.universe.root_thread_id, cause),
        });
      }
      if (state.phase === "topology") {
        const coordinate = encodeLegacyDiscoveryState(state);
        if (
          state.scannedPages >= TOPOLOGY_TOTAL_PAGES ||
          state.scannedBytes + DISCOVERY_PAGE_BYTES > TOPOLOGY_TOTAL_BYTES ||
          state.spentMs >= TOPOLOGY_TOTAL_TIME_MS
        ) {
          return coordinate;
        }
        const scanStartedAtMs = yield* Clock.currentTimeMillis;
        const passRemainingMs = Math.max(
          1,
          DISCOVERY_PASS_DEADLINE_MS - (scanStartedAtMs - startedAtMs),
        );
        const totalRemainingMs = Math.max(1, TOPOLOGY_TOTAL_TIME_MS - state.spentMs);
        const resultOption = yield* scanTopologyPage(context, state).pipe(
          Effect.timeoutOption(Math.min(passRemainingMs, totalRemainingMs)),
        );
        const scanElapsedMs = Math.max(0, (yield* Clock.currentTimeMillis) - scanStartedAtMs);
        if (resultOption._tag === "None") {
          const nextState: LegacyDiscoveryState = {
            ...state,
            repairRound: state.repairRound + 1,
            spentMs: state.spentMs + scanElapsedMs,
          };
          const continuation = encodeLegacyDiscoveryState(nextState);
          yield* applyDiscoveryPage(context, coordinate, [], continuation, false);
          return continuation;
        }
        const result = resultOption.value;
        if (result.responseBytes > DISCOVERY_PAGE_BYTES) {
          const nextState: LegacyDiscoveryState = {
            ...state,
            repairRound: state.repairRound + 1,
            scannedPages: TOPOLOGY_TOTAL_PAGES,
            scannedBytes: TOPOLOGY_TOTAL_BYTES,
            spentMs: state.spentMs + scanElapsedMs,
          };
          const continuation = encodeLegacyDiscoveryState(nextState);
          yield* applyDiscoveryPage(context, coordinate, [], continuation, false);
          return continuation;
        }
        if (topologyBytes + result.responseBytes > TOPOLOGY_PASS_BYTES) return coordinate;
        topologyBytes += result.responseBytes;
        const nextState: LegacyDiscoveryState = {
          phase: "topology",
          scanId: state.scanId,
          parents: result.parents,
          parentIndex: result.parentIndex,
          cursor: result.cursor,
          repairRound: result.repairRound,
          scannedPages: state.scannedPages + 1,
          scannedBytes: state.scannedBytes + result.responseBytes,
          spentMs: state.spentMs + scanElapsedMs,
        };
        const continuation = result.complete ? null : encodeLegacyDiscoveryState(nextState);
        yield* applyDiscoveryPage(
          context,
          coordinate,
          result.threads,
          continuation,
          result.complete,
        );
        if (result.complete) return null;
        state = nextState;
        if (!result.madeProgress) return continuation;
        continue;
      }
      if (state.parentIndex >= state.parents.length) {
        const observedThreadIds = observedSubagentThreadIds(
          context.universe.root_thread_id,
          state.parents,
        );
        const knownThreadIds = new Set(state.parents);
        if ([...observedThreadIds].every((threadId) => knownThreadIds.has(threadId))) {
          const coordinate = encodeLegacyDiscoveryState(state);
          yield* applyDiscoveryPage(context, coordinate, [], null, true);
          return null;
        }
        state = {
          phase: "topology",
          scanId: state.scanId,
          parents: state.parents,
          parentIndex: 0,
          cursor: null,
          repairRound: 0,
          scannedPages: 0,
          scannedBytes: 0,
          spentMs: 0,
        };
        continue;
      }
      const parentThreadId = state.parents[state.parentIndex]!;
      let response = yield* requestLegacyDiscoveryPage(
        context,
        parentThreadId,
        state.cursor,
        true,
      ).pipe(Effect.mapError((cause) => error("discover", context.universe.root_thread_id, cause)));
      if (state.cursor === null && response.data.length === 0 && response.nextCursor === null) {
        response = yield* requestLegacyDiscoveryPage(
          context,
          parentThreadId,
          state.cursor,
          false,
        ).pipe(
          Effect.mapError((cause) => error("discover", context.universe.root_thread_id, cause)),
        );
      }
      const threads = response.data as unknown as readonly Thread[];
      for (const thread of threads) {
        const observedParent = extractCodexThreadSubagentMetadata(thread).parentThreadId;
        if (observedParent !== parentThreadId) {
          return yield* error(
            "discover",
            context.universe.root_thread_id,
            new Error("Legacy Subagent discovery returned a Thread outside its direct-parent page"),
            thread.id,
          );
        }
      }
      const nextCursor = response.nextCursor ?? null;
      if (nextCursor !== null && nextCursor === state.cursor) {
        const continuation = encodeLegacyDiscoveryState(state);
        // A repeated cursor is typed incomplete, not a page. Do not bind the retry coordinate
        // to an empty payload: the same generation may recover and return the real page later.
        return continuation;
      }
      const parents = [...state.parents];
      const seenParents = new Set(parents);
      for (const thread of threads) {
        const threadId = thread.id.trim();
        if (!threadId || seenParents.has(threadId)) continue;
        if (parents.length >= LEGACY_DISCOVERY_FRONTIER_LIMIT) {
          return yield* error(
            "discover",
            context.universe.root_thread_id,
            new Error("Legacy Subagent discovery exceeded its bounded parent frontier"),
          );
        }
        seenParents.add(threadId);
        parents.push(threadId);
      }
      const nextState: LegacyDiscoveryState =
        nextCursor === null
          ? {
              phase: "list",
              scanId: state.scanId,
              parents,
              parentIndex: state.parentIndex + 1,
              cursor: null,
              repairRound: 0,
              scannedPages: 0,
              scannedBytes: 0,
              spentMs: 0,
            }
          : {
              phase: "list",
              scanId: state.scanId,
              parents,
              parentIndex: state.parentIndex,
              cursor: nextCursor,
              repairRound: 0,
              scannedPages: 0,
              scannedBytes: 0,
              spentMs: 0,
            };
      const terminal = nextState.parentIndex >= nextState.parents.length;
      const observedThreadIds = terminal
        ? observedSubagentThreadIds(context.universe.root_thread_id, nextState.parents)
        : new Set<string>();
      const knownThreadIds = new Set(nextState.parents);
      const requiresTopologyRepair =
        terminal && [...observedThreadIds].some((threadId) => !knownThreadIds.has(threadId));
      const followingState: LegacyDiscoveryState | null = !terminal
        ? nextState
        : requiresTopologyRepair
          ? {
              phase: "topology",
              scanId: nextState.scanId,
              parents: nextState.parents,
              parentIndex: 0,
              cursor: null,
              repairRound: 0,
              scannedPages: 0,
              scannedBytes: 0,
              spentMs: 0,
            }
          : null;
      const continuation = yield* Effect.try({
        try: () => (followingState ? encodeLegacyDiscoveryState(followingState) : null),
        catch: (cause) => error("discover", context.universe.root_thread_id, cause),
      });
      yield* applyDiscoveryPage(
        context,
        encodeLegacyDiscoveryState(state),
        threads,
        continuation,
        followingState === null,
      );
      if (!followingState) return null;
      state = followingState;
    }
    return yield* Effect.try({
      try: () => encodeLegacyDiscoveryState(state),
      catch: (cause) => error("discover", context.universe.root_thread_id, cause),
    });
  });

  const discoverPages = Effect.fn("CodexSubagentDirectory.discoverPages")(function* (
    context: RootContext,
    initialContinuation: string | null,
    maximumPages: number,
  ): Effect.fn.Return<string | null, CodexSubagentDirectoryError> {
    if (!context.capability.flags.subagentAncestorFilter) {
      return yield* discoverLegacyPages(context, initialContinuation, maximumPages);
    }
    let state = yield* Effect.try({
      try: () => decodeAncestorDiscoveryState(initialContinuation),
      catch: (cause) => error("discover", context.universe.root_thread_id, cause),
    });
    const startedAtMs = yield* Clock.currentTimeMillis;
    let topologyBytes = 0;
    for (let page = 0; page < maximumPages; page += 1) {
      if ((yield* Clock.currentTimeMillis) - startedAtMs >= DISCOVERY_PASS_DEADLINE_MS) {
        return yield* Effect.try({
          try: () => encodeAncestorDiscoveryState(state),
          catch: (cause) => error("discover", context.universe.root_thread_id, cause),
        });
      }

      const coordinate = encodeAncestorDiscoveryState(state);
      const observedThreadIds = observedSubagentThreadIds(
        context.universe.root_thread_id,
        state.phase === "topology" ? state.parents : state.knownThreadIds,
      );
      if (state.phase === "list") {
        const response = yield* requestDiscoveryPage(
          context,
          state.cursor,
          state.useStateDbOnly,
        ).pipe(
          Effect.mapError((cause) => error("discover", context.universe.root_thread_id, cause)),
        );
        const threads = response.data.map(projectCodexGatewayThreadReadThread);
        const seenObservedThreadIds = new Set(state.seenObservedThreadIds);
        const knownThreadIds = new Set(state.knownThreadIds);
        for (const thread of threads) {
          knownThreadIds.add(thread.id);
        }
        const latestObservedThreadIds = observedSubagentThreadIds(
          context.universe.root_thread_id,
          knownThreadIds,
        );
        for (const threadId of knownThreadIds) {
          if (latestObservedThreadIds.has(threadId)) seenObservedThreadIds.add(threadId);
        }
        if (knownThreadIds.size >= LEGACY_DISCOVERY_FRONTIER_LIMIT) {
          return yield* error(
            "discover",
            context.universe.root_thread_id,
            new Error("Subagent discovery exceeded its bounded topology frontier"),
          );
        }
        const nextCursor = response.nextCursor ?? null;
        if (nextCursor !== null && nextCursor === state.cursor) {
          // Preserve the already durable continuation without consuming its page identity. A
          // later pass may legitimately recover at this exact cursor with a non-empty page.
          return coordinate;
        }
        const missingObservedThreadIds = [...latestObservedThreadIds].filter(
          (threadId) => !seenObservedThreadIds.has(threadId),
        );
        let nextState: AncestorDiscoveryState | null = null;
        if (nextCursor !== null) {
          nextState = {
            ...state,
            cursor: nextCursor,
            seenObservedThreadIds: [...seenObservedThreadIds],
            knownThreadIds: [...knownThreadIds],
          };
        } else if (state.useStateDbOnly && missingObservedThreadIds.length > 0) {
          nextState = {
            phase: "list",
            scanId: state.scanId,
            cursor: null,
            useStateDbOnly: false,
            seenObservedThreadIds: [...seenObservedThreadIds],
            knownThreadIds: [...knownThreadIds],
            requiresTopologyRepair: true,
          };
        } else if (missingObservedThreadIds.length > 0) {
          nextState = {
            phase: "repair",
            scanId: state.scanId,
            repairRound: 0,
            seenObservedThreadIds: [...seenObservedThreadIds],
            knownThreadIds: [...knownThreadIds],
            requiresTopologyRepair: true,
          };
        } else if (state.requiresTopologyRepair) {
          nextState = {
            phase: "topology",
            scanId: state.scanId,
            parents: topologyParents(context.universe.root_thread_id, knownThreadIds),
            parentIndex: 0,
            cursor: null,
            repairRound: 0,
            scannedPages: 0,
            scannedBytes: 0,
            spentMs: 0,
          };
        }
        const continuation = nextState ? encodeAncestorDiscoveryState(nextState) : null;
        yield* applyDiscoveryPage(context, coordinate, threads, continuation, nextState === null);
        if (!nextState) return null;
        state = nextState;
        continue;
      }

      if (state.phase === "topology") {
        if (
          state.scannedPages >= TOPOLOGY_TOTAL_PAGES ||
          state.scannedBytes + DISCOVERY_PAGE_BYTES > TOPOLOGY_TOTAL_BYTES ||
          state.spentMs >= TOPOLOGY_TOTAL_TIME_MS
        ) {
          return coordinate;
        }
        const scanStartedAtMs = yield* Clock.currentTimeMillis;
        const passRemainingMs = Math.max(
          1,
          DISCOVERY_PASS_DEADLINE_MS - (scanStartedAtMs - startedAtMs),
        );
        const totalRemainingMs = Math.max(1, TOPOLOGY_TOTAL_TIME_MS - state.spentMs);
        const resultOption = yield* scanTopologyPage(context, state).pipe(
          Effect.timeoutOption(Math.min(passRemainingMs, totalRemainingMs)),
        );
        const scanElapsedMs = Math.max(0, (yield* Clock.currentTimeMillis) - scanStartedAtMs);
        if (resultOption._tag === "None") {
          const nextState: AncestorDiscoveryState = {
            ...state,
            repairRound: state.repairRound + 1,
            spentMs: state.spentMs + scanElapsedMs,
          };
          const continuation = encodeAncestorDiscoveryState(nextState);
          yield* applyDiscoveryPage(context, coordinate, [], continuation, false);
          return continuation;
        }
        const result = resultOption.value;
        if (result.responseBytes > DISCOVERY_PAGE_BYTES) {
          const nextState: AncestorDiscoveryState = {
            ...state,
            repairRound: state.repairRound + 1,
            scannedPages: TOPOLOGY_TOTAL_PAGES,
            scannedBytes: TOPOLOGY_TOTAL_BYTES,
            spentMs: state.spentMs + scanElapsedMs,
          };
          const continuation = encodeAncestorDiscoveryState(nextState);
          yield* applyDiscoveryPage(context, coordinate, [], continuation, false);
          return continuation;
        }
        if (topologyBytes + result.responseBytes > TOPOLOGY_PASS_BYTES) return coordinate;
        topologyBytes += result.responseBytes;
        const nextState: AncestorDiscoveryState = {
          phase: "topology",
          scanId: state.scanId,
          parents: result.parents,
          parentIndex: result.parentIndex,
          cursor: result.cursor,
          repairRound: result.repairRound,
          scannedPages: state.scannedPages + 1,
          scannedBytes: state.scannedBytes + result.responseBytes,
          spentMs: state.spentMs + scanElapsedMs,
        };
        const continuation = result.complete ? null : encodeAncestorDiscoveryState(nextState);
        yield* applyDiscoveryPage(
          context,
          coordinate,
          result.threads,
          continuation,
          result.complete,
        );
        if (result.complete) return null;
        state = nextState;
        if (!result.madeProgress) return continuation;
        continue;
      }

      const seenObservedThreadIds = new Set(state.seenObservedThreadIds);
      const missingThreadIds = [...observedThreadIds].filter(
        (threadId) => !seenObservedThreadIds.has(threadId),
      );
      if (missingThreadIds.length === 0) {
        const nextState: AncestorDiscoveryState = {
          phase: "topology",
          scanId: state.scanId,
          parents: topologyParents(context.universe.root_thread_id, state.knownThreadIds),
          parentIndex: 0,
          cursor: null,
          repairRound: 0,
          scannedPages: 0,
          scannedBytes: 0,
          spentMs: 0,
        };
        const continuation = encodeAncestorDiscoveryState(nextState);
        yield* applyDiscoveryPage(context, coordinate, [], continuation, false);
        state = nextState;
        continue;
      }
      const candidates = yield* Effect.forEach(
        missingThreadIds.slice(0, CODEX_SUBAGENT_DISCOVERY_PAGE_LIMIT),
        (threadId) =>
          gateway
            .requestOnHost(
              context.universe.host_id,
              "thread/read",
              { threadId, includeTurns: false },
              {
                priority: "background",
                source: "collab_hydration",
                conversationId: context.universe.root_thread_id,
                widgetId: "subagent-overview:metadata-repair",
                coalesce: true,
                timeoutMs: DISCOVERY_PAGE_TIMEOUT_MS,
                ...codexGatewayGenerationFence(context.capability),
              },
            )
            .pipe(
              Effect.map((result) => projectCodexGatewayThreadReadThread(result.thread)),
              Effect.filterOrFail(
                (thread) => thread.id === threadId && thread.turns.length === 0,
                () => new Error("Subagent metadata repair returned an invalid Thread shell"),
              ),
              Effect.option,
            ),
        { concurrency: 2 },
      );
      const pending = candidates.flatMap((candidate) =>
        candidate._tag === "Some" ? [candidate.value] : [],
      );
      const repaired: Thread[] = [];
      const knownThreadIds = new Set(state.knownThreadIds);
      let madeProgress = true;
      while (madeProgress && pending.length > 0) {
        madeProgress = false;
        for (let index = pending.length - 1; index >= 0; index -= 1) {
          const candidate = pending[index]!;
          const parentThreadId =
            extractCodexThreadSubagentMetadata(candidate).parentThreadId?.trim() ?? "";
          if (!parentThreadId) continue;
          const parentReachable =
            parentThreadId === context.universe.root_thread_id ||
            knownThreadIds.has(parentThreadId) ||
            repaired.some((thread) => thread.id === parentThreadId) ||
            (yield* isDescendant(context.universe.root_thread_id, parentThreadId));
          if (!parentReachable) continue;
          repaired.push(candidate);
          seenObservedThreadIds.add(candidate.id);
          pending.splice(index, 1);
          madeProgress = true;
        }
      }
      const nextMissing = [...observedThreadIds].filter(
        (threadId) => !seenObservedThreadIds.has(threadId),
      );
      for (const thread of repaired) knownThreadIds.add(thread.id);
      const nextState: AncestorDiscoveryState =
        nextMissing.length === 0
          ? {
              phase: "topology",
              scanId: state.scanId,
              parents: topologyParents(context.universe.root_thread_id, knownThreadIds),
              parentIndex: 0,
              cursor: null,
              repairRound: 0,
              scannedPages: 0,
              scannedBytes: 0,
              spentMs: 0,
            }
          : {
              phase: "repair",
              scanId: state.scanId,
              repairRound: state.repairRound + 1,
              seenObservedThreadIds: [...seenObservedThreadIds],
              knownThreadIds: [...knownThreadIds],
              requiresTopologyRepair: true,
            };
      const continuation = encodeAncestorDiscoveryState(nextState);
      yield* applyDiscoveryPage(context, coordinate, repaired, continuation, false);
      state = nextState;
      if (state.phase === "repair" && repaired.length === 0) return continuation;
    }
    return yield* Effect.try({
      try: () => encodeAncestorDiscoveryState(state),
      catch: (cause) => error("discover", context.universe.root_thread_id, cause),
    });
  });

  const repairDiscoveryUntilStalled = Effect.fn(
    "CodexSubagentDirectory.repairDiscoveryUntilStalled",
  )(function* (
    context: RootContext,
    initialContinuation: string,
  ): Effect.fn.Return<void, CodexSubagentDirectoryError> {
    let continuation: string | null = initialContinuation;
    while (continuation !== null) {
      const next: string | null = yield* discoverPages(
        context,
        continuation,
        DISCOVERY_MAX_PAGES_PER_PASS,
      );
      if (next === null || next === continuation) return;
      continuation = next;
      yield* Effect.yieldNow;
    }
  });

  const scheduleDiscoveryRepair = (context: RootContext): void => {
    const key = discoveryKey(context);
    if (FiberMap.hasUnsafe(discoveries, key) || FiberMap.hasUnsafe(foregroundDiscoveries, key)) {
      return;
    }
    runDiscovery(
      key,
      readOverviewPage(context, {
        activeAfter: null,
        activeFirst: CODEX_SUBAGENT_OVERVIEW_INITIAL_ACTIVE_LIMIT,
        doneAfter: null,
        doneFirst: CODEX_SUBAGENT_OVERVIEW_INITIAL_DONE_LIMIT,
      }).pipe(
        Effect.flatMap((overview) => {
          if (overview.discovery_complete) return Effect.void;
          const continuation = overview.discovery_continuation;
          return continuation
            ? repairDiscoveryUntilStalled(context, continuation)
            : discoverPages(context, null, DISCOVERY_MAX_PAGES_PER_PASS).pipe(
                Effect.flatMap((next) =>
                  next ? repairDiscoveryUntilStalled(context, next) : Effect.void,
                ),
              );
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not repair background Subagent discovery").pipe(
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

  const readExpanded = Effect.fn("CodexSubagentDirectory.readExpanded")(function* (
    context: RootContext,
  ): Effect.fn.Return<CodexSubagentOverviewWindow, CodexSubagentDirectoryError> {
    for (let attempt = 0; attempt < EXPANDED_WINDOW_MAX_SNAPSHOT_ATTEMPTS; attempt += 1) {
      const activeRows: CodexSubagentOverviewWindow["active"]["rows"] = [];
      const doneRows: CodexSubagentOverviewWindow["done"]["rows"] = [];
      const seenThreadIds = new Set<string>();
      let activeAfter: string | null = null;
      let doneAfter: string | null = null;
      let activeComplete = false;
      let doneComplete = false;
      let revision: number | null = null;
      let latest: CoreSubagentOverview | null = null;
      let revisionChanged = false;

      for (let page = 0; page < EXPANDED_WINDOW_MAX_PAGES; page += 1) {
        const current: CoreSubagentOverview = yield* readOverviewPage(context, {
          activeAfter,
          activeFirst: activeComplete ? 1 : EXPANDED_WINDOW_PAGE_SIZE,
          doneAfter,
          doneFirst: doneComplete ? 1 : EXPANDED_WINDOW_PAGE_SIZE,
        });
        revision ??= current.projection_revision;
        if (current.projection_revision !== revision) {
          revisionChanged = true;
          break;
        }
        latest = current;
        const projected = projectCodexSubagentOverviewWindow(
          current as unknown as CoreSubagentOverviewLike,
        );
        for (const row of projected.active.rows) {
          if (seenThreadIds.has(row.threadId)) continue;
          seenThreadIds.add(row.threadId);
          activeRows.push(row);
        }
        for (const row of projected.done.rows) {
          if (seenThreadIds.has(row.threadId)) continue;
          seenThreadIds.add(row.threadId);
          doneRows.push(row);
        }
        if (!activeComplete) {
          activeAfter = current.active.next_cursor ?? null;
          activeComplete = activeAfter === null;
        }
        if (!doneComplete) {
          doneAfter = current.done.next_cursor ?? null;
          doneComplete = doneAfter === null;
        }
        if (activeComplete && doneComplete) break;
      }

      if (revisionChanged || !latest) continue;
      const projected = projectCodexSubagentOverviewWindow(
        latest as unknown as CoreSubagentOverviewLike,
      );
      return {
        ...projected,
        active: {
          ...projected.active,
          rows: activeRows,
          continuation: activeComplete ? null : activeAfter,
        },
        done: {
          ...projected.done,
          rows: doneRows,
          continuation: doneComplete ? null : doneAfter,
        },
      };
    }

    yield* Effect.logWarning(
      "Subagent expanded overview changed revision repeatedly; returning one bounded snapshot",
    ).pipe(
      Effect.annotateLogs({
        rootThreadId: context.universe.root_thread_id,
        attempts: EXPANDED_WINDOW_MAX_SNAPSHOT_ATTEMPTS,
      }),
    );
    const fallback = yield* readOverviewPage(context, {
      activeAfter: null,
      activeFirst: EXPANDED_WINDOW_PAGE_SIZE,
      doneAfter: null,
      doneFirst: EXPANDED_WINDOW_PAGE_SIZE,
    });
    return projectCodexSubagentOverviewWindow(fallback as unknown as CoreSubagentOverviewLike);
  });

  const readOverview = Effect.fn("CodexSubagentDirectory.readOverview")(function* (
    input: CodexSubagentOverviewReadInput,
  ): Effect.fn.Return<CodexSubagentOverviewWindow, CodexSubagentDirectoryError> {
    const context = yield* resolveRootContext(input.rootThreadId);
    // The renderer-owned app-server is the sole writer while a Turn is active. A metadata read
    // must not lazily start the host catalog endpoint, which would resume the same root and create
    // a second owner. Live activity notifications keep this projection current until settlement.
    const canDiscoverRemotely = !hasLiveRootOwner(context);
    let overview = yield* readOverviewPage(context, {
      activeAfter: null,
      activeFirst: CODEX_SUBAGENT_OVERVIEW_INITIAL_ACTIVE_LIMIT,
      doneAfter: null,
      doneFirst: CODEX_SUBAGENT_OVERVIEW_INITIAL_DONE_LIMIT,
    });
    if (!overview.discovery_complete && canDiscoverRemotely) {
      const key = discoveryKey(context);
      const foreground = FiberMap.getUnsafe(foregroundDiscoveries, key);
      if (foreground._tag === "Some") {
        yield* Fiber.join(foreground.value);
      } else if (!FiberMap.hasUnsafe(discoveries, key)) {
        const fiber = runForegroundDiscovery(
          key,
          discoverPages(
            context,
            overview.discovery_continuation ?? null,
            input.mode === "expanded" ? DISCOVERY_MAX_PAGES_PER_PASS : 1,
          ).pipe(Effect.asVoid),
        );
        yield* Fiber.join(fiber);
      }
      overview = yield* readOverviewPage(context, {
        activeAfter: null,
        activeFirst: CODEX_SUBAGENT_OVERVIEW_INITIAL_ACTIVE_LIMIT,
        doneAfter: null,
        doneFirst: CODEX_SUBAGENT_OVERVIEW_INITIAL_DONE_LIMIT,
      });
      if (!overview.discovery_complete && input.mode === "initial") {
        scheduleDiscoveryRepair(context);
      }
    }
    if (input.mode === "expanded") return yield* readExpanded(context);
    return projectCodexSubagentOverviewWindow(overview as unknown as CoreSubagentOverviewLike);
  });

  const readKnownOverview = Effect.fn("CodexSubagentDirectory.readKnownOverview")(
    function* (input: {
      readonly rootThreadId: string;
    }): Effect.fn.Return<CodexSubagentOverviewWindow, CodexSubagentDirectoryError> {
      const context = yield* resolveRootContext(input.rootThreadId);
      const overview = yield* readOverviewPage(context, {
        activeAfter: null,
        activeFirst: CODEX_SUBAGENT_OVERVIEW_INITIAL_ACTIVE_LIMIT,
        doneAfter: null,
        doneFirst: CODEX_SUBAGENT_OVERVIEW_INITIAL_DONE_LIMIT,
      });
      if (!overview.discovery_complete && !hasLiveRootOwner(context)) {
        scheduleDiscoveryRepair(context);
      }
      return projectCodexSubagentOverviewWindow(overview as unknown as CoreSubagentOverviewLike);
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

  const refreshReconnectMetadata = Effect.fn("CodexSubagentDirectory.refreshReconnectMetadata")(
    function* (context: RootContext): Effect.fn.Return<void, CodexSubagentDirectoryError> {
      let useStateDbOnly = true;
      let response = yield* (
        context.capability.flags.subagentAncestorFilter
          ? requestDiscoveryPage(context, null, useStateDbOnly)
          : requestLegacyDiscoveryPage(
              context,
              context.universe.root_thread_id,
              null,
              useStateDbOnly,
            )
      ).pipe(Effect.mapError((cause) => error("discover", context.universe.root_thread_id, cause)));
      if (response.data.length === 0 && response.nextCursor === null) {
        useStateDbOnly = false;
        response = yield* (
          context.capability.flags.subagentAncestorFilter
            ? requestDiscoveryPage(context, null, useStateDbOnly)
            : requestLegacyDiscoveryPage(
                context,
                context.universe.root_thread_id,
                null,
                useStateDbOnly,
              )
        ).pipe(
          Effect.mapError((cause) => error("discover", context.universe.root_thread_id, cause)),
        );
      }

      const threads = context.capability.flags.subagentAncestorFilter
        ? response.data.map(projectCodexGatewayThreadReadThread)
        : (response.data as unknown as readonly Thread[]);
      const knownThreadIds = threads.map((thread) => thread.id);
      const nextCursor = response.nextCursor ?? null;
      let continuation: string | null;
      let complete: boolean;
      if (context.capability.flags.subagentAncestorFilter) {
        const observedThreadIds = observedSubagentThreadIds(
          context.universe.root_thread_id,
          knownThreadIds,
        );
        const seenObservedThreadIds = knownThreadIds.filter((threadId) =>
          observedThreadIds.has(threadId),
        );
        const missingObservedThreadIds = [...observedThreadIds].filter(
          (threadId) => !seenObservedThreadIds.includes(threadId),
        );
        let nextState: AncestorDiscoveryState | null = null;
        if (nextCursor !== null) {
          nextState = {
            phase: "list",
            scanId: randomUUID(),
            cursor: nextCursor,
            useStateDbOnly,
            seenObservedThreadIds,
            knownThreadIds,
            requiresTopologyRepair: false,
          };
        } else if (missingObservedThreadIds.length > 0 && useStateDbOnly) {
          nextState = {
            phase: "list",
            scanId: randomUUID(),
            cursor: null,
            useStateDbOnly: false,
            seenObservedThreadIds,
            knownThreadIds,
            requiresTopologyRepair: true,
          };
        } else if (missingObservedThreadIds.length > 0) {
          nextState = {
            phase: "repair",
            scanId: randomUUID(),
            repairRound: 0,
            seenObservedThreadIds,
            knownThreadIds,
            requiresTopologyRepair: true,
          };
        }
        continuation = nextState ? encodeAncestorDiscoveryState(nextState) : null;
        complete = nextState === null;
      } else {
        const parents = topologyParents(context.universe.root_thread_id, knownThreadIds);
        const nextState: LegacyDiscoveryState | null =
          nextCursor === null && parents.length === 1
            ? null
            : {
                phase: "list",
                scanId: randomUUID(),
                parents,
                parentIndex: nextCursor === null ? 1 : 0,
                cursor: nextCursor,
                repairRound: 0,
                scannedPages: 0,
                scannedBytes: 0,
                spentMs: 0,
              };
        continuation = nextState ? encodeLegacyDiscoveryState(nextState) : null;
        complete = nextState === null;
      }

      yield* applyDiscoveryPage(
        context,
        `reconnect-metadata:${randomUUID()}`,
        threads,
        continuation,
        complete,
        true,
        false,
      );
    },
  );

  const reconcileReconnectUnknown = Effect.fn("CodexSubagentDirectory.reconcileReconnectUnknown")(
    function* (
      context: RootContext,
      threadId: string,
    ): Effect.fn.Return<void, CodexSubagentDirectoryError> {
      const authority = yield* readOverviewItem(context, threadId);
      if (!authority.item || authority.item.status !== "unknown") return;
      const evidence = authority.item.evidence;
      const precondition: StatusEvidencePrecondition = evidence
        ? {
            mode: "exact",
            evidence_kind: evidence.kind,
            source_revision: evidence.source_revision,
            observed_at_ms: evidence.observed_at_ms,
          }
        : { mode: "absent" };
      const result = yield* gateway
        .requestOnHost(
          context.universe.host_id,
          "thread/turns/list",
          {
            threadId,
            cursor: null,
            limit: 1,
            sortDirection: "desc",
            itemsView: "notLoaded",
          },
          {
            priority: "background",
            source: "collab_hydration",
            conversationId: context.universe.root_thread_id,
            widgetId: "subagent-overview:reconnect-skeleton",
            coalesce: true,
            timeoutMs: DISCOVERY_PAGE_TIMEOUT_MS,
            ...codexGatewayGenerationFence(context.capability),
          },
        )
        .pipe(Effect.result);
      if (result._tag === "Failure") return;
      const turn = result.success.data[0];
      if (!turn || turn.status === "inProgress") return;
      const observedAtMs =
        Math.max(0, Math.trunc(turn.completedAt ?? 0)) * 1_000 || (yield* Clock.currentTimeMillis);
      yield* applyStatusEvidence(
        context,
        threadId,
        "done",
        "reconciliation",
        precondition.mode === "exact" ? precondition.source_revision : 0,
        observedAtMs,
        precondition,
        false,
      ).pipe(
        // A notification may win the CAS while the skeleton read is in flight. Its newer status is
        // already authoritative, so recovery can leave this row to the shared final invalidation.
        Effect.catch(() => Effect.void),
      );
    },
  );

  const reconcileReconnectRoot = Effect.fn("CodexSubagentDirectory.reconcileReconnectRoot")(
    function* (context: RootContext): Effect.fn.Return<void, CodexSubagentDirectoryError> {
      // Establish the new endpoint universe before any remote read. Core carries the positive graph
      // forward and deliberately downgrades transient status to Unknown until fresh evidence arrives.
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
      const overview = yield* readOverviewPage(context, {
        activeAfter: null,
        activeFirst: RECONNECT_UNRESOLVED_LIMIT,
        doneAfter: null,
        doneFirst: 1,
      });
      const unknownThreadIds = overview.active.items
        .filter((item) => item.status === "unknown")
        .map((item) => item.thread.thread_id)
        .slice(0, RECONNECT_UNRESOLVED_LIMIT);
      yield* Effect.forEach(
        unknownThreadIds,
        (threadId) => reconcileReconnectUnknown(context, threadId),
        { concurrency: 2, discard: true },
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
                Effect.timeout(`${RECONNECT_ROOT_RECONCILIATION_BUDGET_MS} millis`),
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

  const readLifecyclePage = Effect.fn("CodexSubagentDirectory.readLifecyclePage")(function* (
    rootThreadId: string,
    operationId: string,
    after: string | null,
    includeSettled = false,
  ): Effect.fn.Return<CoreSubagentLifecycle, CodexSubagentDirectoryError> {
    const response = yield* core.workspace
      .read(
        {
          kind: "subagent_lifecycle_batch",
          lifecycle_operation_id: operationId,
          include_settled: includeSettled,
          window: { after, first: 100 },
        },
        { class: "background", deadlineMs: DISCOVERY_PAGE_TIMEOUT_MS },
      )
      .pipe(Effect.mapError((cause) => error("lifecycle", rootThreadId, cause)));
    if (response.value.kind !== "subagent_lifecycle_batch") {
      return yield* error(
        "lifecycle",
        rootThreadId,
        new Error("Core returned the wrong Subagent lifecycle read variant"),
      );
    }
    return response.value.lifecycle;
  });

  const beginLifecycle = Effect.fn("CodexSubagentDirectory.beginLifecycle")(function* (input: {
    readonly rootThreadId: string;
    readonly action: "archive" | "delete";
  }): Effect.fn.Return<CodexSubagentLifecycleSnapshot, CodexSubagentDirectoryError> {
    const context = yield* resolveRootContext(input.rootThreadId);
    const overview = yield* readOverview({ rootThreadId: input.rootThreadId, mode: "expanded" });
    if (overview.completeness !== "complete") {
      return yield* error(
        "lifecycle",
        context.universe.root_thread_id,
        new Error("Subagent lifecycle requires a complete descendant closure"),
      );
    }
    const operationId = lifecycleOperationId(context, input.action);
    yield* core.workspace
      .apply(
        {
          operationId: createOperationId("subagent-directory.lifecycle.begin"),
          intent: {
            kind: "begin_subagent_lifecycle",
            universe: context.universe,
            lifecycle_operation_id: operationId,
            action: input.action,
          },
        },
        { class: "interactive", deadlineMs: DISCOVERY_PAGE_TIMEOUT_MS },
      )
      .pipe(Effect.mapError((cause) => error("lifecycle", context.universe.root_thread_id, cause)));
    lifecycleQuarantines.delete(context.universe.root_thread_id);
    while (lifecycleQuarantines.size >= LIFECYCLE_QUARANTINE_LIMIT) {
      const oldest = lifecycleQuarantines.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      lifecycleQuarantines.delete(oldest);
    }
    lifecycleQuarantines.set(context.universe.root_thread_id, input.action);
    return projectLifecycleSnapshot(
      yield* readLifecyclePage(context.universe.root_thread_id, operationId, null),
    );
  });

  const reconcileLifecycleAttempt = Effect.fn("CodexSubagentDirectory.reconcileLifecycleAttempt")(
    function* (input: {
      readonly operationId: string;
    }): Effect.fn.Return<CodexSubagentLifecycleSnapshot, CodexSubagentDirectoryError> {
      const operationId = input.operationId.trim();
      if (!operationId) {
        return yield* error(
          "lifecycle",
          "unknown",
          new Error("Subagent lifecycle operation id is required"),
        );
      }
      const initial = yield* readLifecyclePage("unknown", operationId, null);
      const universe = initial.universe;
      const capability = yield* capabilities
        .forHost(universe.host_id)
        .pipe(Effect.mapError((cause) => error("lifecycle", universe.root_thread_id, cause)));
      const applyObservations = (
        observations: ReadonlyArray<{
          readonly thread_id: string;
          readonly outcome: "unresolved" | "failed" | "settled";
          readonly reason: string | null;
          readonly observed_at_ms: number;
        }>,
      ) =>
        Effect.forEach(
          Array.from({ length: Math.ceil(observations.length / 100) }, (_, index) => index),
          (index) =>
            core.workspace
              .apply(
                {
                  operationId: createOperationId("subagent-directory.lifecycle.observe"),
                  intent: {
                    kind: "observe_subagent_lifecycle_outcomes",
                    lifecycle_operation_id: operationId,
                    observations: observations.slice(index * 100, index * 100 + 100),
                  },
                },
                { class: "background", deadlineMs: DISCOVERY_PAGE_TIMEOUT_MS },
              )
              .pipe(Effect.mapError((cause) => error("lifecycle", universe.root_thread_id, cause))),
          { discard: true },
        );
      const archivedThreadIds = new Set<string>();
      if (initial.action === "archive") {
        const postconditionStartedAtMs = yield* Clock.currentTimeMillis;
        let postconditionBytes = 0;
        const listArchivedPage = (
          params: ThreadListParams,
          widgetId: string,
        ): Effect.Effect<
          ClientRequestResponsesByMethod["thread/list"],
          CodexSubagentDirectoryError
        > =>
          gateway
            .requestOnHost(universe.host_id, "thread/list", params, {
              priority: "background",
              source: "collab_hydration",
              conversationId: universe.root_thread_id,
              widgetId,
              coalesce: true,
              timeoutMs: DISCOVERY_PAGE_TIMEOUT_MS,
              ...codexGatewayGenerationFence(capability),
            })
            .pipe(Effect.mapError((cause) => error("lifecycle", universe.root_thread_id, cause)));

        if (capability.flags.subagentAncestorFilter) {
          let cursor: string | null = null;
          const seenCursors = new Set<string | null>();
          for (let page = 0; page < EXPANDED_WINDOW_MAX_PAGES; page += 1) {
            if (
              (yield* Clock.currentTimeMillis) - postconditionStartedAtMs >=
              LIFECYCLE_POSTCONDITION_DEADLINE_MS
            ) {
              return yield* error(
                "lifecycle",
                universe.root_thread_id,
                new Error("Archived Subagent postcondition exceeded its time budget"),
              );
            }
            if (seenCursors.has(cursor)) {
              return yield* error(
                "lifecycle",
                universe.root_thread_id,
                new Error("Archived Subagent postcondition cursor did not advance"),
              );
            }
            seenCursors.add(cursor);
            const response: ClientRequestResponsesByMethod["thread/list"] = yield* listArchivedPage(
              {
                cursor,
                limit: CODEX_SUBAGENT_DISCOVERY_PAGE_LIMIT,
                sortKey: "created_at",
                sortDirection: "desc",
                archived: true,
                useStateDbOnly: false,
                ancestorThreadId: universe.root_thread_id,
              },
              "subagent-lifecycle:archive-postcondition",
            );
            postconditionBytes += cappedApproximateValueBytes(
              response.data,
              LIFECYCLE_POSTCONDITION_BYTES,
            );
            if (postconditionBytes > LIFECYCLE_POSTCONDITION_BYTES) {
              return yield* error(
                "lifecycle",
                universe.root_thread_id,
                new Error("Archived Subagent postcondition exceeded its byte budget"),
              );
            }
            for (const thread of response.data) archivedThreadIds.add(thread.id);
            const nextCursor: string | null = response.nextCursor ?? null;
            if (nextCursor !== null && seenCursors.has(nextCursor)) {
              return yield* error(
                "lifecycle",
                universe.root_thread_id,
                new Error("Archived Subagent postcondition repeated its cursor"),
              );
            }
            cursor = nextCursor;
            if (cursor === null) break;
          }
          if (cursor !== null) {
            return yield* error(
              "lifecycle",
              universe.root_thread_id,
              new Error("Archived Subagent postcondition exceeds its bounded closure"),
            );
          }
        } else {
          const parents = [universe.root_thread_id];
          const seenParents = new Set(parents);
          for (let parentIndex = 0; parentIndex < parents.length; parentIndex += 1) {
            const parentThreadId = parents[parentIndex]!;
            let cursor: string | null = null;
            const seenCursors = new Set<string | null>();
            do {
              if (
                (yield* Clock.currentTimeMillis) - postconditionStartedAtMs >=
                LIFECYCLE_POSTCONDITION_DEADLINE_MS
              ) {
                return yield* error(
                  "lifecycle",
                  universe.root_thread_id,
                  new Error("Legacy archived Subagent postcondition exceeded its time budget"),
                );
              }
              if (seenCursors.has(cursor)) {
                return yield* error(
                  "lifecycle",
                  universe.root_thread_id,
                  new Error("Legacy archived Subagent postcondition cursor did not advance"),
                  parentThreadId,
                );
              }
              seenCursors.add(cursor);
              const response: ClientRequestResponsesByMethod["thread/list"] =
                yield* listArchivedPage(
                  {
                    cursor,
                    limit: CODEX_SUBAGENT_DISCOVERY_PAGE_LIMIT,
                    sortKey: "created_at",
                    sortDirection: "desc",
                    sourceKinds: ["subAgentThreadSpawn"],
                    archived: true,
                    useStateDbOnly: false,
                    parentThreadId,
                  },
                  "subagent-lifecycle:legacy-archive-postcondition",
                );
              postconditionBytes += cappedApproximateValueBytes(
                response.data,
                LIFECYCLE_POSTCONDITION_BYTES,
              );
              if (postconditionBytes > LIFECYCLE_POSTCONDITION_BYTES) {
                return yield* error(
                  "lifecycle",
                  universe.root_thread_id,
                  new Error("Legacy archived Subagent postcondition exceeded its byte budget"),
                );
              }
              for (const thread of response.data) {
                archivedThreadIds.add(thread.id);
                if (seenParents.has(thread.id)) continue;
                if (parents.length >= LEGACY_DISCOVERY_FRONTIER_LIMIT) {
                  return yield* error(
                    "lifecycle",
                    universe.root_thread_id,
                    new Error("Legacy archived Subagent postcondition exceeded its frontier"),
                  );
                }
                seenParents.add(thread.id);
                parents.push(thread.id);
              }
              const nextCursor: string | null = response.nextCursor ?? null;
              if (nextCursor !== null && seenCursors.has(nextCursor)) {
                return yield* error(
                  "lifecycle",
                  universe.root_thread_id,
                  new Error("Legacy archived Subagent postcondition repeated its cursor"),
                  parentThreadId,
                );
              }
              cursor = nextCursor;
            } while (cursor !== null);
          }
        }
      }

      let after: string | null = null;
      for (let page = 0; page < LIFECYCLE_MAX_PAGES; page += 1) {
        const lifecycle: CoreSubagentLifecycle = yield* readLifecyclePage(
          universe.root_thread_id,
          operationId,
          after,
        );
        const lifecycleMembers: CoreSubagentLifecycle["members"]["items"] = lifecycle.members.items;
        if (lifecycleMembers.length === 0 && lifecycle.members.next_cursor === null) {
          // A completed durable delete can still have unfinished local Core cleanup from an earlier
          // process. Continue to the includeSettled cohort below so retries remain idempotent.
          if (initial.action === "delete" && lifecycle.complete) break;
          return projectLifecycleSnapshot(lifecycle);
        }
        const observedAtMs = yield* Clock.currentTimeMillis;
        const observations = yield* Effect.forEach(
          lifecycleMembers,
          (member) => {
            if (
              initial.action === "archive" &&
              (member.thread_id === universe.root_thread_id ||
                archivedThreadIds.has(member.thread_id))
            ) {
              return Effect.succeed({
                thread_id: member.thread_id,
                outcome: "settled" as const,
                reason: null,
                observed_at_ms: observedAtMs,
              });
            }
            return gateway
              .requestOnHost(
                universe.host_id,
                "thread/read",
                { threadId: member.thread_id, includeTurns: false },
                {
                  priority: "background",
                  source: "collab_hydration",
                  conversationId: universe.root_thread_id,
                  widgetId: `subagent-lifecycle:${initial.action}-postcondition`,
                  coalesce: true,
                  timeoutMs: DISCOVERY_PAGE_TIMEOUT_MS,
                  ...codexGatewayGenerationFence(capability),
                },
              )
              .pipe(
                Effect.as({
                  thread_id: member.thread_id,
                  outcome: "unresolved" as const,
                  reason:
                    initial.action === "archive"
                      ? "Thread is not present in the archived descendant index"
                      : "Deleted Thread is still readable",
                  observed_at_ms: observedAtMs,
                }),
                Effect.catch((cause) => {
                  const missing = isCodexThreadLifecycleAlreadyAppliedRequestError(cause, {
                    method: "thread/read",
                    threadId: member.thread_id,
                  });
                  return Effect.succeed({
                    thread_id: member.thread_id,
                    outcome: missing ? ("settled" as const) : ("failed" as const),
                    reason: missing ? null : cause.message,
                    observed_at_ms: observedAtMs,
                  });
                }),
              );
          },
          { concurrency: 2 },
        );
        yield* applyObservations(observations);
        after = lifecycle.members.next_cursor ?? null;
        if (after === null) break;
      }
      if (after !== null) {
        return yield* error(
          "lifecycle",
          universe.root_thread_id,
          new Error("Subagent lifecycle exceeds its bounded reconciliation pass"),
        );
      }
      const finalLifecycle = yield* readLifecyclePage(universe.root_thread_id, operationId, null);
      if (initial.action === "delete" && finalLifecycle.complete) {
        // Cleanup is derived from the complete durable cohort, not only members settled during
        // this process. That keeps a restarted or multi-pass delete from stranding earlier rows.
        let cohortAfter: string | null = null;
        for (let page = 0; page < LIFECYCLE_MAX_PAGES; page += 1) {
          const cohort: CoreSubagentLifecycle = yield* readLifecyclePage(
            universe.root_thread_id,
            operationId,
            cohortAfter,
            true,
          );
          if (cohort.members.items.some((member) => member.outcome !== "settled")) {
            return yield* error(
              "lifecycle",
              universe.root_thread_id,
              new Error("Complete Subagent delete lifecycle contains an unresolved member"),
            );
          }
          yield* Effect.forEach(
            cohort.members.items.filter((member) => member.thread_id !== universe.root_thread_id),
            (member) => {
              const threadId = member.thread_id;
              return core.workspace
                .apply(
                  {
                    operationId: createOperationId("subagent-directory.lifecycle.delete-local"),
                    intent: { kind: "delete_thread", thread_id: threadId },
                  },
                  { class: "background", deadlineMs: DISCOVERY_PAGE_TIMEOUT_MS },
                )
                .pipe(
                  Effect.catch((cause) =>
                    isCoreNotFound(cause) ? Effect.void : Effect.fail(cause),
                  ),
                  Effect.tap(() =>
                    Effect.sync(() => {
                      events.publish({
                        kind: "codex",
                        value: { type: "threadDeleted", threadId },
                      });
                    }),
                  ),
                  Effect.mapError((cause) => error("lifecycle", universe.root_thread_id, cause)),
                );
            },
            { concurrency: 2, discard: true },
          );
          cohortAfter = cohort.members.next_cursor ?? null;
          if (cohortAfter === null) break;
        }
        if (cohortAfter !== null) {
          return yield* error(
            "lifecycle",
            universe.root_thread_id,
            new Error("Complete Subagent delete cohort exceeds its bounded cleanup pass"),
          );
        }
      }
      return projectLifecycleSnapshot(finalLifecycle);
    },
  );

  const reconcileLifecycle = (input: { readonly operationId: string }) =>
    reconcileLifecycleAttempt(input).pipe(
      // The deadline covers archived-index enumeration, every member postcondition read, Core
      // outcome writes, and local delete cleanup. Per-request timeouts alone would otherwise make
      // a 6,400-member partial operation block for hours at concurrency two.
      Effect.timeoutOrElse({
        duration: `${LIFECYCLE_POSTCONDITION_DEADLINE_MS} millis`,
        orElse: () =>
          Effect.fail(
            error(
              "lifecycle",
              "unknown",
              new Error("Subagent lifecycle reconciliation exceeded its total time budget"),
            ),
          ),
      }),
    );

  const readUnsettledTurnRows = (rootThreadId: string) =>
    readOverview({ rootThreadId, mode: "expanded" }).pipe(
      Effect.map((overview) => ({
        discoveryComplete:
          overview.completeness === "complete" &&
          overview.active.continuation === null &&
          overview.done.continuation === null,
        rows: overview.active.rows.filter(
          (row) => row.status === "active" || row.status === "waiting" || row.status === "unknown",
        ),
      })),
    );

  const settleInterruptedSubtreeAttempt = Effect.fn(
    "CodexSubagentDirectory.settleInterruptedSubtreeAttempt",
  )(function* (
    rawRootThreadId: string,
    deadlineAtMs: number,
  ): Effect.fn.Return<CodexSubagentInterruptSnapshot, CodexSubagentDirectoryError> {
    const context = yield* resolveRootContext(rawRootThreadId);
    const startedAtMs = yield* Clock.currentTimeMillis;
    const graceDeadlineMs = Math.min(deadlineAtMs, startedAtMs + INTERRUPT_COMPLETION_GRACE_MS);
    let unsettled = yield* readUnsettledTurnRows(context.universe.root_thread_id);
    while (
      unsettled.rows.some((row) => row.status === "active" || row.status === "waiting") &&
      (yield* Clock.currentTimeMillis) < graceDeadlineMs
    ) {
      const remainingGraceMs = graceDeadlineMs - (yield* Clock.currentTimeMillis);
      if (remainingGraceMs <= 0) break;
      yield* Effect.sleep(`${Math.min(100, remainingGraceMs)} millis`);
      unsettled = yield* readUnsettledTurnRows(context.universe.root_thread_id);
    }
    if (unsettled.rows.length === 0) {
      return {
        discoveryComplete: unsettled.discoveryComplete,
        interruptedThreadIds: [],
        failed: [],
        unresolvedThreadIds: [],
      };
    }

    const readLatestTurn = (threadId: string) =>
      gateway.requestOnHost(
        context.universe.host_id,
        "thread/turns/list",
        {
          threadId,
          cursor: null,
          limit: 1,
          sortDirection: "desc",
          itemsView: "notLoaded",
        },
        {
          priority: "background",
          source: "collab_hydration",
          conversationId: context.universe.root_thread_id,
          widgetId: "subagent-lifecycle:interrupt-skeleton",
          coalesce: true,
          timeoutMs: DISCOVERY_PAGE_TIMEOUT_MS,
          ...codexGatewayGenerationFence(context.capability),
        },
      );
    const readLatestTurnWithAuthority = (threadId: string) =>
      Effect.gen(function* () {
        const authority = yield* readOverviewItem(context, threadId);
        if (!authority.item) return { _tag: "MissingAuthority" } as const;
        if (authority.item.status === "done") return { _tag: "AlreadyDone" } as const;
        const evidence = authority.item.evidence;
        const precondition: StatusEvidencePrecondition = evidence
          ? {
              mode: "exact",
              evidence_kind: evidence.kind,
              source_revision: evidence.source_revision,
              observed_at_ms: evidence.observed_at_ms,
            }
          : { mode: "absent" };
        return {
          _tag: "Read" as const,
          precondition,
          result: yield* readLatestTurn(threadId).pipe(Effect.result),
        };
      });
    const settleObservedTurn = (
      row: CodexSubagentOverviewWindow["active"]["rows"][number],
      turn: { readonly status: string; readonly completedAt?: number | null } | undefined,
      interrupted: boolean,
      precondition: StatusEvidencePrecondition,
    ): Effect.Effect<CodexSubagentInterruptOutcome, CodexSubagentDirectoryError> => {
      if (!turn || turn.status === "inProgress") {
        return Effect.succeed({ threadId: row.threadId, outcome: "unresolved" });
      }
      return Effect.gen(function* () {
        const observedAtMs =
          Math.max(0, Math.trunc(turn.completedAt ?? 0)) * 1_000 ||
          (yield* Clock.currentTimeMillis);
        yield* applyStatusEvidence(
          context,
          row.threadId,
          "done",
          "reconciliation",
          precondition.mode === "exact" ? precondition.source_revision : 0,
          observedAtMs,
          precondition,
        );
        const authority = yield* readOverviewItem(context, row.threadId);
        if (authority.item?.status !== "done") {
          return { threadId: row.threadId, outcome: "unresolved" as const };
        }
        return {
          threadId: row.threadId,
          outcome: interrupted ? ("interrupted" as const) : ("settled" as const),
        };
      });
    };

    const postconditionDeadlineMs = deadlineAtMs;
    const settleRow = (
      row: CodexSubagentOverviewWindow["active"]["rows"][number],
    ): Effect.Effect<CodexSubagentInterruptOutcome> =>
      Effect.gen(function* () {
        const initialRead = yield* readLatestTurnWithAuthority(row.threadId);
        if (initialRead._tag === "MissingAuthority") {
          return { threadId: row.threadId, outcome: "unresolved" as const };
        }
        if (initialRead._tag === "AlreadyDone") {
          return { threadId: row.threadId, outcome: "settled" as const };
        }
        const settleTerminalAbsence = (
          interrupted: boolean,
          precondition: StatusEvidencePrecondition,
        ) => settleObservedTurn(row, { status: "completed" }, interrupted, precondition);
        const initial = initialRead.result;
        if (initial._tag === "Failure") {
          if (
            isCodexThreadStopAlreadySettledRequestError(initial.failure, {
              method: "thread/turns/list",
              threadId: row.threadId,
            })
          ) {
            return yield* settleTerminalAbsence(false, initialRead.precondition);
          }
          return yield* initial.failure;
        }
        const turn = initial.success.data[0];
        if (!turn || turn.status !== "inProgress") {
          return yield* settleObservedTurn(row, turn, false, initialRead.precondition);
        }

        const interrupted = yield* gateway
          .requestOnHost(
            context.universe.host_id,
            "turn/interrupt",
            { threadId: row.threadId, turnId: turn.id },
            {
              priority: "critical",
              source: "collab_lifecycle",
              conversationId: context.universe.root_thread_id,
              widgetId: "subagent-lifecycle:interrupt",
              timeoutMs: DISCOVERY_PAGE_TIMEOUT_MS,
              ...codexGatewayGenerationFence(context.capability),
            },
          )
          .pipe(Effect.result);
        if (interrupted._tag === "Failure") {
          if (
            isCodexThreadStopAlreadySettledRequestError(interrupted.failure, {
              method: "turn/interrupt",
              threadId: row.threadId,
              turnId: turn.id,
            })
          ) {
            return yield* settleTerminalAbsence(false, initialRead.precondition);
          }
          return yield* interrupted.failure;
        }

        while ((yield* Clock.currentTimeMillis) < postconditionDeadlineMs) {
          const postconditionRead = yield* readLatestTurnWithAuthority(row.threadId);
          if (postconditionRead._tag === "MissingAuthority") {
            return { threadId: row.threadId, outcome: "unresolved" as const };
          }
          if (postconditionRead._tag === "AlreadyDone") {
            return { threadId: row.threadId, outcome: "interrupted" as const };
          }
          const postcondition = postconditionRead.result;
          if (postcondition._tag === "Failure") {
            if (
              isCodexThreadStopAlreadySettledRequestError(postcondition.failure, {
                method: "thread/turns/list",
                threadId: row.threadId,
              })
            ) {
              return yield* settleTerminalAbsence(true, postconditionRead.precondition);
            }
            return yield* postcondition.failure;
          }
          const observedTurn = postcondition.success.data[0];
          if (!observedTurn || observedTurn.status !== "inProgress") {
            return yield* settleObservedTurn(
              row,
              observedTurn,
              true,
              postconditionRead.precondition,
            );
          }
          const remainingMs = postconditionDeadlineMs - (yield* Clock.currentTimeMillis);
          if (remainingMs <= 0) break;
          yield* Effect.sleep(`${Math.min(100, remainingMs)} millis`);
        }
        return { threadId: row.threadId, outcome: "unresolved" as const };
      }).pipe(
        Effect.catch((cause) =>
          Effect.succeed({
            threadId: row.threadId,
            outcome: "failed" as const,
            reason: cause.message,
          }),
        ),
      );
    const outcomes: CodexSubagentInterruptOutcome[] = [];
    for (let index = 0; index < unsettled.rows.length; index += 2) {
      const remainingMs = postconditionDeadlineMs - (yield* Clock.currentTimeMillis);
      if (remainingMs <= 0) {
        outcomes.push(
          ...unsettled.rows.slice(index).map((row) => ({
            threadId: row.threadId,
            outcome: "unresolved" as const,
          })),
        );
        break;
      }
      const batch = unsettled.rows.slice(index, index + 2);
      const batchOutcomes = yield* Effect.forEach(
        batch,
        (row) =>
          settleRow(row).pipe(
            Effect.timeoutOrElse({
              duration: `${Math.max(1, remainingMs)} millis`,
              orElse: () =>
                Effect.succeed({
                  threadId: row.threadId,
                  outcome: "unresolved" as const,
                }),
            }),
          ),
        { concurrency: 2 },
      );
      outcomes.push(...batchOutcomes);
    }
    const interruptedThreadIds = outcomes.flatMap((outcome) =>
      outcome.outcome === "interrupted" ? [outcome.threadId] : [],
    );
    const failed = outcomes.flatMap((outcome) =>
      outcome.outcome === "failed" ? [{ threadId: outcome.threadId, reason: outcome.reason }] : [],
    );
    const unresolvedThreadIds = outcomes.flatMap((outcome) =>
      outcome.outcome === "unresolved" ? [outcome.threadId] : [],
    );
    return {
      discoveryComplete: unsettled.discoveryComplete,
      interruptedThreadIds,
      failed,
      unresolvedThreadIds,
    };
  });

  const settleInterruptedSubtree = (
    rootThreadId: string,
    options?: { readonly deadlineAtMs: number },
  ) =>
    Effect.gen(function* () {
      const startedAtMs = yield* Clock.currentTimeMillis;
      const deadlineAtMs = options?.deadlineAtMs ?? startedAtMs + INTERRUPT_SETTLEMENT_BUDGET_MS;
      const remainingMs = deadlineAtMs - startedAtMs;
      if (remainingMs <= 0) {
        return {
          discoveryComplete: false,
          interruptedThreadIds: [],
          failed: [],
          unresolvedThreadIds: [],
        } satisfies CodexSubagentInterruptSnapshot;
      }
      return yield* settleInterruptedSubtreeAttempt(rootThreadId, deadlineAtMs).pipe(
        Effect.timeoutOrElse({
          duration: `${remainingMs} millis`,
          // The snapshot remains typed even when discovery itself consumes the budget. The caller
          // can distinguish an incomplete universe from a fully enumerated set of row outcomes.
          orElse: () =>
            Effect.succeed({
              discoveryComplete: false,
              interruptedThreadIds: [],
              failed: [],
              unresolvedThreadIds: [],
            } satisfies CodexSubagentInterruptSnapshot),
        }),
      );
    });

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

        const resident = yield* threadDirectory
          .resolve({ threadId, fidelity: "durable" })
          .pipe(Effect.mapError((cause) => error("hydrate", rootThreadId, cause, threadId)));
        const residentPagination = resident?.snapshot?.turnPagination;
        const hasSparseResidentHistory =
          (resident?.snapshot?.turns.length ?? 0) > 0 ||
          (residentPagination !== undefined &&
            residentPagination.itemsView !== "notLoaded" &&
            (residentPagination.loadedTurnCount > 0 || residentPagination.hasLoadedOldest));
        const selected = hasSparseResidentHistory
          ? resident
          : yield* threadDirectory
              .resolve({ threadId, fidelity: "tail" })
              .pipe(Effect.mapError((cause) => error("hydrate", rootThreadId, cause, threadId)));
        if (!selected)
          return emptySelectedResult(normalizedInput, "Selected Thread is unavailable");

        remember(threadId, true);
        const snapshot = selected.snapshot;
        const attachedSparse =
          snapshot?.turnPagination !== undefined &&
          snapshot.turnPagination.itemsView !== "notLoaded" &&
          (snapshot.turnPagination.loadedTurnCount > 0 || snapshot.turnPagination.hasLoadedOldest);
        const fidelity = hasSparseResidentHistory
          ? "residentSparse"
          : attachedSparse
            ? "attachedSparse"
            : "metadata";
        const overviewItem = yield* readOverviewItem(
          yield* resolveRootContext(rootThreadId),
          threadId,
        );
        if (!overviewItem.item)
          return emptySelectedResult(
            normalizedInput,
            "Selected Thread is outside the current Subagent projection",
          );
        const checkpoint = snapshot
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
      known.clear();
      knownRoots.clear();
      pendingStatusEvidence.clear();
      pendingSpawnObservations.clear();
      pendingSpawnObservationBytes = 0;
      lifecycleQuarantines.clear();
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
    beginLifecycle: (input) => runOwned(beginLifecycle(input)),
    reconcileLifecycle: (input) => runOwned(reconcileLifecycle(input)),
    settleInterruptedSubtree: (rootThreadId, options) =>
      runOwned(settleInterruptedSubtree(rootThreadId, options)),
    shouldDeferLifecycleNotification: (threadId, method) =>
      runOwned(
        Effect.gen(function* () {
          const normalized = threadId.trim();
          const expectedAction = method === "thread/archived" ? "archive" : "delete";
          if (lifecycleQuarantines.get(normalized) === expectedAction) return true;
          const root = yield* threadDirectory
            .resolve({ threadId: normalized, fidelity: "durable" })
            .pipe(Effect.mapError((cause) => error("lifecycle", normalized, cause, normalized)));
          if (!root || root.durable.parentThreadId) return false;
          const context = yield* resolveRootContext(normalized);
          const operationId = lifecycleOperationId(context, expectedAction);
          const lifecycle = yield* readLifecyclePage(normalized, operationId, null).pipe(
            Effect.catch((cause) =>
              isCoreNotFound(cause) ? Effect.succeed(null) : Effect.fail(cause),
            ),
          );
          if (!lifecycle || lifecycle.action !== expectedAction || lifecycle.complete) return false;
          lifecycleQuarantines.set(normalized, expectedAction);
          return true;
        }),
      ),
    releaseLifecycleQuarantine: (rootThreadId, action) => {
      const normalized = rootThreadId.trim();
      if (lifecycleQuarantines.get(normalized) === action) lifecycleQuarantines.delete(normalized);
    },
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
