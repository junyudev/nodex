import { randomUUID } from "node:crypto";
import type { ThreadForkParams } from "@nodex/codex-app-server-protocol/v2/ThreadForkParams";
import type { ThreadForkResponse } from "@nodex/codex-app-server-protocol/v2/ThreadForkResponse";
import type { ClientRequestParamsByMethod } from "@nodex/effect-codex-app-server/rpc";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import {
  appendCodexCanonicalForkedFromConversationItem,
  appendCodexCanonicalWorktreeInitItem,
  createCodexCanonicalHydratedConversationState,
  type CodexCanonicalWorktreeInitItem,
} from "../../shared/codex-conversation-state/codex-conversation-state";
import type { CodexForkBrowserSceneContext } from "../../shared/codex-fork-browser-transfer";
import type {
  CodexComposerIntent,
  CodexConversationSnapshot,
  ProjectSession,
} from "../../shared/types";
import { buildCodexThreadConfigOverrides } from "../codex/codex-thread-capabilities";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CoreModules } from "../core-runtime/CoreModules";
import { CodexConversationProjection } from "./CodexConversationProjection";
import { CodexForkSidePanelTransfer } from "./CodexForkSidePanelTransferRuntime";
import { CodexForkTitlePolicy } from "./CodexForkTitlePolicy";
import { CodexOwnerNotificationDrainRuntime } from "./CodexOwnerNotificationDrainRuntime";
import { CodexRendererConversationCoordinator } from "./CodexRendererConversationCoordinator";
import { CodexThreadCatalog } from "./CodexThreadCatalog";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { ThreadCreationRuntime } from "./ThreadCreationRuntime";
import { CodexThreadTitlePersistence } from "./CodexThreadTitlePersistence";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

type GatewayThreadForkParams = ClientRequestParamsByMethod["thread/fork"];

export interface CodexConversationForkInput {
  readonly sourceThreadId: string;
  readonly lastTurnId?: string | null;
  readonly threadSource: NonNullable<ThreadForkParams["threadSource"]>;
  readonly ownerClientId?: string | null;
  readonly sourceSceneContext?: CodexForkBrowserSceneContext;
  readonly target?: {
    readonly projectId: string | null;
    readonly cwd: string;
    readonly managedWorktreePath: string | null;
    readonly runtimeWorkspaceRoots: readonly string[];
  };
  readonly pendingWorktreeId?: string;
  readonly worktreeInit?: CodexCanonicalWorktreeInitItem;
  readonly titleOverride?: {
    readonly childTitle: string | null;
    readonly sourceTitle?: string | null;
  };
}

export interface CodexConversationForkResult {
  readonly threadId: string;
  readonly session: ProjectSession;
  readonly conversation: CodexConversationSnapshot;
  readonly composerIntent: CodexComposerIntent;
}

export class CodexConversationForkError extends Data.TaggedError("CodexConversationForkError")<{
  readonly operation: "admit" | "fork" | "materialize" | "project" | "session" | "adopt";
  readonly sourceThreadId: string;
  readonly cause: unknown;
}> {}

export class CodexConversationFork extends Context.Service<
  CodexConversationFork,
  {
    readonly fork: (
      input: CodexConversationForkInput,
    ) => Effect.Effect<CodexConversationForkResult, CodexConversationForkError>;
  }
>()("nodex/main/codex-application/CodexConversationFork") {}

/**
 * Owns a persistent same-directory fork from protocol mutation through durable Session identity.
 * App-server `thread/started` observations may arrive before the response. The shared start gate
 * holds those observations until this transaction commits the authoritative fork result and exact
 * Session ownership.
 */
export const make: Effect.Effect<
  CodexConversationFork["Service"],
  never,
  | CodexConversationProjection
  | CodexAppServerCapabilities
  | CodexForkSidePanelTransfer
  | CodexForkTitlePolicy
  | CodexGateway
  | CodexOwnerNotificationDrainRuntime
  | CodexRendererConversationCoordinator
  | CodexThreadCatalog
  | CodexThreadDirectory
  | ThreadCreationRuntime
  | CodexThreadTitlePersistence
  | ConversationEntityMap
  | CoreModules
