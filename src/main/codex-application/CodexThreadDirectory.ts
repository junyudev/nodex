import type { Thread, ThreadForkResponse, Turn } from "@nodex/codex-app-server-protocol/v2";
import type { ThreadResumeResponse } from "@nodex/codex-app-server-protocol/v2/ThreadResumeResponse";
import type { ThreadStartResponse } from "@nodex/codex-app-server-protocol/v2/ThreadStartResponse";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import {
  createCodexCanonicalHydratedConversationState,
  createCodexCanonicalWorkspacePermissionContext,
} from "../../shared/codex-conversation-state/codex-conversation-state";
import { isCodexAgentBackendBinding } from "../../shared/agent-backend";
import type { CodexHistoryTurnItemsPagination } from "../../shared/codex-conversation-state/codex-history-topology";
import { extractCodexThreadSubagentMetadata } from "../../shared/codex-subagent-metadata";
import type {
  CodexCanonicalConversationState,
  CodexConversationSnapshot,
  CodexConversationResumeState,
  CodexConversationTurnPagination,
  CodexThreadSummary,
} from "../../shared/types";
import type { CodexExecutionProfile } from "../../shared/codex-execution-profile";
import { normalizeCodexServiceTier } from "../../shared/codex-service-tier";
import type { DesktopProjectWorkspaceThread } from "../core-client/project-workspace-adapter";
import { CoreModuleResponseError } from "../core-client/core-client";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway, codexGatewayGenerationFence } from "../codex-runtime/CodexGateway";
import {
  projectCodexGatewayThreadReadThread,
  projectCodexGatewayThreadResumeResponse,
} from "../codex-runtime/CodexGatewayProtocolProjection";
import { CoreModules } from "../core-runtime/CoreModules";
import { createOperationId } from "../core-runtime/operation-identity";
import { CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexConversationProjection } from "./CodexConversationProjection";
import {
  CodexHistoryPageAdapter,
  type CodexHydratedHistoryItemSegment,
} from "./CodexHistoryPageAdapter";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import {
  buildWorkspaceThreadSummary,
  hasSidebarThreadSummaryChanged,
} from "./CodexThreadCatalogProjection";
import {
  projectCodexThreadDirectoryMaterialization,
  projectCoreWorkspaceThread,
} from "./CodexThreadDirectoryProjection";

export type CodexThreadDirectoryFidelity =
  | "durable"
  | "metadata"
  | "tail"
  | "materialized"
  | "live";
export type CodexThreadDirectoryResolveFidelity = Exclude<
  CodexThreadDirectoryFidelity,
  "materialized"
>;

export interface CodexThreadDirectoryEntry {
  readonly fidelity: CodexThreadDirectoryFidelity;
  /** Persisted history contract observed from app-server, when this read reached app-server. */
  readonly historyMode: Thread["historyMode"] | null;
  readonly durable: DesktopProjectWorkspaceThread;
  readonly summary: CodexThreadSummary;
  readonly canonical: CodexCanonicalConversationState | null;
  readonly snapshot: CodexConversationSnapshot | null;
}

type RuntimeExecutionProfileResponse = Pick<
  ThreadResumeResponse,
  "model" | "reasoningEffort" | "serviceTier"
>;

const projectRuntimeExecutionProfile = (
  response: RuntimeExecutionProfileResponse,
  fallback: CodexExecutionProfile | null,
): CodexExecutionProfile | null => {
  const modelId = response.model.trim();
  if (!modelId) return fallback;
  return {
    modelId,
    reasoningEffort: response.reasoningEffort,
    serviceTier: normalizeCodexServiceTier(response.serviceTier),
  };
};

