import { CodexMainConversationResume } from "./CodexMainConversationResume";
import * as Semaphore from "effect/Semaphore";
import type {
  CodexNativeForkPreparation,
  CodexNativeForkAcceptance,
} from "../../shared/codex-native-fork";
import type * as Scope from "effect/Scope";
import { randomUUID } from "node:crypto";
import type { ThreadForkParams } from "@nodex/codex-app-server-protocol/v2/ThreadForkParams";
import type { ThreadForkResponse } from "@nodex/codex-app-server-protocol/v2/ThreadForkResponse";
import type { ClientRequestParamsByMethod } from "@nodex/effect-codex-app-server/rpc";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import {
  mutateCodexCanonicalForkedFromConversationItem,
  mutateCodexCanonicalWorktreeInitItem,
  type CodexCanonicalWorktreeInitItem,
} from "../../shared/codex-conversation-state/codex-conversation-state";
import type { CodexForkBrowserSceneContext } from "../../shared/codex-fork-browser-transfer";
import type {
  CodexComposerIntent,
  CodexConversationSnapshot,
  ProjectSession,
} from "../../shared/types";
import { buildCodexThreadConfig } from "../codex/codex-thread-config";
import { DesktopToolRuntime } from "../host-runtime/DesktopToolRuntime";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway, codexGatewayGenerationFence } from "../codex-runtime/CodexGateway";
import { CoreModules } from "../core-runtime/CoreModules";
import { CodexForkSidePanelTransfer } from "./CodexForkSidePanelTransferRuntime";
import { CodexForkTitlePolicy } from "./CodexForkTitlePolicy";
import { CodexThreadCatalog } from "./CodexThreadCatalog";
import { CodexThreadDirectory, type CodexThreadDirectoryEntry } from "./CodexThreadDirectory";
import { ThreadCreationRuntime } from "./ThreadCreationRuntime";
import { CodexThreadTitlePersistence } from "./CodexThreadTitlePersistence";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

type GatewayThreadForkParams = ClientRequestParamsByMethod["thread/fork"];