> = Effect.gen(function* () {
  const core = yield* CoreModules;
  const capabilities = yield* CodexAppServerCapabilities;
  const gateway = yield* CodexGateway;
  const projection = yield* CodexConversationProjection;
  const notificationDrain = yield* CodexOwnerNotificationDrainRuntime;
  const rendererConversations = yield* CodexRendererConversationCoordinator;
  const sidePanelTransfers = yield* CodexForkSidePanelTransfer;
  const forkTitles = yield* CodexForkTitlePolicy;
  const catalog = yield* CodexThreadCatalog;
  const directory = yield* CodexThreadDirectory;
  const threadStarts = yield* ThreadCreationRuntime;
  const titles = yield* CodexThreadTitlePersistence;
  const conversations = yield* ConversationEntityMap;

  const error = (
    operation: CodexConversationForkError["operation"],
    sourceThreadId: string,
    cause: unknown,
  ) => new CodexConversationForkError({ operation, sourceThreadId, cause });

  const forkPhysical = Effect.fn("CodexConversationFork.forkPhysical")(function* (
    input: CodexConversationForkInput,
  ): Effect.fn.Return<CodexConversationForkResult, CodexConversationForkError> {
    const sourceThreadId = input.sourceThreadId.trim();
    const requestedLastTurnId = input.lastTurnId;
    const lastTurnId = requestedLastTurnId == null ? null : requestedLastTurnId.trim();
    if (!sourceThreadId) {
      return yield* error("admit", input.sourceThreadId, new Error("Fork source is required"));
    }
    if (requestedLastTurnId != null && !lastTurnId) {
      return yield* error("admit", sourceThreadId, new Error("Fork turn is required"));
    }
    yield* notificationDrain.awaitCurrent(sourceThreadId);
    const source = yield* directory
      .resolve({ threadId: sourceThreadId, fidelity: "durable" })
      .pipe(Effect.mapError((cause) => error("admit", sourceThreadId, cause)));
    if (!source) {
      return yield* error(
        "admit",
        sourceThreadId,
        new Error(`Thread '${sourceThreadId}' was not found`),
      );
    }
    const capability = yield* capabilities
      .forHost(source.durable.executionHostId)
      .pipe(Effect.mapError((cause) => error("admit", sourceThreadId, cause)));
    if (!capability.flags.paginatedHistory) {
      return yield* error(
        "admit",
        sourceThreadId,
        new Error("This Codex host cannot return a bounded persistent fork"),
      );
    }
    if (lastTurnId && !capability.flags.forkLastTurnId) {
      return yield* error(
        "admit",
        sourceThreadId,
        new Error("This Codex host cannot fork through a stable Turn identity"),
      );
    }

    const derivedTitles = source.canonical
      ? yield* forkTitles
          .derive({
            threadId: sourceThreadId,
            projectId: source.durable.projectId,
            forkedFromId: source.summary.forkedFromId ?? null,
            threadName: source.summary.threadName,
            canonical: source.canonical,
          })
          .pipe(Effect.mapError((cause) => error("project", sourceThreadId, cause)))
      : {
          sourceTitle: source.summary.threadName,
          childTitle: null,
        };
    const childTitle = input.titleOverride?.childTitle ?? derivedTitles.childTitle;
    const sourceTitle = input.titleOverride?.sourceTitle ?? derivedTitles.sourceTitle;
    const execution = yield* core.workspace
      .read({ kind: "execution_context", thread_id: sourceThreadId })
      .pipe(Effect.mapError((cause) => error("project", sourceThreadId, cause)));
    if (execution.value.kind !== "execution_context") {
      return yield* error(
        "project",
        sourceThreadId,
        new Error("Core returned a non-execution-context read variant for fork"),
      );
    }
    const profile = source.durable.executionProfile;
    const request = {
      threadId: sourceThreadId,
      ...(lastTurnId ? { lastTurnId } : {}),
      path: null,
      model: profile?.modelId ?? null,
      modelProvider: profile?.providerId ?? null,
      serviceTier: profile?.serviceTier ?? null,
      cwd: input.target?.cwd ?? source.durable.cwd,
      runtimeWorkspaceRoots: [
        ...(input.target?.runtimeWorkspaceRoots ?? execution.value.context.thread.writable_roots),
      ],
      threadSource: input.threadSource,
      excludeTurns: true,
      config: {
        ...(profile?.harnessId ? { harness: profile.harnessId } : {}),
        ...(profile?.reasoningEffort ? { model_reasoning_effort: profile.reasoningEffort } : {}),
        ...buildCodexThreadConfigOverrides(),
      },
    } satisfies ThreadForkParams;
    if (!(yield* capabilities.isCurrent(capability).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* error(
        "fork",
        sourceThreadId,
        new Error("Codex app-server generation changed before persistent fork dispatch"),
      );
    }
    let response = (yield* gateway
      .requestOnHost(
        source.durable.executionHostId,
        "thread/fork",
        request as GatewayThreadForkParams,
        {
          conversationId: sourceThreadId,
          priority: "interactive",
          source: "thread_fork",
        },
      )
      .pipe(
        Effect.mapError((cause) => error("fork", sourceThreadId, cause)),
      )) as unknown as ThreadForkResponse;
    if (response.thread.turns.length !== 0) {
      yield* Effect.logWarning("Bounded Thread fork returned inline history; discarding it").pipe(
        Effect.annotateLogs({
          sourceThreadId,
          childThreadId: response.thread.id,
          inlineTurnCount: response.thread.turns.length,
        }),
      );
      response = {
        ...response,
        thread: { ...response.thread, turns: [] },
      };
    }
    const child = yield* directory
      .acceptForkResult({
        sourceThreadId,
        response,
        ...(input.target ? { target: input.target } : {}),
      })
      .pipe(Effect.mapError((cause) => error("materialize", sourceThreadId, cause)));
    const boundedCanonical = yield* Effect.try({
      try: () =>
        createCodexCanonicalHydratedConversationState(response.thread, {
          model: response.model,
          reasoningEffort: response.reasoningEffort,
          cwd: response.cwd || input.target?.cwd || source.durable.cwd || "/",
          approvalPolicy: response.approvalPolicy,
          approvalsReviewer: response.approvalsReviewer,
          sandboxPolicy: response.sandbox,
          activePermissionProfile: response.activePermissionProfile,
          runtimeWorkspaceRoots: [...response.runtimeWorkspaceRoots],
          pendingRequests: [],
          hasUnreadTurn: false,
        }),
      catch: (cause) => error("materialize", sourceThreadId, cause),
    });
    const withForkMarker = appendCodexCanonicalForkedFromConversationItem(boundedCanonical, {
      id: randomUUID(),
      type: "forkedFromConversation",
      sourceConversationId: sourceThreadId,
      sourceConversationTitle: sourceTitle,
    });
    const canonical = input.worktreeInit
      ? appendCodexCanonicalWorktreeInitItem(withForkMarker, input.worktreeInit, "new-turn")
      : withForkMarker;
    const observedAtMs = yield* Clock.currentTimeMillis;
    yield* projection
      .hydrate({
        threadId: child.summary.threadId,
        summary: child.summary,
        canonical,
        pagination: {
          olderCursor: null,
          backwardsCursor: null,
          oldestLoadedTurnId: null,
          isLoadingOlder: false,
          hasLoadedOldest: false,
          loadedTurnCount: 0,
          itemsView: "notLoaded",
        },
        observedAtMs,
      })
      .pipe(Effect.mapError((cause) => error("project", sourceThreadId, cause)));
    if (childTitle) {
      yield* titles
        .set({
          threadId: child.summary.threadId,
          name: childTitle,
          normalization: "manual",
        })
        .pipe(Effect.mapError((cause) => error("project", sourceThreadId, cause)));
    }
    const session = yield* catalog
      .ensureSession(child.summary.threadId)
      .pipe(Effect.mapError((cause) => error("session", sourceThreadId, cause)));
    if (!session?.thread || session.thread.threadId !== child.summary.threadId) {
      return yield* error(
        "session",
        sourceThreadId,
        new Error(`Forked Thread '${child.summary.threadId}' has no owning Session`),
      );
    }
    const accepted = yield* projection
      .read(child.summary.threadId)
      .pipe(Effect.mapError((cause) => error("project", sourceThreadId, cause)));
    if (!accepted.snapshot) {
      return yield* error(
        "project",
        sourceThreadId,
        new Error(`Forked Thread '${child.summary.threadId}' has no canonical projection`),
      );
    }
    const ownerClientId = input.ownerClientId?.trim() || null;
    if (ownerClientId) {
      const adoption = yield* rendererConversations
        .adoptRendererOwner({
          conversationId: child.summary.threadId,
          ownerClientId,
        })
        .pipe(Effect.mapError((cause) => error("adopt", sourceThreadId, cause)));
      if (adoption.ownerClientId !== ownerClientId) {
        return yield* error(
          "adopt",
          sourceThreadId,
          new Error(`Renderer client '${ownerClientId}' could not own the fork`),
        );
      }
    }
    yield* (
      input.pendingWorktreeId && input.target
        ? sidePanelTransfers.promotePending({
            pendingWorktreeId: input.pendingWorktreeId,
            targetConversationId: child.summary.threadId,
            targetWorkspaceRoot: input.target.cwd,
          })
        : sidePanelTransfers.stageDirect({
            sourceConversationId: sourceThreadId,
            targetConversationId: child.summary.threadId,
            ...(input.sourceSceneContext ? { sourceSceneContext: input.sourceSceneContext } : {}),
          })
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Forked Thread could not inherit side-panel state").pipe(
          Effect.annotateLogs({
            sourceThreadId,
            childThreadId: child.summary.threadId,
            cause: String(cause),
          }),
        ),
      ),
    );
    return {
      threadId: child.summary.threadId,
      session,
      conversation: accepted.snapshot,
      composerIntent: { prompt: "", focusNonce: observedAtMs },
    };
  });

  return CodexConversationFork.of({
    fork: (input) =>
      Effect.gen(function* () {
        const sourceThreadId = input.sourceThreadId.trim();
        if (!sourceThreadId) {
          return yield* error("admit", input.sourceThreadId, new Error("Fork source is required"));
        }
        const durable = yield* directory
          .resolve({ threadId: sourceThreadId, fidelity: "durable" })
          .pipe(Effect.mapError((cause) => error("admit", sourceThreadId, cause)));
        if (!durable) {
          return yield* error(
            "admit",
            sourceThreadId,
            new Error(`Thread '${sourceThreadId}' was not found`),
          );
        }
        return yield* threadStarts.materialize(
          durable.durable.executionHostId,
          conversations.runCommand(sourceThreadId, forkPhysical(input)),
          (result) => result.threadId,
        );
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof CodexConversationForkError
            ? cause
            : error("fork", input.sourceThreadId, cause),
        ),
        Effect.withSpan("CodexConversationFork.fork", {
          attributes: { sourceThreadId: input.sourceThreadId },
        }),
      ),
  });
});