export class CodexThreadDirectoryError extends Schema.TaggedError<CodexThreadDirectoryError>()(
  "CodexThreadDirectoryError",
  {
    operation: Schema.Literals(["read", "materialize"]),
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class CodexThreadDirectory extends Context.Service<
  CodexThreadDirectory,
  {
    /**
     * Resolves and, when necessary, materializes inside the Thread's causal lane.
     * Callers must run this admission boundary before acquiring that same non-reentrant lane.
     */
    readonly resolve: (input: {
      readonly threadId: string;
      readonly fidelity: CodexThreadDirectoryResolveFidelity;
      readonly hostId?: string;
      /** Keeps speculative relationship hydration off interactive and notification lanes. */
      readonly metadataScheduling?: {
        readonly conversationId: string;
        readonly widgetId: string;
      };
    }) => Effect.Effect<CodexThreadDirectoryEntry | null, CodexThreadDirectoryError>;
    /**
     * Resumes one Thread without acquiring its non-reentrant causal lane. Only callers already
     * executing inside that lane may use this seam.
     */
    readonly materializeInCurrentLane: (input: {
      readonly threadId: string;
      readonly hostId?: string;
    }) => Effect.Effect<CodexThreadDirectoryEntry | null, CodexThreadDirectoryError>;
    /**
     * Accepts a Thread returned by a protocol mutation while the caller owns the Thread lane.
     * The Directory commits durable identity and refreshes the canonical aggregate as one
     * application projection outcome.
     */
    readonly acceptRollbackResult: (input: {
      readonly expectedThreadId: string;
      readonly thread: Thread;
      readonly executionHostId?: string;
      readonly fallbackCwd?: string | null;
      readonly pagination: CodexConversationTurnPagination;
      readonly itemsPaginationByTurnId?: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
    }) => Effect.Effect<CodexThreadDirectoryEntry, CodexThreadDirectoryError>;
    /** Accepts an exact persistent fork and inherits its durable execution authority. */
    readonly acceptForkResult: (input: {
      readonly sourceThreadId: string;
      readonly response: ThreadForkResponse;
      readonly target?: {
        readonly projectId: string | null;
        readonly cwd: string;
        readonly managedWorktreePath: string | null;
        readonly runtimeWorkspaceRoots: readonly string[];
      };
    }) => Effect.Effect<CodexThreadDirectoryEntry, CodexThreadDirectoryError>;
    /** Accepts an imported rollout as a standalone local Thread. */
    readonly acceptImportResult: (input: {
      readonly response: ThreadForkResponse;
      /** Exact endpoint generation that produced the fork response. */
      readonly capability: CodexAppServerCapabilitySnapshot;
      readonly fallbackCwd: string;
      readonly executionHostId?: string;
    }) => Effect.Effect<CodexThreadDirectoryEntry, CodexThreadDirectoryError>;
    /** Links a newly accepted protocol Thread to its exact Session, then hydrates canonical state. */
    readonly acceptSessionStart: (input: {
      readonly response: ThreadStartResponse;
      readonly sessionId: string;
      readonly projectId: string | null;
      readonly executionProfile: CodexExecutionProfile | null;
      readonly runtimeWorkspaceRoots: readonly string[];
      readonly fallbackCwd: string;
      readonly managedWorktreePath: string | null;
      readonly projectlessOutputDirectory?: string | null;
      readonly projectlessWorkspaceBrowserRoot?: string | null;
    }) => Effect.Effect<CodexThreadDirectoryEntry, CodexThreadDirectoryError>;
    /** Accepts a sessionless Main-owned Thread such as a scheduled Automation run. */
    readonly acceptStandaloneStart: (input: {
      readonly response: ThreadStartResponse;
      readonly projectId: string | null;
      readonly executionProfile: CodexExecutionProfile | null;
      readonly runtimeWorkspaceRoots: readonly string[];
      readonly fallbackCwd: string;
      readonly managedWorktreePath?: string | null;
      readonly projectlessOutputDirectory?: string | null;
      readonly projectlessWorkspaceBrowserRoot?: string | null;
    }) => Effect.Effect<CodexThreadDirectoryEntry, CodexThreadDirectoryError>;
    /** Accepts an explicit Main-owned resume after the caller selected its runtime parameters. */
    readonly acceptResumeResult: (input: {
      readonly response: ThreadResumeResponse;
      /** Exact endpoint generation that produced the resume response. */
      readonly capability: CodexAppServerCapabilitySnapshot;
      readonly executionHostId: string;
      readonly fallbackCwd: string;
    }) => Effect.Effect<CodexThreadDirectoryEntry, CodexThreadDirectoryError>;
    /** Commits one app-server catalog observation with an explicit initial ownership decision. */
    readonly observeMetadata: (input: {
      readonly thread: Thread;
      readonly inferredInitialProjectId: string | null;
      readonly executionHostId?: string;
    }) => Effect.Effect<CodexThreadDirectoryEntry, CodexThreadDirectoryError>;
  }
>()("nodex/main/codex-application/CodexThreadDirectory") {}

type CoreThread = Parameters<typeof projectCoreWorkspaceThread>[0];

interface DurableThread {
  readonly raw: CoreThread;
  readonly thread: DesktopProjectWorkspaceThread;
}

const normalizeTurn = (turn: Turn): Turn => ({
  ...turn,
  items: [...turn.items],
  itemsView: turn.itemsView ?? "full",
  error: turn.error ?? null,
  startedAt: turn.startedAt ?? null,
  completedAt: turn.completedAt ?? null,
  durationMs: turn.durationMs ?? null,
});

const normalizeThread = (thread: Thread): Thread => ({
  ...thread,
  turns: thread.turns.map(normalizeTurn),
});

const isCoreNotFound = (cause: unknown): boolean =>
  cause instanceof CoreRuntimeError &&
  cause.cause instanceof CoreModuleResponseError &&
  cause.cause.coreError.code === "not_found";

const fullPagination = (thread: Thread): CodexConversationTurnPagination => ({
  olderCursor: null,
  backwardsCursor: null,
  oldestLoadedTurnId: thread.turns[0]?.id ?? null,
  isLoadingOlder: false,
  hasLoadedOldest: true,
  loadedTurnCount: thread.turns.length,
  itemsView: "full",
});

export const make: Effect.Effect<
  CodexThreadDirectory["Service"],
  never,
  | CodexApplicationEventHub
  | CodexConversationProjection
  | CodexHistoryPageAdapter
  | CodexAppServerCapabilities
  | CodexGateway
  | ConversationEntityMap
  | CoreModules
  | Scope.Scope
> = Effect.gen(function* () {
  const ownerScope = yield* Scope.Scope;
  const events = yield* CodexApplicationEventHub;
  const projection = yield* CodexConversationProjection;
  const historyPages = yield* CodexHistoryPageAdapter;
  const capabilities = yield* CodexAppServerCapabilities;
  const gateway = yield* CodexGateway;
  const conversations = yield* ConversationEntityMap;
  const core = yield* CoreModules;

  const error = (
    operation: CodexThreadDirectoryError["operation"],
    threadId: string,
    cause: unknown,
  ) => new CodexThreadDirectoryError({ operation, threadId, cause });

  /**
   * A mutation or metadata read is not a transcript transport. Validate the raw wire object
   * before copying it, so a non-compliant endpoint cannot be made safe by overwriting `turns`.
   */
  const requireMetadataShell = (
    operation: CodexThreadDirectoryError["operation"],
    threadId: string,
    thread: {
      readonly turns: readonly unknown[];
      readonly historyMode?: Thread["historyMode"];
    },
    requirePaginatedHistory: boolean,
  ): Effect.Effect<void, CodexThreadDirectoryError> => {
    if (thread.turns.length !== 0) {
      return Effect.fail(
        error(
          operation,
          threadId,
          new Error("Codex app-server returned inline Thread history at a metadata boundary"),
        ),
      );
    }
    if (!requirePaginatedHistory || thread.historyMode === "paginated") return Effect.void;
    return Effect.fail(
      error(
        operation,
        threadId,
        new Error("Codex app-server did not return the required paginated history shell"),
      ),
    );
  };

  const requireCurrentCapability = (
    threadId: string,
    capability: CodexAppServerCapabilitySnapshot,
    stage: string,
    operation: CodexThreadDirectoryError["operation"] = "read",
  ): Effect.Effect<void, CodexThreadDirectoryError> =>
    capabilities.isCurrent(capability).pipe(
      Effect.mapError((cause) => error(operation, threadId, cause)),
      Effect.flatMap((current) =>
        current
          ? Effect.void
          : Effect.fail(
              error(
                operation,
                threadId,
                new Error(`Codex app-server generation changed while ${stage}`),
              ),
            ),
      ),
    );

  const requireCapabilityHost = (
    threadId: string,
    capability: CodexAppServerCapabilitySnapshot,
    hostId: string,
  ): Effect.Effect<void, CodexThreadDirectoryError> =>
    capability.hostId === hostId
      ? Effect.void
      : Effect.fail(
          error(
            "materialize",
            threadId,
            new Error(
              `Codex app-server capability belongs to '${capability.hostId}', not '${hostId}'`,
            ),
          ),
        );

  const runOwned = <A>(
    operation: Effect.Effect<A, CodexThreadDirectoryError>,
  ): Effect.Effect<A, CodexThreadDirectoryError> =>
    Effect.acquireUseRelease(
      operation.pipe(Effect.forkIn(ownerScope, { startImmediately: true })),
      Fiber.join,
      Fiber.interrupt,
    );

  const readDurable = (
    threadId: string,
  ): Effect.Effect<DurableThread | null, CodexThreadDirectoryError> =>
    core.workspace.read({ kind: "thread", thread_id: threadId }).pipe(
      Effect.flatMap((response) =>
        response.value.kind === "thread"
          ? Effect.succeed({
              raw: response.value.thread,
              thread: projectCoreWorkspaceThread(response.value.thread),
            })
          : Effect.fail(
              error("read", threadId, new Error("Core returned a non-thread read variant")),
            ),
      ),
      Effect.catch((cause) =>
        isCoreNotFound(cause)
          ? Effect.succeed(null)
          : Effect.fail(
              cause instanceof CodexThreadDirectoryError ? cause : error("read", threadId, cause),
            ),
      ),
    );

  const entry = (
    durable: DurableThread,
    fidelity: CodexThreadDirectoryFidelity,
    observedHistoryMode?: Thread["historyMode"],
  ): CodexThreadDirectoryEntry => {
    const aggregate = conversations.current(durable.thread.threadId);
    const state = aggregate?.read();
    return {
      fidelity,
      historyMode: observedHistoryMode ?? state?.canonicalState?.protocol.historyMode ?? null,
      durable: durable.thread,
      summary: buildWorkspaceThreadSummary(durable.thread),
      canonical: state?.canonicalState ?? null,
      snapshot:
        state?.streamRole === "owner"
          ? (state.snapshot ?? null)
          : (state?.acceptedReplica?.conversation ?? state?.snapshot ?? null),
    };
  };

  const persistObservation = Effect.fn("CodexThreadDirectory.persistObservation")(
    function* (input: {
      readonly thread: Thread | Record<string, unknown>;
      readonly parentThreadId?: string | null;
      readonly lineageRootThreadId?: string;
      readonly forkedFromId?: string | null;
      readonly executionProfile?: CodexExecutionProfile | null;
      readonly managedWorktreePath?: string | null;
      readonly inferredInitialProjectId?: string | null;
      readonly executionHostId?: string;
      readonly fallbackCwd?: string | null;
      readonly hasUnreadTurn?: boolean;
    }): Effect.fn.Return<DurableThread, CodexThreadDirectoryError> {
      const record = input.thread as unknown as Record<string, unknown>;
      const threadId = typeof record.id === "string" ? record.id.trim() : "";
      if (!threadId) {
        return yield* error(
          "materialize",
          "unknown",
          new Error("App-server Thread identity is missing"),
        );
      }
      const previous = yield* readDurable(threadId);
      const parentThreadId =
        input.parentThreadId ?? extractCodexThreadSubagentMetadata(record).parentThreadId;
      const parent = parentThreadId ? yield* readDurable(parentThreadId) : null;
      const lineageRoot =
        !parent && input.lineageRootThreadId ? yield* readDurable(input.lineageRootThreadId) : null;
      const nowMs = yield* Clock.currentTimeMillis;
      const materialization = projectCodexThreadDirectoryMaterialization({
        thread: input.thread,
        existing: previous?.thread ?? null,
        parent: parent?.thread ?? lineageRoot?.thread ?? null,
        explicitParentThreadId: parentThreadId,
        ...(input.forkedFromId !== undefined ? { explicitForkedFromId: input.forkedFromId } : {}),
        ...(input.executionProfile !== undefined
          ? { executionProfile: input.executionProfile }
          : {}),
        ...(input.managedWorktreePath !== undefined
          ? { managedWorktreePath: input.managedWorktreePath }
          : {}),
        ...(input.inferredInitialProjectId !== undefined
          ? { inferredInitialProjectId: input.inferredInitialProjectId }
          : {}),
        observedExecutionHostId: input.executionHostId,
        fallbackCwd: input.fallbackCwd,
        nowMs,
      });
      if (!materialization) {
        return yield* error(
          "materialize",
          threadId,
          new Error("App-server Thread could not be materialized"),
        );
      }
      const patch = {
        ...materialization.patch,
        ...(input.hasUnreadTurn !== undefined ? { has_unread_turn: input.hasUnreadTurn } : {}),
      };
      yield* core.workspace
        .apply({
          operationId: createOperationId("thread-directory.upsert"),
          intent: {
            kind: "upsert_thread",
            thread_id: threadId,
            patch,
          },
        })
        .pipe(Effect.mapError((cause) => error("materialize", threadId, cause)));
      const persisted = yield* readDurable(threadId);
      if (!persisted) {
        return yield* error(
          "materialize",
          threadId,
          new Error("Core did not return the materialized Thread"),
        );
      }
      const previousSummary = previous ? buildWorkspaceThreadSummary(previous.thread) : null;
      const summary = buildWorkspaceThreadSummary(persisted.thread);
      if (hasSidebarThreadSummaryChanged(previousSummary, summary)) {
        events.publish({ kind: "codex", value: { type: "threadSummary", thread: summary } });
      }
      return persisted;
    },
  );

  const hydrate = Effect.fn("CodexThreadDirectory.hydrate")(function* (input: {
    readonly durable: DurableThread;
    readonly thread: Thread;
    readonly context?: ThreadResumeResponse;
    readonly pagination: CodexConversationTurnPagination;
    readonly itemsPaginationByTurnId?: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
    readonly itemSegmentsByTurnId?: Readonly<
      Record<string, readonly CodexHydratedHistoryItemSegment[]>
    >;
    readonly pendingRequests?: readonly [];
    readonly hasUnreadTurn?: boolean;
    readonly fidelity?: "tail" | "materialized" | "live";
    readonly resumeState?: CodexConversationResumeState;
  }): Effect.fn.Return<CodexThreadDirectoryEntry, CodexThreadDirectoryError> {
    const threadId = input.durable.thread.threadId;
    const aggregate = conversations.entity(threadId);
    const existingHydrationContext = aggregate.readCanonicalState()?.sidecar.hydrationContext;
    const existingPermissions = existingHydrationContext?.currentPermissions;
    const fallbackPermissions = createCodexCanonicalWorkspacePermissionContext(
      input.durable.raw.writable_roots,
    );
    const permissions = input.context
      ? {
          activePermissionProfile: input.context.activePermissionProfile,
          runtimeWorkspaceRoots: [...input.context.runtimeWorkspaceRoots],
          approvalPolicy: input.context.approvalPolicy,
          approvalsReviewer: input.context.approvalsReviewer,
          sandboxPolicy: input.context.sandbox,
        }
      : (existingPermissions ?? fallbackPermissions);
    const latestThreadSettings = input.context
      ? {
          cwd: input.context.cwd,
          approvalPolicy: input.context.approvalPolicy,
          approvalsReviewer: input.context.approvalsReviewer,
          activePermissionProfile: input.context.activePermissionProfile,
          sandboxPolicy: input.context.sandbox,
          model: input.context.model,
          serviceTier: normalizeCodexServiceTier(input.context.serviceTier),
          effort: input.context.reasoningEffort,
          multiAgentMode: input.context.multiAgentMode,
        }
      : (existingHydrationContext?.latestThreadSettings ?? null);
    const canonical = yield* Effect.try({
      try: () =>
        createCodexCanonicalHydratedConversationState(input.thread, {
          model: input.context?.model ?? input.durable.thread.executionProfile?.modelId ?? "",
          reasoningEffort:
            input.context?.reasoningEffort ??
            input.durable.thread.executionProfile?.reasoningEffort ??
            null,
          cwd: input.context?.cwd || input.durable.thread.cwd || input.thread.cwd || "/",
          approvalPolicy: permissions.approvalPolicy,
          approvalsReviewer: permissions.approvalsReviewer,
          sandboxPolicy: permissions.sandboxPolicy,
          activePermissionProfile: permissions.activePermissionProfile,
          runtimeWorkspaceRoots: [...permissions.runtimeWorkspaceRoots],
          latestThreadSettings,
          pendingRequests: input.pendingRequests ?? aggregate.readServerRequests(),
          hasUnreadTurn: input.hasUnreadTurn ?? input.durable.thread.hasUnreadTurn,
          turnItemsPaginationById: input.itemsPaginationByTurnId,
        }),
      catch: (cause) => error("materialize", threadId, cause),
    });
    const observedAtMs = yield* Clock.currentTimeMillis;
    const snapshot = yield* projection
      .hydrate({
        threadId,
        summary: buildWorkspaceThreadSummary(input.durable.thread),
        canonical,
        pagination: input.pagination,
        itemsPaginationByTurnId: input.itemsPaginationByTurnId,
        itemSegmentsByTurnId: input.itemSegmentsByTurnId,
        observedAtMs,
        resumeState: input.resumeState,
      })
      .pipe(Effect.mapError((cause) => error("materialize", threadId, cause)));
    return {
      fidelity: input.fidelity ?? (input.context ? "live" : "materialized"),
      historyMode: input.thread.historyMode,
      durable: input.durable.thread,
      summary: buildWorkspaceThreadSummary(input.durable.thread),
      canonical,
      snapshot,
    };
  });

  const readRemote = Effect.fn("CodexThreadDirectory.readRemote")(function* (
    threadId: string,
    fidelity: Exclude<CodexThreadDirectoryResolveFidelity, "durable">,
    hostId: string,
    metadataScheduling?: { readonly conversationId: string; readonly widgetId: string },
  ): Effect.fn.Return<CodexThreadDirectoryEntry, CodexThreadDirectoryError> {
    const readMetadata = (capability: CodexAppServerCapabilitySnapshot) =>
      gateway
        .requestOnHost(
          hostId,
          "thread/read",
          { threadId, includeTurns: false },
          {
            ...codexGatewayGenerationFence(capability),
            ...(metadataScheduling
              ? {
                  priority: "background" as const,
                  source: "collab_hydration" as const,
                  conversationId: metadataScheduling.conversationId,
                  widgetId: metadataScheduling.widgetId,
                  coalesce: true,
                }
              : {}),
          },
        )
        .pipe(Effect.mapError((cause) => error("read", threadId, cause)));
    if (fidelity === "live") {
      const capability = yield* capabilities
        .forHost(hostId)
        .pipe(Effect.mapError((cause) => error("read", threadId, cause)));
      if (!capability.flags.paginatedHistory) {
        return yield* error(
          "read",
          threadId,
          new Error("Live Thread resume requires bounded paginated history support"),
        );
      }
      const gatewayResponse = yield* gateway
        .requestOnHost(
          hostId,
          "thread/resume",
          { threadId, excludeTurns: true },
          codexGatewayGenerationFence(capability),
        )
        .pipe(Effect.mapError((cause) => error("read", threadId, cause)));
      const response = projectCodexGatewayThreadResumeResponse(gatewayResponse);
      if (response.thread.id !== threadId) {
        return yield* error(
          "read",
          threadId,
          new Error(`Expected Thread '${threadId}' but received '${response.thread.id}'`),
        );
      }
      yield* requireMetadataShell("read", threadId, response.thread, true);
      yield* requireCurrentCapability(threadId, capability, "accepting Thread resume metadata");
      const metadataThread = normalizeThread(response.thread);
      const durable = yield* persistObservation({
        thread: metadataThread,
        executionHostId: hostId,
      });
      const paginatedPage = yield* historyPages
        .loadTurnPage({
          capability,
          threadId,
          cursor: response.turnsBackwardsCursor ?? null,
          initialItemsCursor: response.itemsBackwardsCursor ?? null,
          purpose: "initial",
        })
        .pipe(Effect.mapError((cause) => error("read", threadId, cause)));
      yield* requireCurrentCapability(threadId, capability, "loading Thread history");
      const thread = normalizeThread({
        ...response.thread,
        turns: [...paginatedPage.turns],
      });
      const pagination: CodexConversationTurnPagination = {
        olderCursor: paginatedPage.nextCursor,
        backwardsCursor: paginatedPage.backwardsCursor,
        oldestLoadedTurnId: thread.turns[0]?.id ?? null,
        isLoadingOlder: false,
        hasLoadedOldest: paginatedPage.nextCursor === null,
        loadedTurnCount: thread.turns.length,
        itemsView: Object.values(paginatedPage.itemsPaginationByTurnId).every(
          (item) => item.itemsView === "full",
        )
          ? "full"
          : "summary",
      };
      return yield* hydrate({
        durable,
        thread,
        context: response,
        pagination,
        itemsPaginationByTurnId: paginatedPage?.itemsPaginationByTurnId,
        itemSegmentsByTurnId: paginatedPage?.itemSegmentsByTurnId,
      });
    }

    if (fidelity === "tail") {
      const capability = yield* capabilities
        .forHost(hostId)
        .pipe(Effect.mapError((cause) => error("read", threadId, cause)));
      const metadataResponse = yield* readMetadata(capability);
      if (metadataResponse.thread.id !== threadId) {
        return yield* error(
          "read",
          threadId,
          new Error(`Expected Thread '${threadId}' but received '${metadataResponse.thread.id}'`),
        );
      }
      const rawMetadataThread = projectCodexGatewayThreadReadThread(metadataResponse.thread);
      yield* requireMetadataShell("read", threadId, rawMetadataThread, false);
      if (capability.flags.paginatedHistory && rawMetadataThread.historyMode !== "paginated") {
        return yield* error(
          "read",
          threadId,
          new Error("Codex app-server omitted paginated history from a paginated host response"),
        );
      }
      yield* requireCurrentCapability(threadId, capability, "accepting Thread metadata");
      const metadataThread = normalizeThread(rawMetadataThread);
      const durable = yield* persistObservation({
        thread: metadataThread,
        executionHostId: hostId,
      });
      if (capability.flags.paginatedHistory && metadataThread.historyMode === "paginated") {
        const page = yield* historyPages
          .loadTurnPage({
            capability,
            threadId,
            cursor: null,
            initialItemsCursor: null,
            purpose: "initial",
          })
          .pipe(Effect.mapError((cause) => error("read", threadId, cause)));
        yield* requireCurrentCapability(threadId, capability, "loading Thread history");
        const thread = normalizeThread({ ...metadataThread, turns: [...page.turns] });
        return yield* hydrate({
          durable,
          thread,
          fidelity: "tail",
          pagination: {
            olderCursor: page.nextCursor,
            backwardsCursor: page.backwardsCursor,
            oldestLoadedTurnId: thread.turns[0]?.id ?? null,
            isLoadingOlder: false,
            hasLoadedOldest: page.nextCursor === null,
            loadedTurnCount: thread.turns.length,
            itemsView: Object.values(page.itemsPaginationByTurnId).every(
              (item) => item.itemsView === "full",
            )
              ? "full"
              : "summary",
          },
          itemsPaginationByTurnId: page.itemsPaginationByTurnId,
          itemSegmentsByTurnId: page.itemSegmentsByTurnId,
        });
      }

      const resident = entry(durable, "tail", metadataThread.historyMode);
      if (resident.snapshot) return resident;

      // Legacy history has no bounded read primitive. Keep metadata useful, but never turn a tail
      // read into the old unbounded `thread/read(includeTurns: true)` compatibility path.
      const accepted = yield* hydrate({
        durable,
        thread: { ...metadataThread, turns: [] },
        fidelity: "tail",
        pagination: {
          olderCursor: null,
          backwardsCursor: null,
          oldestLoadedTurnId: null,
          isLoadingOlder: false,
          hasLoadedOldest: false,
          loadedTurnCount: 0,
          itemsView: "notLoaded",
        },
      });
      const aggregate = conversations.current(threadId);
      aggregate?.setResumeState("needs_resume");
      return {
        ...accepted,
        snapshot: aggregate?.readSnapshot() ?? accepted.snapshot,
      };
    }
    const capability = yield* capabilities
      .forHost(hostId)
      .pipe(Effect.mapError((cause) => error("read", threadId, cause)));
    const response = yield* readMetadata(capability);
    if (response.thread.id !== threadId) {
      return yield* error(
        "read",
        threadId,
        new Error(`Expected Thread '${threadId}' but received '${response.thread.id}'`),
      );
    }
    const rawThread = projectCodexGatewayThreadReadThread(response.thread);
    yield* requireMetadataShell("read", threadId, rawThread, false);
    yield* requireCurrentCapability(threadId, capability, "accepting Thread metadata");
    const thread = normalizeThread(rawThread);
    const durable = yield* persistObservation({ thread, executionHostId: hostId });
    return entry(durable, "metadata", thread.historyMode);
  });

  const resolvePhysical = Effect.fn("CodexThreadDirectory.resolve")(function* (input: {
    readonly threadId: string;
    readonly fidelity: CodexThreadDirectoryResolveFidelity;
    readonly hostId?: string;
    readonly metadataScheduling?: {
      readonly conversationId: string;
      readonly widgetId: string;
    };
  }): Effect.fn.Return<CodexThreadDirectoryEntry | null, CodexThreadDirectoryError> {
    const threadId = input.threadId.trim();
    if (!threadId) return null;
    const durable = yield* readDurable(threadId);
    if (durable && !isCodexAgentBackendBinding(durable.thread.backendBinding)) return null;
    if (input.fidelity === "durable" && durable) return entry(durable, "durable");
    const hostId = durable?.thread.executionHostId ?? input.hostId?.trim();
    if (!hostId) return null;
    if (input.fidelity === "durable") {
      return yield* conversations.runCommand(
        threadId,
        readRemote(threadId, "metadata", hostId, input.metadataScheduling),
      );
    }
    return yield* conversations.runCommand(
      threadId,
      readRemote(threadId, input.fidelity, hostId, input.metadataScheduling),
    );
  });

  const acceptRollbackResult = Effect.fn("CodexThreadDirectory.acceptRollbackResult")(
    function* (input: {
      readonly expectedThreadId: string;
      readonly thread: Thread;
      readonly executionHostId?: string;
      readonly fallbackCwd?: string | null;
      readonly pagination: CodexConversationTurnPagination;
      readonly itemsPaginationByTurnId?: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
    }): Effect.fn.Return<CodexThreadDirectoryEntry, CodexThreadDirectoryError> {
      const expectedThreadId = input.expectedThreadId.trim();
      if (!expectedThreadId || input.thread.id !== expectedThreadId) {
        return yield* error(
          "materialize",
          expectedThreadId || input.thread.id,
          new Error(`Expected Thread '${expectedThreadId}' but received '${input.thread.id}'`),
        );
      }
      const thread = normalizeThread(input.thread);
      const durable = yield* persistObservation({
        thread,
        ...(input.executionHostId ? { executionHostId: input.executionHostId } : {}),
        ...(input.fallbackCwd !== undefined ? { fallbackCwd: input.fallbackCwd } : {}),
        hasUnreadTurn: false,
      });
      return yield* hydrate({
        durable,
        thread,
        pagination: input.pagination,
        itemsPaginationByTurnId: input.itemsPaginationByTurnId,
        pendingRequests: [],
        hasUnreadTurn: false,
      });
    },
  );

  const acceptForkResult = Effect.fn("CodexThreadDirectory.acceptForkResult")(function* (input: {
    readonly sourceThreadId: string;
    readonly response: ThreadForkResponse;
    readonly target?: {
      readonly projectId: string | null;
      readonly cwd: string;
      readonly managedWorktreePath: string | null;
      readonly runtimeWorkspaceRoots: readonly string[];
    };
  }): Effect.fn.Return<CodexThreadDirectoryEntry, CodexThreadDirectoryError> {
    const sourceThreadId = input.sourceThreadId.trim();
    const childThreadId = input.response.thread.id.trim();
    if (!sourceThreadId || !childThreadId || childThreadId !== input.response.thread.id) {
      return yield* error(
        "materialize",
        childThreadId || sourceThreadId,
        new Error("Thread fork did not return a valid source and child identity"),
      );
    }
    if (
      input.response.thread.forkedFromId !== null &&
      input.response.thread.forkedFromId !== sourceThreadId
    ) {
      return yield* error(
        "materialize",
        childThreadId,
        new Error(
          `Fork '${childThreadId}' belongs to '${input.response.thread.forkedFromId}', not '${sourceThreadId}'`,
        ),
      );
    }
    if (
      input.response.thread.historyMode !== "paginated" ||
      input.response.thread.turns.length > 0
    ) {
      return yield* error(
        "materialize",
        childThreadId,
        new Error("Forked Thread must return a metadata-only paginated shell"),
      );
    }
    const source = yield* readDurable(sourceThreadId);
    if (!source) {
      return yield* error(
        "materialize",
        sourceThreadId,
        new Error(`Fork source Thread '${sourceThreadId}' was not found`),
      );
    }
    const execution = yield* core.workspace
      .read({ kind: "execution_context", thread_id: sourceThreadId })
      .pipe(Effect.mapError((cause) => error("read", sourceThreadId, cause)));
    if (execution.value.kind !== "execution_context") {
      return yield* error(
        "read",
        sourceThreadId,
        new Error("Core returned a non-execution-context read variant"),
      );
    }
    const executionProfile = projectRuntimeExecutionProfile(
      input.response,
      source.thread.executionProfile ?? null,
    );
    const thread = normalizeThread({
      ...input.response.thread,
      forkedFromId: sourceThreadId,
      turns: [],
    });
    yield* persistObservation({
      thread,
      lineageRootThreadId: sourceThreadId,
      forkedFromId: sourceThreadId,
      executionProfile,
      managedWorktreePath: input.target?.managedWorktreePath ?? source.thread.managedWorktreePath,
      ...(input.target ? { inferredInitialProjectId: input.target.projectId } : {}),
      executionHostId: source.thread.executionHostId,
      fallbackCwd: input.target?.cwd ?? source.thread.cwd,
      hasUnreadTurn: false,
    });
    yield* core.workspace
      .apply({
        operationId: createOperationId("thread-directory.fork-catalogs"),
        intent: {
          kind: "replace_thread_dynamic_tool_catalogs",
          thread_id: childThreadId,
          catalogs: execution.value.context.thread.dynamic_tool_catalogs,
        },
      })
      .pipe(Effect.mapError((cause) => error("materialize", childThreadId, cause)));
    yield* core.workspace
      .apply({
        operationId: createOperationId("thread-directory.fork-roots"),
        intent: {
          kind: "replace_thread_writable_roots",
          thread_id: childThreadId,
          roots: input.target?.runtimeWorkspaceRoots ?? input.response.runtimeWorkspaceRoots,
        },
      })
      .pipe(Effect.mapError((cause) => error("materialize", childThreadId, cause)));
    const durable = yield* readDurable(childThreadId);
    if (!durable) {
      return yield* error(
        "materialize",
        childThreadId,
        new Error("Core did not return the materialized fork Thread"),
      );
    }
    const accepted = yield* hydrate({
      durable,
      thread,
      context: input.response as unknown as ThreadResumeResponse,
      pagination: {
        olderCursor: null,
        backwardsCursor: null,
        oldestLoadedTurnId: null,
        isLoadingOlder: false,
        hasLoadedOldest: false,
        loadedTurnCount: 0,
        itemsView: "notLoaded",
      },
      pendingRequests: [],
      hasUnreadTurn: false,
      fidelity: "tail",
      resumeState: "needs_resume",
    });
    return entry(durable, "tail", accepted.historyMode ?? thread.historyMode);
  });

  const acceptImportResult = Effect.fn("CodexThreadDirectory.acceptImportResult")(
    function* (input: {
      readonly response: ThreadForkResponse;
      readonly capability: CodexAppServerCapabilitySnapshot;
      readonly fallbackCwd: string;
      readonly executionHostId?: string;
    }): Effect.fn.Return<CodexThreadDirectoryEntry, CodexThreadDirectoryError> {
      const threadId = input.response.thread.id.trim();
      if (!threadId || threadId !== input.response.thread.id) {
        return yield* error(
          "materialize",
          threadId,
          new Error("Imported rollout did not return a valid Thread id"),
        );
      }
      const executionHostId = input.executionHostId?.trim() || input.capability.hostId;
      yield* requireCapabilityHost(threadId, input.capability, executionHostId);
      if (!input.capability.flags.paginatedHistory) {
        return yield* error(
          "materialize",
          threadId,
          new Error("Native session import requires bounded paginated history support"),
        );
      }
      yield* requireMetadataShell("materialize", threadId, input.response.thread, true);
      yield* requireCurrentCapability(
        threadId,
        input.capability,
        "accepting imported Thread metadata",
      );
      const metadataThread = normalizeThread(input.response.thread);
      const durable = yield* persistObservation({
        thread: metadataThread,
        executionProfile: null,
        managedWorktreePath: null,
        executionHostId,
        fallbackCwd: input.fallbackCwd,
        hasUnreadTurn: false,
      });

      const page = yield* historyPages
        .loadTurnPage({
          capability: input.capability,
          threadId,
          cursor: null,
          initialItemsCursor: null,
          purpose: "initial",
        })
        .pipe(Effect.mapError((cause) => error("read", threadId, cause)));
      yield* requireCurrentCapability(threadId, input.capability, "bootstrapping imported history");
      const thread = normalizeThread({ ...metadataThread, turns: [...page.turns] });
      return yield* hydrate({
        durable,
        thread,
        fidelity: "tail",
        pagination: {
          olderCursor: page.nextCursor,
          backwardsCursor: page.backwardsCursor,
          oldestLoadedTurnId: thread.turns[0]?.id ?? null,
          isLoadingOlder: false,
          hasLoadedOldest: page.nextCursor === null,
          loadedTurnCount: thread.turns.length,
          itemsView: Object.values(page.itemsPaginationByTurnId).every(
            (item) => item.itemsView === "full",
          )
            ? "full"
            : "summary",
        },
        itemsPaginationByTurnId: page.itemsPaginationByTurnId,
        itemSegmentsByTurnId: page.itemSegmentsByTurnId,
        pendingRequests: [],
        hasUnreadTurn: false,
      });
    },
  );

  const acceptSessionStart = Effect.fn("CodexThreadDirectory.acceptSessionStart")(
    function* (input: {
      readonly response: ThreadStartResponse;
      readonly sessionId: string;
      readonly projectId: string | null;
      readonly executionProfile: CodexExecutionProfile | null;
      readonly runtimeWorkspaceRoots: readonly string[];
      readonly fallbackCwd: string;
      readonly managedWorktreePath: string | null;
      readonly projectlessOutputDirectory?: string | null;
      readonly projectlessWorkspaceBrowserRoot?: string | null;
    }): Effect.fn.Return<CodexThreadDirectoryEntry, CodexThreadDirectoryError> {
      const rawThread = input.response.thread as unknown as Thread;
      const threadId = rawThread.id.trim();
      if (!threadId || threadId !== rawThread.id) {
        return yield* error(
          "materialize",
          threadId,
          new Error("Thread start did not return a valid Thread id"),
        );
      }
      yield* requireMetadataShell("materialize", threadId, rawThread, false);
      const thread = normalizeThread(rawThread);
      const cwd = input.response.cwd || thread.cwd || input.fallbackCwd;
      const executionProfile = projectRuntimeExecutionProfile(
        input.response,
        input.executionProfile,
      );
      yield* core.workspace
        .apply({
          operationId: createOperationId("thread-directory.session-thread-start"),
          intent: {
            kind: "mutate_session",
            session_id: input.sessionId,
            intent: {
              kind: "link_thread",
              thread_id: threadId,
              expected_project_id: input.projectId,
              thread_patch: {
                project_id: input.projectId,
                thread_preview: thread.preview,
                model_id: executionProfile?.modelId ?? input.response.model,
                reasoning_effort: executionProfile?.reasoningEffort ?? null,
                service_tier: executionProfile?.serviceTier ?? null,
              },
              execution_location: {
                execution_host_id: gateway.localHostId,
                cwd,
                managed_worktree_path: input.managedWorktreePath,
                runtime_workspace_roots: [...input.runtimeWorkspaceRoots],
                projectless_output_directory: input.projectlessOutputDirectory ?? null,
                projectless_workspace_browser_root: input.projectlessWorkspaceBrowserRoot ?? null,
              },
            },
          },
        })
        .pipe(Effect.mapError((cause) => error("materialize", threadId, cause)));
      const durable = yield* readDurable(threadId);
      if (!durable) {
        return yield* error(
          "materialize",
          threadId,
          new Error("Core did not return the Session-linked Thread"),
        );
      }
      return yield* hydrate({
        durable,
        thread: { ...thread, cwd },
        context: input.response as unknown as ThreadResumeResponse,
        pagination: fullPagination(thread),
      });
    },
  );

  const acceptStandaloneStart = Effect.fn("CodexThreadDirectory.acceptStandaloneStart")(
    function* (input: {
      readonly response: ThreadStartResponse;
      readonly projectId: string | null;
      readonly executionProfile: CodexExecutionProfile | null;
      readonly runtimeWorkspaceRoots: readonly string[];
      readonly fallbackCwd: string;
      readonly managedWorktreePath?: string | null;
      readonly projectlessOutputDirectory?: string | null;
      readonly projectlessWorkspaceBrowserRoot?: string | null;
    }): Effect.fn.Return<CodexThreadDirectoryEntry, CodexThreadDirectoryError> {
      const rawThread = input.response.thread as unknown as Thread;
      const threadId = rawThread.id.trim();
      if (!threadId || threadId !== rawThread.id) {
        return yield* error(
          "materialize",
          threadId,
          new Error("Standalone Thread start did not return a valid Thread id"),
        );
      }
      yield* requireMetadataShell("materialize", threadId, rawThread, false);
      const cwd = input.response.cwd || rawThread.cwd || input.fallbackCwd;
      const executionProfile = projectRuntimeExecutionProfile(
        input.response,
        input.executionProfile,
      );
      const thread = normalizeThread({
        ...rawThread,
        cwd,
        projectlessOutputDirectory: input.projectlessOutputDirectory ?? null,
        projectlessWorkspaceBrowserRoot: input.projectlessWorkspaceBrowserRoot ?? null,
      } as unknown as Thread);
      const durable = yield* persistObservation({
        thread,
        executionProfile,
        managedWorktreePath: input.managedWorktreePath ?? null,
        inferredInitialProjectId: input.projectId,
        executionHostId: gateway.localHostId,
        fallbackCwd: cwd,
      });
      yield* core.workspace
        .apply({
          operationId: createOperationId("thread-directory.standalone-roots"),
          intent: {
            kind: "replace_thread_writable_roots",
            thread_id: threadId,
            roots: [...input.runtimeWorkspaceRoots],
          },
        })
        .pipe(Effect.mapError((cause) => error("materialize", threadId, cause)));
      return yield* hydrate({
        durable,
        thread,
        context: input.response as unknown as ThreadResumeResponse,
        pagination: fullPagination(thread),
      });
    },
  );

  const acceptResumeResult = Effect.fn("CodexThreadDirectory.acceptResumeResult")(
    function* (input: {
      readonly response: ThreadResumeResponse;
      readonly capability: CodexAppServerCapabilitySnapshot;
      readonly executionHostId: string;
      readonly fallbackCwd: string;
    }): Effect.fn.Return<CodexThreadDirectoryEntry, CodexThreadDirectoryError> {
      const rawThread = input.response.thread;
      const threadId = rawThread.id.trim();
      if (!threadId || threadId !== rawThread.id) {
        return yield* error(
          "materialize",
          threadId,
          new Error("Thread resume did not return a valid Thread id"),
        );
      }
      yield* requireCapabilityHost(threadId, input.capability, input.executionHostId);
      if (!input.capability.flags.paginatedHistory) {
        return yield* error(
          "materialize",
          threadId,
          new Error("Thread resume requires bounded paginated history support"),
        );
      }
      yield* requireMetadataShell("materialize", threadId, rawThread, true);
      yield* requireCurrentCapability(
        threadId,
        input.capability,
        "accepting resumed Thread metadata",
      );
      const cwd = input.response.cwd || rawThread.cwd || input.fallbackCwd;
      const metadataThread = normalizeThread({ ...rawThread, cwd });
      const existing = yield* readDurable(threadId);
      const executionProfile = projectRuntimeExecutionProfile(
        input.response,
        existing?.thread.executionProfile ?? null,
      );
      const durable = yield* persistObservation({
        thread: metadataThread,
        executionProfile,
        executionHostId: input.executionHostId,
        fallbackCwd: cwd,
      });
      const paginatedPage = yield* historyPages
        .loadTurnPage({
          capability: input.capability,
          threadId,
          cursor: input.response.turnsBackwardsCursor ?? null,
          initialItemsCursor: input.response.itemsBackwardsCursor ?? null,
          purpose: "initial",
        })
        .pipe(Effect.mapError((cause) => error("read", threadId, cause)));
      yield* requireCurrentCapability(threadId, input.capability, "accepting resume history");
      const resumedThread = normalizeThread({
        ...metadataThread,
        cwd,
        turns: [...paginatedPage.turns],
      });
      const pagination: CodexConversationTurnPagination = {
        olderCursor: paginatedPage.nextCursor,
        backwardsCursor: paginatedPage.backwardsCursor,
        oldestLoadedTurnId: resumedThread.turns[0]?.id ?? null,
        isLoadingOlder: false,
        hasLoadedOldest: paginatedPage.nextCursor === null,
        loadedTurnCount: resumedThread.turns.length,
        itemsView: Object.values(paginatedPage.itemsPaginationByTurnId).every(
          (item) => item.itemsView === "full",
        )
          ? "full"
          : "summary",
      };
      return yield* hydrate({
        durable,
        thread: resumedThread,
        context: input.response,
        pagination,
        itemsPaginationByTurnId: paginatedPage?.itemsPaginationByTurnId,
        itemSegmentsByTurnId: paginatedPage?.itemSegmentsByTurnId,
      });
    },
  );

  return CodexThreadDirectory.of({
    resolve: (input) => runOwned(resolvePhysical(input)),
    materializeInCurrentLane: (input) =>
      Effect.gen(function* () {
        const threadId = input.threadId.trim();
        if (!threadId) return null;
        const durable = yield* readDurable(threadId);
        const hostId = durable?.thread.executionHostId ?? input.hostId?.trim();
        if (!hostId) return null;
        return yield* readRemote(threadId, "live", hostId);
      }),
    acceptRollbackResult: (input) => runOwned(acceptRollbackResult(input)),
    acceptForkResult: (input) => runOwned(acceptForkResult(input)),
    acceptImportResult: (input) => runOwned(acceptImportResult(input)),
    acceptSessionStart: (input) => runOwned(acceptSessionStart(input)),
    acceptStandaloneStart: (input) => runOwned(acceptStandaloneStart(input)),
    acceptResumeResult: (input) => runOwned(acceptResumeResult(input)),
    observeMetadata: (input) =>
      runOwned(
        Effect.gen(function* () {
          yield* requireMetadataShell("materialize", input.thread.id, input.thread, false);
          const durable = yield* persistObservation({
            thread: normalizeThread(input.thread),
            inferredInitialProjectId: input.inferredInitialProjectId,
            executionHostId: input.executionHostId,
          });
          return entry(durable, "metadata");
        }),
      ),
  });
});