export interface CodexConversationForkInput {
  readonly sourceThreadId: string;
  /** An already reserved destination Session; ordinary UI forks create one on acceptance. */
  readonly destinationSessionId?: string;
  readonly lastTurnId?: string | null;
  readonly threadSource: NonNullable<ThreadForkParams["threadSource"]>;
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
    readonly prepareRenderer: (
      input: CodexConversationForkInput,
    ) => Effect.Effect<CodexNativeForkPreparation, CodexConversationForkError>;
    readonly executeRenderer: (
      receiptId: string,
    ) => Effect.Effect<ThreadForkResponse, CodexConversationForkError>;
    readonly acceptRenderer: (
      receiptId: string,
    ) => Effect.Effect<CodexNativeForkAcceptance, CodexConversationForkError>;
    readonly releaseRenderer: (receiptId: string) => Effect.Effect<void>;
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
  | CodexAppServerCapabilities
  | CodexMainConversationResume
  | CodexForkSidePanelTransfer
  | CodexForkTitlePolicy
  | CodexGateway
  | DesktopToolRuntime
  | CodexThreadCatalog
  | CodexThreadDirectory
  | ThreadCreationRuntime
  | CodexThreadTitlePersistence
  | ConversationEntityMap
  | CoreModules
  | Scope.Scope
> = Effect.gen(function* () {
  const core = yield* CoreModules;
  const mainResume = yield* CodexMainConversationResume;
  const capabilities = yield* CodexAppServerCapabilities;
  const gateway = yield* CodexGateway;
  const desktopTools = yield* DesktopToolRuntime;
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

  const prepareFork = Effect.fn("CodexConversationFork.prepare")(function* (
    input: CodexConversationForkInput,
    source: CodexThreadDirectoryEntry,
    capability: CodexAppServerCapabilitySnapshot,
  ) {
    const sourceThreadId = input.sourceThreadId.trim();
    const requestedLastTurnId = input.lastTurnId;
    const lastTurnId = requestedLastTurnId == null ? null : requestedLastTurnId.trim();
    if (!sourceThreadId) {
      return yield* error("admit", input.sourceThreadId, new Error("Fork source is required"));
    }
    if (requestedLastTurnId != null && !lastTurnId) {
      return yield* error("admit", sourceThreadId, new Error("Fork turn is required"));
    }
    if (source.historyMode === "paginated" && !capability.flags.paginatedFork) {
      return yield* error(
        "admit",
        sourceThreadId,
        new Error("Forking is not available for threads using paginated history yet."),
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
    const desktopToolConfig =
      capability.hostId === gateway.localHostId
        ? yield* desktopTools
            .threadConfig(input.target?.cwd ?? source.durable.cwd)
            .pipe(Effect.mapError((cause) => error("fork", sourceThreadId, cause)))
        : null;
    const config = buildCodexThreadConfig({
      nativeAppTools: capability.nativeAppTools,
      overrides: desktopToolConfig,
    });
    const request = {
      threadId: sourceThreadId,
      ...(lastTurnId ? { lastTurnId } : {}),
      path: null,
      cwd: input.target?.cwd ?? source.durable.cwd,
      runtimeWorkspaceRoots: [
        ...(input.target?.runtimeWorkspaceRoots ?? execution.value.context.thread.writable_roots),
      ],
      threadSource: input.threadSource,
      excludeTurns: true,
      ...(Object.keys(config).length > 0 ? { config } : {}),
    } satisfies ThreadForkParams;
    if (!(yield* capabilities.isCurrent(capability).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* error(
        "fork",
        sourceThreadId,
        new Error("Codex app-server generation changed before persistent fork dispatch"),
      );
    }
    const currentSource = yield* core.workspace
      .read({ kind: "thread", thread_id: sourceThreadId })
      .pipe(Effect.mapError((cause) => error("fork", sourceThreadId, cause)));
    if (
      currentSource.value.kind !== "thread" ||
      currentSource.value.thread.execution_host_id !== capability.hostId ||
      currentSource.value.thread.execution_host_id !== source.durable.executionHostId
    ) {
      return yield* error(
        "fork",
        sourceThreadId,
        new Error("Fork source execution host changed before persistent fork dispatch"),
      );
    }
    return { request, sourceTitle, childTitle, sourceThreadId };
  });

  const forkPhysical = Effect.fn("CodexConversationFork.forkPhysical")(function* (
    input: CodexConversationForkInput,
    source: CodexThreadDirectoryEntry,
    capability: CodexAppServerCapabilitySnapshot,
  ): Effect.fn.Return<CodexConversationForkResult, CodexConversationForkError> {
    const { request, sourceTitle, childTitle, sourceThreadId } = yield* prepareFork(
      input,
      source,
      capability,
    );
    const response = (yield* gateway
      .requestOnHost(
        source.durable.executionHostId,
        "thread/fork",
        request as GatewayThreadForkParams,
        {
          conversationId: sourceThreadId,
          priority: "interactive",
          source: "thread_fork",
          ...codexGatewayGenerationFence(capability),
        },
      )
      .pipe(
        Effect.mapError((cause) => error("fork", sourceThreadId, cause)),
      )) as unknown as ThreadForkResponse;
    if (!(yield* capabilities.isCurrent(capability).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* error(
        "fork",
        sourceThreadId,
        new Error("Codex app-server generation changed while forking the Thread"),
      );
    }
    const child = yield* directory
      .acceptForkResult({
        sourceThreadId,
        durableOnly: true,
        response,
        ...(input.destinationSessionId ? { destinationSessionId: input.destinationSessionId } : {}),
        ...(input.target ? { target: input.target } : {}),
      })
      .pipe(Effect.mapError((cause) => error("materialize", sourceThreadId, cause)));
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
    const resumed = yield* mainResume
      .resume(child.summary.threadId)
      .pipe(Effect.mapError((cause) => error("adopt", sourceThreadId, cause)));
    if (resumed.status !== "ready" || !resumed.snapshot)
      return yield* error(
        "adopt",
        sourceThreadId,
        new Error("Forked conversation could not resume"),
      );
    const observedAtMs = yield* Clock.currentTimeMillis;
    if (childTitle) {
      yield* titles
        .set({
          threadId: child.summary.threadId,
          name: childTitle,
          normalization: "manual",
        })
        .pipe(Effect.mapError((cause) => error("project", sourceThreadId, cause)));
    }
    const entity = conversations.entity(child.summary.threadId);
    entity.mutateCanonicalState((draft) => {
      mutateCodexCanonicalForkedFromConversationItem(draft, {
        id: randomUUID(),
        type: "forkedFromConversation",
        sourceConversationId: sourceThreadId,
        sourceConversationTitle: sourceTitle,
      });
      if (input.worktreeInit)
        mutateCodexCanonicalWorktreeInitItem(draft, input.worktreeInit, "new-turn");
    }, observedAtMs);
    const accepted = entity.readSnapshot();
    if (!accepted)
      return yield* error(
        "project",
        sourceThreadId,
        new Error("Forked conversation is unavailable"),
      );
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
      conversation: accepted,
      composerIntent: { prompt: "", focusNonce: observedAtMs },
    };
  });

  type Prepared = {
    input: CodexConversationForkInput;
    source: CodexThreadDirectoryEntry;
    capability: CodexAppServerCapabilitySnapshot;
    prepared: Effect.Success<ReturnType<typeof prepareFork>>;
    admission: ReturnType<typeof threadStarts.open>;
    dispatched: boolean;
    response?: ThreadForkResponse;
    accepted?: CodexNativeForkAcceptance;
    acceptLock: Semaphore.Semaphore;
  };
  const rendererForks = new Map<string, Prepared>();
  const releaseRenderer = (id: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      const receipt = rendererForks.get(id);
      if (!receipt) return Effect.void;
      rendererForks.delete(id);
      return receipt.admission.close(receipt.response?.thread.id);
    });
  yield* Effect.addFinalizer(() =>
    Effect.forEach([...rendererForks.keys()], releaseRenderer, { discard: true }),
  );
  const requireRenderer = (id: string) =>
    Effect.gen(function* () {
      const receipt = rendererForks.get(id);
      if (!receipt) return yield* error("admit", id, new Error("Fork preparation expired"));
      if (
        !(yield* capabilities.isCurrent(receipt.capability).pipe(Effect.orElseSucceed(() => false)))
      )
        return yield* error(
          "admit",
          receipt.source.summary.threadId,
          new Error("Fork native generation retired"),
        );
      return receipt;
    });

  return CodexConversationFork.of({
    prepareRenderer: (input) =>
      Effect.gen(function* () {
        const source = yield* directory
          .resolve({ threadId: input.sourceThreadId, fidelity: "metadata" })
          .pipe(Effect.mapError((cause) => error("admit", input.sourceThreadId, cause)));
        if (!source)
          return yield* error("admit", input.sourceThreadId, new Error("Fork source unavailable"));
        const capability = yield* capabilities
          .forHost(source.durable.executionHostId)
          .pipe(Effect.mapError((cause) => error("admit", input.sourceThreadId, cause)));
        const prepared = yield* prepareFork(input, source, capability);
        const receiptId = randomUUID();
        const acceptLock = yield* Semaphore.make(1);
        rendererForks.set(receiptId, {
          input,
          source,
          capability,
          prepared,
          admission: threadStarts.open(capability.hostId, capability.generation),
          dispatched: false,
          acceptLock,
        });
        return {
          receiptId,
          hostId: capability.hostId,
          generation: capability.generation,
          request: prepared.request,
          sourceTitle: prepared.sourceTitle,
        };
      }),
    executeRenderer: (id) =>
      Effect.gen(function* () {
        const receipt = yield* requireRenderer(id);
        if (receipt.dispatched)
          return yield* error(
            "fork",
            receipt.source.summary.threadId,
            new Error("Fork preparation has already been dispatched"),
          );
        receipt.dispatched = true;
        const response = (yield* gateway
          .requestOnHost(
            receipt.capability.hostId,
            "thread/fork",
            receipt.prepared.request as GatewayThreadForkParams,
            {
              conversationId: receipt.source.summary.threadId,
              priority: "interactive",
              source: "thread_hydration",
              ...codexGatewayGenerationFence(receipt.capability),
            },
          )
          .pipe(
            Effect.mapError((cause) => error("fork", receipt.source.summary.threadId, cause)),
          )) as unknown as ThreadForkResponse;
        yield* requireRenderer(id);
        receipt.response = response;
        return response;
      }),
    acceptRenderer: (id) =>
      requireRenderer(id).pipe(
        Effect.flatMap((admitted) =>
          admitted.acceptLock.withPermit(
            Effect.gen(function* () {
              const receipt = yield* requireRenderer(id);
              if (receipt.accepted) return receipt.accepted;
              const response = receipt.response;
              if (!response)
                return yield* error(
                  "materialize",
                  receipt.source.summary.threadId,
                  new Error("Fork native response has not arrived"),
                );
              const child = yield* directory
                .acceptForkResult({
                  sourceThreadId: receipt.source.summary.threadId,
                  response,
                  durableOnly: true,
                  ...(receipt.input.destinationSessionId
                    ? { destinationSessionId: receipt.input.destinationSessionId }
                    : {}),
                  ...(receipt.input.target ? { target: receipt.input.target } : {}),
                })
                .pipe(
                  Effect.mapError((cause) =>
                    error("materialize", receipt.source.summary.threadId, cause),
                  ),
                );
              const session = yield* catalog
                .ensureSession(child.summary.threadId)
                .pipe(Effect.mapError((cause) => error("session", child.summary.threadId, cause)));
              if (!session)
                return yield* error(
                  "session",
                  child.summary.threadId,
                  new Error("Fork Session unavailable"),
                );
              yield* sidePanelTransfers
                .stageDirect({
                  sourceConversationId: receipt.source.summary.threadId,
                  targetConversationId: child.summary.threadId,
                  ...(receipt.input.sourceSceneContext
                    ? { sourceSceneContext: receipt.input.sourceSceneContext }
                    : {}),
                })
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Fork side panel transfer failed").pipe(
                      Effect.annotateLogs({ cause: String(cause) }),
                    ),
                  ),
                );
              const accepted: CodexNativeForkAcceptance = {
                threadId: child.summary.threadId,
                summary: child.summary,
                session,
                composerIntent: { prompt: "", focusNonce: yield* Clock.currentTimeMillis },
              };
              receipt.accepted = accepted;
              yield* receipt.admission.close(child.summary.threadId);
              return accepted;
            }),
          ),
        ),
      ),

    releaseRenderer,

    fork: (input) =>
      Effect.gen(function* () {
        const sourceThreadId = input.sourceThreadId.trim();
        if (!sourceThreadId) {
          return yield* error("admit", input.sourceThreadId, new Error("Fork source is required"));
        }
        const source = yield* directory
          .resolve({ threadId: sourceThreadId, fidelity: "metadata" })
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
        return yield* threadStarts.materialize(
          source.durable.executionHostId,
          capability.generation,
          conversations.runCommand(sourceThreadId, forkPhysical(input, source, capability)),
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
