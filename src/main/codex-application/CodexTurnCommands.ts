import type {
  CodexInspectedTurnStart,
  CodexTurnStartRejection,
} from "../../shared/codex-conversation-state/codex-turn-execution";
import {
  clearCodexUnconfirmedTurnSubmission,
  recordCodexUnconfirmedTurnSubmission,
  type CodexTurnDelivery,
} from "../../shared/codex-conversation-state/codex-turn-delivery";
import { encodeCodexNativeRequestFailure } from "../../shared/codex-native-request-outcome";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
import { latestConversationTurn } from "../../shared/codex-conversation-state/codex-turn-selectors";
import { isAppContextJson, prepareUntrustedAppInput } from "../../shared/codex-untrusted-app-input";
import {
  queuedMessagePromptInput,
  type CodexQueuedMessage,
  type CodexQueuedNativePreparationContext,
} from "../../shared/codex-queued-message";
import {
  canonicalPermissionsForMode,
  nativePermissionRequestFields,
  type CanonicalPermissionConfig,
} from "../../shared/codex-conversation-state/codex-native-permissions";
import { materializeCodexPermissionSelection } from "../../shared/codex-permission-selection";
import type { ConversationFollowerTurnStart } from "../../shared/codex-thread-follower-request";
import type {
  CanonicalOwnerSteerInput,
  CanonicalSteerNativeRequest,
} from "../../shared/codex-conversation-state/codex-owner-steer";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  TurnStartParams,
  TurnStartResponse,
  TurnSteerResponse,
} from "@nodex/codex-app-server-protocol/v2";
import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import { CLIENT_REQUEST_RESPONSES } from "@nodex/effect-codex-app-server/rpc";
import type { ClientRequestParamsByMethod } from "@nodex/effect-codex-app-server/rpc";
import { createEmptyCodexPreparedPrompt } from "../../shared/codex-prompt-preparation";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import type {
  CodexCanonicalWorktreeInitItem,
  CodexPreparedPrompt,
  CodexPromptTextAttachmentInput,
  CodexSteerTurnInput,
  CodexSteerTurnResult,
  CodexTurnStartOptions,
  CodexTurnSummary,
} from "../../shared/types";
import { createUuidV7 } from "../../shared/uuid-v7";
import {
  CodexGateway,
  CodexThreadHostResolver,
  type CodexGatewayRequestOptions,
} from "../codex-runtime/CodexGateway";
import {
  CodexMainConversationManagers,
  type MainConversationManager,
} from "./CodexMainConversationManagers";
import type { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { CoreModules } from "../core-runtime/CoreModules";
import { ProjectRuntimeLifecycleRuntime } from "../host-runtime/ProjectRuntimeLifecycleRuntime";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { CodexAutomationRunAcceptance } from "./CodexAutomationRunAcceptance";
import { CodexConversationMaterialization } from "./CodexConversationMaterialization";
import { CodexMainConversationResume } from "./CodexMainConversationResume";
import { CodexConversationProjection } from "./CodexConversationProjection";
import { CodexAutoThreadTitle } from "./CodexAutoThreadTitle";
import { CodexTurnAuthority, type CodexTurnAuthorityLaunch } from "./CodexTurnAuthority";
import {
  CodexTurnPresentation,
  type CodexTurnPresentationClaim,
  type CodexTurnPresentationLaunch,
} from "./CodexTurnPresentation";
import { CodexTurnPreparation, type CodexTurnStartPlan } from "./CodexTurnPreparation";
import { CodexMainConversationSettings } from "./CodexMainConversationSettings";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

type GatewayTurnStartParams = ClientRequestParamsByMethod["turn/start"];
type GatewayTurnSteerParams = ClientRequestParamsByMethod["turn/steer"];

/** A Turn keeps its admitted native generation even when its manager reconnects. */
interface NativeTurnConnection {
  readonly manager: MainConversationManager;
  readonly nativeGeneration: number;
}

const captureTurnConnection = (manager: MainConversationManager): NativeTurnConnection => ({
  manager,
  nativeGeneration: manager.generation,
});
const assertTurnConnection = ({ manager, nativeGeneration }: NativeTurnConnection): void =>
  manager.assertCurrent(nativeGeneration);
const turnConnectionFence = ({ manager, nativeGeneration }: NativeTurnConnection) => ({
  expectedHostId: manager.hostId,
  expectedGeneration: nativeGeneration,
});

export type CodexTurnStartOverrides = CodexTurnStartOptions & {
  /**
   * Binds the first Turn to the exact live native Thread returned by `thread/start`.
   * This lets Main adopt that fresh Thread without replaying it through `thread/resume`.
   */
  readonly freshNativeThread?: {
    readonly hostId: string;
    readonly generation: number;
  };
  readonly presentationClaim?: CodexTurnPresentationClaim;
  readonly agentConfigPermissionMode?: boolean;
  readonly clientUserMessageId?: string;
  readonly preparedPrompt?: CodexPreparedPrompt;
  readonly responsesapiClientMetadata?: TurnStartParams["responsesapiClientMetadata"];
  readonly autoTitlePastedTextAttachments?: readonly CodexPromptTextAttachmentInput[];
  readonly skipAutoTitleGeneration?: boolean;
  readonly worktreeInit?: CodexCanonicalWorktreeInitItem;
};

export class CodexTurnCommandError extends Schema.TaggedError<CodexTurnCommandError>()(
  "CodexTurnCommandError",
  {
    operation: Schema.Literals(["start", "steer"]),
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export type CodexTurnCommandsError = CodexRuntimeError | CodexTurnCommandError;

export interface CodexTurnCommandsService {
  readonly prepareNativeToolMessage: (
    threadId: string,
    sourceThreadId: string,
    prompt: string,
    mode: "start" | "steer",
    overrides?: CodexTurnStartOverrides,
  ) => Effect.Effect<
    { start?: ConversationFollowerTurnStart; steer: CanonicalOwnerSteerInput },
    CodexTurnCommandsError
  >;
  readonly injectPreparedNativeStart: (
    operation: ConversationFollowerTurnStart,
    executingPeerClientId?: string,
  ) => Effect.Effect<void, CodexTurnCommandsError>;
  readonly prepareNativeQueuedMessage: (
    threadId: string,
    message: CodexQueuedMessage,
    mode: "start" | "steer",
    preparationContext: CodexQueuedNativePreparationContext,
  ) => Effect.Effect<
    {
      start?: ConversationFollowerTurnStart;
      steer: CanonicalOwnerSteerInput;
      requiresIdle: boolean;
    },
    CodexTurnCommandsError
  >;
  readonly prepareNativeStart: (
    threadId: string,
    prompt: string,
    overrides?: CodexTurnStartOverrides,
    originalRequest?: TurnStartParams,
    sourceContext?: ConversationFollowerTurnStart["context"],
  ) => Effect.Effect<ConversationFollowerTurnStart, CodexTurnCommandsError>;
  readonly inspectPreparedNativeStart: (
    operation: ConversationFollowerTurnStart,
    executingPeerClientId?: string,
  ) => Effect.Effect<CodexInspectedTurnStart, CodexTurnCommandsError>;
  readonly executePreparedNativeStart: (
    request: TurnStartParams,
    executingPeerClientId?: string,
  ) => Effect.Effect<TurnStartResponse, CodexTurnCommandsError>;
  readonly releasePreparedNativeStart: (clientUserMessageId: string) => void;
  readonly start: (
    threadId: string,
    prompt: string,
    overrides?: CodexTurnStartOverrides,
  ) => Effect.Effect<CodexTurnSummary | null, CodexTurnCommandsError>;
  /** Starts the first autonomous Automation Turn without marking the Run as user-accepted. */
  readonly startAutomation: (
    threadId: string,
    prompt: string,
    overrides?: CodexTurnStartOverrides,
  ) => Effect.Effect<CodexTurnSummary | null, CodexTurnCommandsError>;
  readonly prepareNativeSteer: (
    input: CodexSteerTurnInput,
  ) => Effect.Effect<CanonicalOwnerSteerInput, CodexTurnCommandsError>;
  readonly inspectPreparedNativeSteer: (
    clientUserMessageId: string,
  ) => Effect.Effect<CanonicalOwnerSteerInput, CodexTurnCommandsError>;
  readonly executePreparedNativeSteer: (
    request: CanonicalSteerNativeRequest,
    clientUserMessageId: string,
    executingPeerClientId?: string,
    requestOptions?: Pick<CodexGatewayRequestOptions, "timeoutMs" | "onOutcomeUnknown">,
  ) => Effect.Effect<TurnSteerResponse, CodexTurnCommandsError>;
  readonly releasePreparedNativeSteer: (clientUserMessageId: string) => void;
  readonly steer: (
    input: CodexSteerTurnInput,
  ) => Effect.Effect<CodexSteerTurnResult | null, CodexTurnCommandsError>;
}

export class CodexTurnCommands extends Context.Service<
  CodexTurnCommands,
  CodexTurnCommandsService
>()("nodex/main/codex-application/CodexTurnCommands") {}

const isThreadNotFound = (error: unknown): boolean => {
  if (error instanceof CodexTurnCommandError) return isThreadNotFound(error.cause);
  if (!(typeof error === "object" && error !== null && "_tag" in error)) return false;
  if ((error as { readonly _tag: string })._tag !== "CodexRuntimeError") return false;
  const cause = (error as CodexRuntimeError).cause;
  if (!(cause instanceof CodexAppServerRequestError)) return false;
  const message = cause.message.toLowerCase();
  return (
    !message.includes("method not found") &&
    (message.includes("thread not found") ||
      (message.includes("thread") && message.includes("not found")))
  );
};

export const make: Effect.Effect<
  CodexTurnCommandsService,
  never,
  | CodexConversationProjection
  | CodexConversationMaterialization
  | CodexMainConversationResume
  | CodexAutoThreadTitle
  | CodexAutomationRunAcceptance
  | CodexGateway
  | CodexAppServerCapabilities
  | CodexTurnAuthority
  | CodexTurnPresentation
  | CodexTurnPreparation
  | CodexMainConversationSettings
  | CodexMainConversationManagers
  | CodexThreadHostResolver
  | ConversationEntityMap
  | CoreModules
  | ProjectWorkspace
  | ProjectRuntimeLifecycleRuntime
  | Scope.Scope
> = Effect.gen(function* () {
  const conversations = yield* ConversationEntityMap;
  const gateway = yield* CodexGateway;
  const capabilities = yield* CodexAppServerCapabilities;
  const hosts = yield* CodexThreadHostResolver;
  const managers = yield* CodexMainConversationManagers;
  const nativePreparations = new Map<
    string,
    NativeTurnConnection & {
      original: TurnStartParams;
      context: ConversationFollowerTurnStart["context"];
      prompt: string;
      overrides: CodexTurnStartOverrides;
      plan: CodexTurnStartPlan | null;
      ownerId: string | null | undefined;
      injection: "pending" | "in-flight" | "complete";
      acceptAutomationRun: boolean;
      callerOwnsPresentation: boolean;
      lock: Semaphore.Semaphore;
      disposal: Disposable;
    }
  >();
  const projectLifecycle = yield* ProjectRuntimeLifecycleRuntime;
  const automationRuns = yield* CodexAutomationRunAcceptance;
  const materialization = yield* CodexConversationMaterialization;
  const resume = yield* CodexMainConversationResume;
  const autoTitle = yield* CodexAutoThreadTitle;
  const projection = yield* CodexConversationProjection;
  const preparation = yield* CodexTurnPreparation;
  const ownerSettings = yield* CodexMainConversationSettings;
  const authority = yield* CodexTurnAuthority;
  const presentation = yield* CodexTurnPresentation;
  const core = yield* CoreModules;
  const workspace = yield* ProjectWorkspace;

  const commandError = (
    operation: "start" | "steer",
    threadId: string,
    cause: unknown,
  ): CodexTurnCommandError =>
    cause instanceof CodexTurnCommandError
      ? cause
      : new CodexTurnCommandError({ operation, threadId, cause });

  const assertTurnOwner = (
    connection: NativeTurnConnection,
    threadId: string,
    executingPeerClientId?: string,
  ) => {
    assertTurnConnection(connection);
    const { manager } = connection;
    const role = manager.stream.getRole(threadId);
    if (
      executingPeerClientId
        ? role?.role !== "follower" || role.ownerClientId !== executingPeerClientId
        : role?.role !== "owner"
    )
      throw new Error("Turn owner changed before native execution");
  };

  const assertProjectActive = (plan: CodexTurnStartPlan) => {
    if (!plan.projectId) return Effect.void;
    return core.workspace
      .read({ kind: "project", project_id: plan.projectId }, undefined, plan.projectId)
      .pipe(
        Effect.flatMap((snapshot) => {
          if (snapshot.value.kind !== "project" || snapshot.value.project.lifecycle !== "active") {
            return Effect.fail(
              commandError(
                "start",
                plan.threadId,
                new Error("Codex turns cannot start for an inactive or removed Project"),
              ),
            );
          }
          return Effect.void;
        }),
        Effect.mapError((cause) => commandError("start", plan.threadId, cause)),
      );
  };

  const synchronizeAcceptedWorkspace = (plan: CodexTurnStartPlan, turnId: string) =>
    Effect.gen(function* () {
      const { writableRoots, revision, hadWorkspaceState } = plan.workspaceCommit;
      yield* (
        writableRoots?.kind === "replace"
          ? workspace
              .replaceThreadWritableRoots(plan.threadId, writableRoots.roots)
              .pipe(
                Effect.andThen(
                  revision !== null && plan.pendingWorkspace !== null
                    ? workspace.commitThreadWorkspaceTransition(
                        plan.threadId,
                        revision,
                        plan.pendingWorkspace,
                      )
                    : Effect.void,
                ),
              )
          : writableRoots?.kind === "merge"
            ? workspace.mergeThreadWritableRoots(plan.threadId, writableRoots.roots)
            : Effect.void
      ).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Accepted Turn workspace synchronization failed").pipe(
            Effect.annotateLogs({ threadId: plan.threadId, turnId, cause: String(cause) }),
          ),
        ),
      );

      if (plan.rendererOwnsState) return;
      const context = yield* workspace
        .readThreadExecutionContext(plan.threadId)
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Accepted Turn workspace state could not be refreshed").pipe(
              Effect.annotateLogs({ threadId: plan.threadId, turnId, cause: String(cause) }),
              Effect.as(null),
            ),
          ),
        );
      const acceptedWorkspace = plan.pendingWorkspace ?? context?.workspaceState?.applied ?? null;
      if (!acceptedWorkspace) return;
      const observedAtMs = yield* Clock.currentTimeMillis;
      conversations.current(plan.threadId)?.mutateCanonicalState((draft) => {
        if (context?.workspaceState) {
          draft.workspaceKind = plan.workspaceKind;
        } else if (!hadWorkspaceState) {
          draft.workspaceKind = "project";
        }
        draft.workspaceBrowserRoot = null;
        draft.cwd = acceptedWorkspace.cwd;
      }, observedAtMs);
    });

  const rollbackStart = (
    plan: CodexTurnStartPlan,
    state: {
      readonly launch: CodexTurnAuthorityLaunch | null;
      readonly presentationLaunch: CodexTurnPresentationLaunch | null;
      readonly requestDispatched: boolean;
      readonly requestRejected: boolean;
      readonly optimisticAdmitted: boolean;
      readonly protocolCommitted: boolean;
      readonly previousRuntimeStatus: CodexTurnStartRejection["restoreRuntimeStatus"];
      readonly admittedRuntimeStatus: CodexTurnStartRejection["restoreRuntimeStatus"];
      readonly failure: unknown;
      readonly terminalUnknown: boolean;
    },
    assertCurrentOwner: () => void,
  ) =>
    Effect.gen(function* () {
      if (state.protocolCommitted) return;
      if (!state.requestDispatched || state.requestRejected) {
        authority.abort(state.launch);
        presentation.abort(state.presentationLaunch);
      }
      if (!state.optimisticAdmitted) return;
      if (state.requestDispatched && !state.requestRejected) return;
      const observedAtMs = yield* Clock.currentTimeMillis;
      const current = yield* Effect.try(assertCurrentOwner).pipe(Effect.result);
      if (current._tag === "Failure") return;
      yield* projection.rejectTurn({
        threadId: plan.threadId,
        clientUserMessageId: plan.clientUserMessageId,
        failureItemId: randomUUID(),
        observedAtMs,
        previousPermissions: plan.previousPermissions,
        message: encodeCodexNativeRequestFailure(state.failure).message,
        retainTurn: state.terminalUnknown,
        restoreRuntimeStatus:
          conversations.current(plan.threadId)?.readCanonicalState()?.threadRuntimeStatus ===
          state.admittedRuntimeStatus
            ? state.previousRuntimeStatus
            : undefined,
      });
    });

  const startTransaction = (
    plan: CodexTurnStartPlan,
    options: {
      readonly connection: NativeTurnConnection;
      readonly acceptAutomationRun: boolean;
      readonly returnNativeResponse?: boolean;
      readonly assertCurrentOwner: () => void;
      readonly responseItems?: ClientRequestParamsByMethod["thread/inject_items"]["items"];
    },
  ) =>
    projectLifecycle.runExclusive(
      plan.projectId,
      Effect.gen(function* () {
        yield* assertProjectActive(plan);
        yield* Effect.try(options.assertCurrentOwner);
        const current = conversations.current(plan.threadId)?.readCanonicalState();
        if (
          options.responseItems?.length &&
          (latestConversationTurn(current)?.status === "inProgress" ||
            current?.threadRuntimeStatus.type === "active")
        )
          return yield* commandError(
            "start",
            plan.threadId,
            new Error("App context must wait until the current turn finishes"),
          );
        const canonicalParams = plan.canonicalParams;
        if (!plan.rendererOwnsState && !canonicalParams) {
          return yield* commandError(
            "start",
            plan.threadId,
            new Error("Main-owned Turn requires a hydrated canonical conversation"),
          );
        }

        const transaction: {
          launch: CodexTurnAuthorityLaunch | null;
          presentationLaunch: CodexTurnPresentationLaunch | null;
          requestDispatched: boolean;
          requestRejected: boolean;
          optimisticAdmitted: boolean;
          protocolCommitted: boolean;
          previousRuntimeStatus: CodexTurnStartRejection["restoreRuntimeStatus"];
          admittedRuntimeStatus: CodexTurnStartRejection["restoreRuntimeStatus"];
          failure: unknown;
          terminalUnknown: boolean;
        } = {
          launch: null,
          presentationLaunch: null,
          requestDispatched: false,
          requestRejected: false,
          optimisticAdmitted: false,
          protocolCommitted: false,
          previousRuntimeStatus: undefined,
          admittedRuntimeStatus: undefined,
          failure: undefined,
          terminalUnknown: false,
        };
        let pendingRequestId: CodexTurnDelivery["requestId"] | null = null;
        const onOutcomeUnknown = (delivery: CodexTurnDelivery) =>
          Effect.gen(function* () {
            yield* Effect.try(options.assertCurrentOwner).pipe(Effect.orDie);
            pendingRequestId = delivery.requestId;
            if (plan.rendererOwnsState) return;
            const observedAtMs = yield* Clock.currentTimeMillis;
            conversations.current(plan.threadId)?.mutateCanonicalState((draft) => {
              recordCodexUnconfirmedTurnSubmission(draft, delivery, plan.clientUserMessageId);
            }, observedAtMs);
          });
        const confirmDelivery = Effect.gen(function* () {
          yield* Effect.try(options.assertCurrentOwner);
          if (pendingRequestId === null || plan.rendererOwnsState) return;
          const observedAtMs = yield* Clock.currentTimeMillis;
          conversations.current(plan.threadId)?.mutateCanonicalState((draft) => {
            clearCodexUnconfirmedTurnSubmission(draft, pendingRequestId);
          }, observedAtMs);
          pendingRequestId = null;
        });

        return yield* Effect.gen(function* () {
          transaction.launch = yield* authority.begin(
            plan.threadId,
            plan.verifiedBuiltinFullAccess,
            plan.executionReadOnly,
          );
          transaction.presentationLaunch = yield* presentation.begin(
            plan.presentationClaim,
            plan.threadId,
            plan.clientUserMessageId,
          );
          yield* Effect.try(options.assertCurrentOwner);
          if (!plan.rendererOwnsState && canonicalParams) {
            transaction.previousRuntimeStatus = conversations
              .current(plan.threadId)
              ?.readCanonicalState()?.threadRuntimeStatus;
            yield* projection.admitTurn({
              execution: plan,
              threadId: plan.threadId,
              params: canonicalParams,
              localMetadata: plan.localMetadata,
              mcpAppModelContextAttachments: plan.mcpAppModelContextAttachments,
              startedAtMs: plan.startedAtMs,
              ...(plan.worktreeInit ? { worktreeInit: plan.worktreeInit } : {}),
            });
            transaction.optimisticAdmitted = true;
            transaction.admittedRuntimeStatus =
              transaction.previousRuntimeStatus?.type !== "active"
                ? conversations.current(plan.threadId)?.readCanonicalState()?.threadRuntimeStatus
                : undefined;
          }

          yield* Effect.try(options.assertCurrentOwner);
          if (
            conversations.current(plan.threadId)?.readCanonicalState()?.unconfirmedTurnSubmissions
              ?.length
          )
            return yield* commandError(
              "start",
              plan.threadId,
              new Error("An earlier turn submission is not yet confirmed"),
            );
          transaction.requestDispatched = true;
          if (options.responseItems?.length) {
            yield* gateway.requestForThread(
              plan.threadId,
              "thread/inject_items",
              {
                threadId: plan.threadId,
                items: options.responseItems,
              },
              {
                ...turnConnectionFence(options.connection),
                priority: "critical",
                timeoutMs: 30_000,
                onOutcomeUnknown,
              },
            );
            yield* confirmDelivery;
          }
          yield* Effect.try(options.assertCurrentOwner);
          const environmentSelectionEvidence = conversations
            .current(plan.threadId)
            ?.readCanonicalState()?.environmentSelectionEvidence;
          const response = (yield* gateway
            .requestForThread(plan.threadId, "turn/start", plan.request as GatewayTurnStartParams, {
              ...turnConnectionFence(options.connection),
              priority: "critical",
              timeoutMs: 30_000,
              onOutcomeUnknown,
            })
            .pipe(
              Effect.tapError((error) =>
                Effect.sync(() => {
                  transaction.requestRejected = error.reason !== "outcome-unknown";
                }),
              ),
            )) as unknown as TurnStartResponse;

          yield* Effect.uninterruptible(
            Effect.try(options.assertCurrentOwner).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  transaction.protocolCommitted = true;
                }),
              ),
              Effect.andThen(
                presentation.bind(transaction.presentationLaunch, response.turn.id).pipe(
                  Effect.catch((cause) =>
                    Effect.logError("Accepted Turn presentation could not be bound").pipe(
                      Effect.annotateLogs({
                        threadId: plan.threadId,
                        turnId: response.turn.id,
                        cause,
                      }),
                    ),
                  ),
                ),
              ),
              Effect.andThen(
                authority.bind(plan.threadId, transaction.launch, response.turn.id).pipe(
                  Effect.catch((cause) =>
                    Effect.logError("Accepted Turn authority could not be persisted").pipe(
                      Effect.annotateLogs({
                        threadId: plan.threadId,
                        turnId: response.turn.id,
                        cause: String(cause),
                      }),
                    ),
                  ),
                ),
              ),
              Effect.andThen(
                !plan.rendererOwnsState && canonicalParams
                  ? Effect.try(options.assertCurrentOwner).pipe(
                      Effect.andThen(Clock.currentTimeMillis),
                      Effect.flatMap((observedAtMs) =>
                        projection.acceptTurn({
                          permissions: plan.permissions,
                          execution: plan,
                          environmentSelectionEvidence,
                          threadId: plan.threadId,
                          clientUserMessageId: plan.clientUserMessageId,
                          turn: response.turn,
                          recovery: {
                            params: canonicalParams,
                            localMetadata: plan.localMetadata,
                            mcpAppModelContextAttachments: plan.mcpAppModelContextAttachments,
                            startedAtMs: plan.startedAtMs,
                          },
                          observedAtMs,
                        }),
                      ),
                      Effect.catch((cause) =>
                        Effect.logError(
                          "Accepted Turn canonical projection could not converge",
                        ).pipe(
                          Effect.annotateLogs({
                            threadId: plan.threadId,
                            turnId: response.turn.id,
                            cause: String(cause),
                          }),
                        ),
                      ),
                    )
                  : Effect.void,
              ),
              Effect.andThen(synchronizeAcceptedWorkspace(plan, response.turn.id)),
              Effect.andThen(
                options.acceptAutomationRun
                  ? automationRuns.accept(plan.threadId).pipe(
                      Effect.catch((cause) =>
                        Effect.logWarning("Accepted Turn could not accept its automation run").pipe(
                          Effect.annotateLogs({
                            threadId: plan.threadId,
                            turnId: response.turn.id,
                            cause: String(cause),
                          }),
                        ),
                      ),
                    )
                  : Effect.void,
              ),
            ),
          );
          yield* confirmDelivery;

          if (plan.rendererOwnsState || options.returnNativeResponse) return response;
          return {
            threadId: plan.threadId,
            turnId: response.turn.id,
            status: response.turn.status,
            itemIds: response.turn.items.map((item) => item.id),
          } satisfies CodexTurnSummary;
        }).pipe(
          Effect.tapError((error) =>
            Effect.gen(function* () {
              transaction.failure = error;
              const delivery = encodeCodexNativeRequestFailure(error).delivery;
              transaction.terminalUnknown =
                delivery?.stage === "outcome-unknown" && delivery.method === "thread/inject_items";
              transaction.requestRejected =
                delivery?.stage !== "outcome-unknown" || transaction.terminalUnknown;
              const current = yield* Effect.try(options.assertCurrentOwner).pipe(Effect.result);
              if (current._tag === "Failure") return;
              if (delivery?.stage === "outcome-unknown") {
                if (plan.rendererOwnsState) return;
                const now = yield* Clock.currentTimeMillis;
                conversations.current(plan.threadId)?.mutateCanonicalState((draft) => {
                  recordCodexUnconfirmedTurnSubmission(
                    draft,
                    delivery,
                    plan.clientUserMessageId,
                    transaction.terminalUnknown,
                  );
                }, now);
                return;
              }
              yield* confirmDelivery.pipe(Effect.ignoreCause);
            }),
          ),
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? rollbackStart(plan, transaction, options.assertCurrentOwner)
              : Effect.void,
          ),
        );
      }),
    );

  const prepareStart = (
    threadId: string,
    prompt: string,
    overrides: CodexTurnStartOverrides | undefined,
    rendererOwnsState: boolean,
    originalRequest?: TurnStartParams,
    originalContext?: ConversationFollowerTurnStart["context"],
  ) =>
    preparation
      .start({
        threadId,
        prompt,
        ...(overrides ? { overrides } : {}),
        rendererOwnsState,
        ...(originalRequest ? { originalRequest } : {}),
        ...(originalContext ? { originalContext } : {}),
      })
      .pipe(Effect.mapError((cause) => commandError("start", threadId, cause)));

  const scheduleFirstTurnTitle = (plan: CodexTurnStartPlan, hostId: string) =>
    plan.isFirstTurn
      ? autoTitle.scheduleFirstTurn({
          hostId,
          threadId: plan.threadId,
          prompt: plan.promptText,
          cwd: plan.request.cwd ?? null,
          serviceName: plan.serviceName,
          pastedTextAttachments: plan.autoTitlePastedTextAttachments,
          skipAutoTitleGeneration: plan.skipAutoTitleGeneration,
        })
      : Effect.void;

  const prepareSteer = (input: CodexSteerTurnInput) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const nonce = yield* Random.nextIntBetween(0, 36 ** 6);
      const intent =
        input.intent ??
        ({
          steerId: `steer:${input.threadId}:${now}:${nonce.toString(36).padStart(6, "0")}`,
          recoveryRow: {
            followUpId: `follow-up:${createUuidV7()}`,
            clientUserMessageId: input.clientUserMessageId ?? randomUUID(),
            threadId: input.threadId,
            prompt: input.prompt,
            promptInput: input.promptInput ?? { text: input.prompt },
            createdAtMs: now,
            collaborationMode: input.collaborationMode ?? null,
            serviceTier: input.serviceTier ?? null,
            summary: input.summary ?? null,
            pause: null,
          },
        } as const);
      const presentationClaim = input.presentationTicket
        ? yield* presentation
            .claim(
              input.presentationTicket,
              { kind: "thread", threadId: input.threadId },
              intent.recoveryRow.clientUserMessageId,
            )
            .pipe(Effect.mapError((cause) => commandError("steer", input.threadId, cause)))
        : presentation.readQueued(input.threadId, intent.recoveryRow.clientUserMessageId);
      return yield* Effect.gen(function* () {
        const prepared = yield* preparation
          .steer({
            command: input,
            recoveryRow: intent.recoveryRow,
          })
          .pipe(Effect.mapError((cause) => commandError("steer", input.threadId, cause)));
        return { prepared, presentationClaim };
      }).pipe(
        Effect.tapError(() =>
          input.presentationTicket
            ? Effect.sync(() => presentation.releaseClaim(presentationClaim))
            : Effect.void,
        ),
      );
    });

  // Routing stays outside the Thread lane because the selected owner executes its own command.
  const steerThroughOwner = Effect.fn("CodexTurnCommands.steerThroughOwner")(function* (
    input: CodexSteerTurnInput,
  ) {
    const threadId = input.threadId;
    const hostId = yield* hosts.resolve(threadId);
    const manager = yield* managers.get(hostId);
    const connection = captureTurnConnection(manager);
    if (!manager.stream.getRole(threadId)) yield* resumeForStart(threadId);
    yield* Effect.try(() => assertTurnConnection(connection));
    return yield* Effect.acquireUseRelease(
      commands.prepareNativeSteer(input),
      (prepared) =>
        Effect.gen(function* () {
          yield* Effect.try(() => assertTurnConnection(connection));
          const request = { method: "thread-follower-steer-turn" as const, params: prepared };
          const role = manager.stream.getRole(threadId);
          let response: unknown = null;
          if (role?.role === "follower") {
            response = yield* Effect.tryPromise({
              try: async () => {
                const forwarded = await manager.coordination.requestThreadFollower({
                  hostId,
                  targetClientId: role.ownerClientId,
                  request,
                });
                if (forwarded.resultType !== "success")
                  throw new Error(
                    forwarded.resultType === "error" ? forwarded.error : "no-client-found",
                  );
                return forwarded.result;
              },
              catch: (cause) => commandError("steer", threadId, cause),
            }).pipe(
              Effect.catch((cause) =>
                Effect.gen(function* () {
                  if (
                    !(cause.cause instanceof Error) ||
                    !cause.cause.message.includes("no-client-found")
                  )
                    return yield* Effect.fail(cause);
                  yield* Effect.try(() => {
                    assertTurnConnection(connection);
                    const currentRole = manager.stream.getRole(threadId);
                    if (
                      currentRole?.role !== "follower" ||
                      currentRole.ownerClientId !== role.ownerClientId
                    )
                      return;
                    manager.stream.removeConversation(threadId);
                    conversations.current(threadId)?.setResumeState("needs_resume");
                    conversations.current(threadId)?.setStreaming(false);
                  });
                  yield* resumeForStart(threadId);
                  return null;
                }),
              ),
            );
          }
          yield* Effect.try(() => assertTurnConnection(connection));
          if (response === null) {
            if (manager.stream.getRole(threadId)?.role !== "owner")
              return yield* commandError(
                "steer",
                threadId,
                new Error("Conversation has no available owner"),
              );
            response = yield* managers.dispatchFollowerRequest(hostId, request);
          }
          yield* Effect.try(() => assertTurnConnection(connection));
          const decoded = yield* Schema.decodeUnknownEffect(
            Schema.Struct({ result: CLIENT_REQUEST_RESPONSES["turn/steer"] }),
          )(response);
          return decoded.result as TurnSteerResponse;
        }),
      (prepared) => Effect.sync(() => releasePreparedNativeSteer(prepared.clientUserMessageId)),
    );
  });

  const nativeSteers = new Map<
    string,
    NativeTurnConnection & {
      readonly input: CanonicalOwnerSteerInput;
      readonly presentationClaim: CodexTurnPresentationClaim | undefined;
      readonly disposal: Disposable;
      readonly lock: Semaphore.Semaphore;
      completed: boolean;
      outcomeUnknown?: boolean;
      execution?: {
        readonly entity: NonNullable<ReturnType<ConversationEntityMap["Service"]["current"]>>;
        readonly owner: NonNullable<ReturnType<MainConversationManager["stream"]["getRole"]>>;
      };
      launch: CodexTurnPresentationLaunch | null;
    }
  >();
  const releasePreparedNativeSteer = (clientUserMessageId: string) => {
    const entry = nativeSteers.get(clientUserMessageId);
    if (!entry) return;
    nativeSteers.delete(clientUserMessageId);
    entry.disposal[Symbol.dispose]();
    if (!entry.completed && !entry.outcomeUnknown) presentation.abort(entry.launch);
    presentation.releaseClaim(entry.presentationClaim);
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const id of nativeSteers.keys()) releasePreparedNativeSteer(id);
    }),
  );

  const releasePreparedNativeStart = (clientUserMessageId: string) => {
    const entry = nativePreparations.get(clientUserMessageId);
    if (!entry) return;
    nativePreparations.delete(clientUserMessageId);
    entry.disposal[Symbol.dispose]();
    if (!entry.callerOwnsPresentation)
      presentation.releaseClaim(entry.plan?.presentationClaim ?? entry.overrides.presentationClaim);
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const key of nativePreparations.keys()) releasePreparedNativeStart(key);
    }),
  );
  const readNativePreparation = (request: TurnStartParams, finalized: boolean) =>
    Effect.try({
      try: () => {
        const id = request.clientUserMessageId;
        const entry = typeof id === "string" ? nativePreparations.get(id) : undefined;
        const expected = finalized ? entry?.plan?.request : entry?.original;
        if (!entry || !expected || !isDeepStrictEqual(expected, request))
          throw new Error("Native turn does not match its prepared phase");
        assertTurnConnection(entry);
        return entry;
      },
      catch: (cause) => commandError("start", request.threadId, cause),
    });
  const validateExecutingOwner = (
    entry: {
      readonly manager: MainConversationManager;
      readonly nativeGeneration: number;
      readonly original: { readonly threadId: string };
    },
    executingPeerClientId?: string,
  ) =>
    Effect.gen(function* () {
      yield* Effect.try(() => assertTurnConnection(entry));
      const manager = entry.manager;
      const threadId = entry.original.threadId;
      // Discovery advertisements cannot replace an owner selected by the stream.
      // Only a peer without a role needs discovery before admitting an action.
      const discoveredOwnerId =
        manager.stream.getRole(threadId) == null
          ? yield* Effect.tryPromise({
              try: () => manager.findOwner(threadId),
              catch: (cause) => commandError("start", threadId, cause),
            })
          : null;
      yield* Effect.try(() => assertTurnConnection(entry));
      const role = manager.stream.getRole(threadId);
      if (role?.role === "owner") {
        if (executingPeerClientId)
          return yield* commandError("start", threadId, new Error("Native turn is owned by Main"));
        return null;
      }
      const ownerId = role?.role === "follower" ? role.ownerClientId : discoveredOwnerId;
      if (!executingPeerClientId || ownerId !== executingPeerClientId)
        return yield* commandError(
          "start",
          threadId,
          new Error("Native turn must execute in the current peer owner"),
        );
      const changedOwner = role?.role !== "follower" || role.ownerClientId !== ownerId;
      if (changedOwner)
        manager.stream.setRole(threadId, { role: "follower", ownerClientId: ownerId });
      if (
        changedOwner ||
        !conversations.current(threadId)?.readCanonicalState()?.hydrationContext
      ) {
        manager.stream.setFollowing(threadId, true);
        yield* Effect.tryPromise({
          try: () => manager.stream.waitForRevision(threadId, ownerId, 1, 30_000),
          catch: (cause) => commandError("start", threadId, cause),
        });
        yield* Effect.try(() => assertTurnConnection(entry));
      }
      return ownerId;
    });
  const assertReceipt = (entry: NonNullable<ReturnType<typeof nativePreparations.get>>) =>
    Effect.try({
      try: () => {
        assertTurnConnection(entry);
        if (nativePreparations.get(entry.original.clientUserMessageId!) !== entry)
          throw new Error("Native preparation retired");
      },
      catch: (cause) => commandError("start", entry.original.threadId, cause),
    });

  // Peer dispatch must remain outside the Thread lane: the selected owner's native
  // execution acquires that lane after its canonical preparation is complete.
  const resumeForStart = (threadId: string) =>
    resume
      .resume(threadId)
      .pipe(
        Effect.flatMap((result) =>
          result.status === "ready"
            ? Effect.void
            : Effect.fail(
                commandError(
                  "start",
                  threadId,
                  new Error(`Conversation is not ready: ${result.reason}`),
                ),
              ),
        ),
      );
  const adoptFreshNativeThread = Effect.fn("CodexTurnCommands.adoptFreshNativeThread")(function* (
    threadId: string,
    fresh: NonNullable<CodexTurnStartOverrides["freshNativeThread"]>,
  ) {
    const hostId = yield* hosts.resolve(threadId);
    if (hostId !== fresh.hostId)
      return yield* commandError(
        "start",
        threadId,
        new Error("Fresh Thread execution host changed before its first Turn"),
      );
    const manager = yield* managers.get(hostId);
    yield* Effect.try({
      try: () => manager.assertCurrent(fresh.generation),
      catch: (cause) => commandError("start", threadId, cause),
    });
    if (manager.generation !== fresh.generation)
      return yield* commandError(
        "start",
        threadId,
        new Error("Fresh Thread native generation changed before its first Turn"),
      );
    const conversation = conversations.current(threadId);
    if (!conversation?.readCanonicalState())
      return yield* commandError(
        "start",
        threadId,
        new Error("Fresh Thread canonical state is unavailable"),
      );
    const role = manager.stream.getRole(threadId);
    if (role?.role === "follower")
      return yield* commandError(
        "start",
        threadId,
        new Error("Fresh Thread was adopted by another conversation owner"),
      );
    if (!role) manager.stream.setRole(threadId, { role: "owner" });
  });
  const startThroughOwner = Effect.fn("CodexTurnCommands.startThroughOwner")(
    function* (
      threadId: string,
      prompt: string,
      overrides: CodexTurnStartOverrides | undefined,
      acceptAutomationRun: boolean,
    ) {
      if (overrides?.freshNativeThread)
        yield* adoptFreshNativeThread(threadId, overrides.freshNativeThread);
      yield* resumeForStart(threadId);
      const hostId = yield* hosts.resolve(threadId);
      const manager = yield* managers.get(hostId);
      const connection = captureTurnConnection(manager);
      const clientUserMessageId = overrides?.clientUserMessageId ?? createUuidV7();
      const { freshNativeThread: _freshNativeThread, ...nativeOverrides } = overrides ?? {};
      const preparedPrompt =
        nativeOverrides.preparedPrompt ??
        (prompt.length === 0 && !overrides?.promptInput
          ? createEmptyCodexPreparedPrompt()
          : yield* preparation.prepareCaptured(
              threadId,
              clientUserMessageId,
              prompt,
              nativeOverrides.promptInput ?? { text: prompt },
            ));
      yield* Effect.try(() => assertTurnConnection(connection));

      const execute = () =>
        Effect.acquireUseRelease(
          commands.prepareNativeStart(threadId, prompt, {
            ...nativeOverrides,
            clientUserMessageId,
            preparedPrompt,
          }),
          (operation) =>
            Effect.gen(function* () {
              const entry = yield* readNativePreparation(operation.request, false);
              entry.acceptAutomationRun = acceptAutomationRun;
              entry.callerOwnsPresentation = true;
              yield* Effect.try(() => assertTurnConnection(connection));
              const role = manager.stream.getRole(threadId);
              if (role?.role === "follower") {
                const forwarded = yield* Effect.tryPromise({
                  try: async () => {
                    const response = await manager.coordination.requestThreadFollower({
                      hostId,
                      targetClientId: role.ownerClientId,
                      request: {
                        method: "thread-follower-start-turn",
                        params: { conversationId: threadId, turnStart: operation },
                      },
                    });
                    if (response.resultType !== "success")
                      throw new Error(
                        response.resultType === "error" ? response.error : "no-client-found",
                      );
                    return response.result;
                  },
                  catch: (cause) => commandError("start", threadId, cause),
                }).pipe(
                  Effect.catch((cause) =>
                    Effect.gen(function* () {
                      if (
                        !(cause.cause instanceof Error) ||
                        !cause.cause.message.includes("no-client-found")
                      )
                        return yield* Effect.fail(cause);
                      yield* Effect.try(() => {
                        assertTurnConnection(connection);
                        const currentRole = manager.stream.getRole(threadId);
                        if (
                          currentRole?.role === "follower" &&
                          currentRole.ownerClientId === role.ownerClientId
                        ) {
                          manager.stream.removeConversation(threadId);
                          conversations.current(threadId)?.setResumeState("needs_resume");
                          conversations.current(threadId)?.setStreaming(false);
                        }
                      });
                      yield* resumeForStart(threadId);
                      return null;
                    }),
                  ),
                );
                yield* Effect.try(() => assertTurnConnection(connection));
                if (forwarded !== null) {
                  const response = yield* Schema.decodeUnknownEffect(
                    Schema.Struct({ result: CLIENT_REQUEST_RESPONSES["turn/start"] }),
                  )(forwarded);
                  return response.result as TurnStartResponse;
                }
              }
              if (manager.stream.getRole(threadId)?.role !== "owner")
                return yield* commandError(
                  "start",
                  threadId,
                  new Error("Conversation has no available owner"),
                );
              const prepared = yield* commands.inspectPreparedNativeStart(operation);
              return yield* commands.executePreparedNativeStart(prepared.request);
            }),
          () => Effect.sync(() => releasePreparedNativeStart(clientUserMessageId)),
        );
      const response = yield* execute().pipe(
        Effect.catch((cause) => {
          if (!isThreadNotFound(cause) || manager.stream.getRole(threadId)?.role !== "owner")
            return Effect.fail(cause);
          return Effect.try(() => assertTurnConnection(connection))
            .pipe(
              Effect.andThen(conversations.runCommand(threadId, materialization.reload(threadId))),
            )
            .pipe(Effect.andThen(execute()));
        }),
      );
      return {
        threadId,
        turnId: response.turn.id,
        status: response.turn.status,
        itemIds: response.turn.items.map((item) => item.id),
      } satisfies CodexTurnSummary;
    },
    (effect, _threadId, _prompt, overrides) =>
      effect.pipe(
        Effect.ensuring(Effect.sync(() => presentation.releaseClaim(overrides?.presentationClaim))),
      ),
  );

  const commands: CodexTurnCommandsService = CodexTurnCommands.of({
    prepareNativeToolMessage: (threadId, sourceThreadId, prompt, mode, overrides) =>
      Effect.gen(function* () {
        const escape = (value: string) =>
          value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
        const output = [
          "<codex_delegation>",
          `  <source_thread_id>${escape(sourceThreadId)}</source_thread_id>`,
          `  <input>${escape(prompt)}</input>`,
          "</codex_delegation>",
        ].join("\n");
        const id = createUuidV7();
        const hostId = yield* hosts.resolve(threadId);
        const manager = yield* managers.get(hostId);
        const connection = captureTurnConnection(manager);
        const captured = yield* preparation.prepareCaptured(threadId, id, prompt, { text: prompt });
        const capability = yield* capabilities.forHost(hostId);
        yield* Effect.try(() => assertTurnConnection(connection));
        const toolOutput = capability.flags.turnToolOutput
          ? { name: "send_message_to_thread", namespace: "codex_app", output }
          : undefined;
        const nativeInput = toolOutput
          ? []
          : [{ type: "text" as const, text: output, text_elements: [] }];
        const preparedPrompt = { ...captured, inputItems: nativeInput };
        const restoreMessage: CodexQueuedMessage = {
          id,
          cwd: conversations.current(threadId)?.readCanonicalState()?.cwd ?? null,
          context: {
            prompt,
            fileAttachments: [],
            addedFiles: [],
            commentAttachments: [],
            imageAttachments: [],
          },
        };
        const steer: CanonicalOwnerSteerInput = {
          conversationId: threadId,
          clientUserMessageId: id,
          input: nativeInput,
          restoreMessage,
          attachments: [],
          ...(toolOutput ? { toolOutput } : {}),
        };
        if (mode === "steer") {
          const lock = yield* Semaphore.make(1);
          nativeSteers.set(id, {
            input: steer,
            ...connection,
            presentationClaim: undefined,
            disposal: manager.onConnectionReset(() => releasePreparedNativeSteer(id)),
            lock,
            completed: false,
            launch: null,
          });
          return { steer };
        }
        const start = yield* commands.prepareNativeStart(
          threadId,
          prompt,
          { ...overrides, clientUserMessageId: id, preparedPrompt },
          {
            threadId,
            input: nativeInput,
            clientUserMessageId: id,
            ...(toolOutput ? { toolOutput } : {}),
            ...(overrides?.model !== undefined ? { model: overrides.model } : {}),
            ...(overrides?.reasoningEffort !== undefined
              ? { effort: overrides.reasoningEffort }
              : {}),
          },
        );
        yield* Effect.try(() => assertTurnConnection(connection)).pipe(
          Effect.tapError(() => Effect.sync(() => releasePreparedNativeStart(id))),
        );
        return { start, steer };
      }).pipe(Effect.mapError((cause) => commandError("start", threadId, cause))),
    injectPreparedNativeStart: (operation, executingPeerClientId) =>
      Effect.gen(function* () {
        const entry = yield* readNativePreparation(operation.request, false);
        return yield* entry.lock.withPermit(
          Effect.gen(function* () {
            const owner = yield* validateExecutingOwner(entry, executingPeerClientId);
            yield* assertReceipt(entry);
            if (
              !entry.plan ||
              entry.ownerId !== owner ||
              !isDeepStrictEqual(operation.context, entry.context)
            )
              return yield* commandError(
                "start",
                operation.request.threadId,
                new Error("App context no longer matches its prepared owner"),
              );
            if (entry.injection !== "pending")
              return yield* commandError(
                "start",
                operation.request.threadId,
                new Error("App context injection already dispatched"),
              );
            const items = entry.context?.responseItems;
            if (!Array.isArray(items) || !items.every(isAppContextJson))
              return yield* commandError(
                "start",
                operation.request.threadId,
                new Error("Invalid app context response items"),
              );
            entry.injection = "in-flight";
            yield* gateway.requestForThread(
              operation.request.threadId,
              "thread/inject_items",
              {
                threadId: operation.request.threadId,
                items,
              },
              turnConnectionFence(entry),
            );
            yield* Effect.try(() => assertTurnConnection(entry));
            yield* assertReceipt(entry);
            entry.injection = "complete";
          }),
        );
      }).pipe(Effect.mapError((cause) => commandError("start", operation.request.threadId, cause))),
    prepareNativeQueuedMessage: (threadId, message, mode, preparationContext) =>
      Effect.gen(function* () {
        const clientUserMessageId = preparationContext.clientUserMessageId ?? message.id;
        const hostId = yield* hosts.resolve(threadId);
        const manager = yield* managers.get(hostId);
        const connection = captureTurnConnection(manager);
        const captured = yield* preparation.prepareCaptured(
          threadId,
          clientUserMessageId,
          message.context.prompt,
          queuedMessagePromptInput(message),
        );
        const appInput = yield* Effect.try(() =>
          prepareUntrustedAppInput(
            captured.promptText,
            message.context,
            `untrusted_input_${message.id}`,
          ),
        );
        const preparedPrompt = {
          ...captured,
          inputItems: [appInput.input, ...captured.inputItems.slice(1)],
        };
        const requiresIdle = appInput.responseItems.length > 0;
        yield* Effect.try(() => assertTurnConnection(connection));
        const additionalContext =
          message.writingBlockAdditionalContext ?? preparedPrompt.additionalContext;
        const steer: CanonicalOwnerSteerInput = {
          conversationId: threadId,
          clientUserMessageId,
          input: structuredClone(preparedPrompt.inputItems),
          restoreMessage: structuredClone(message),
          serviceTier: message.submissionOptions?.serviceTier,
          attachments: [...preparedPrompt.fileAttachments, ...preparedPrompt.addedFiles],
          additionalContext,
        };
        if (mode === "steer") {
          const lock = yield* Semaphore.make(1);
          yield* Effect.try(() => {
            assertTurnConnection(connection);
            if (nativeSteers.has(clientUserMessageId))
              throw new Error("Steer identity already prepared");
            nativeSteers.set(clientUserMessageId, {
              input: steer,
              ...connection,
              presentationClaim: presentation.readQueued(threadId, message.id),
              disposal: manager.onConnectionReset(() =>
                releasePreparedNativeSteer(clientUserMessageId),
              ),
              lock,
              completed: false,
              launch: null,
            });
          });
          return { steer, requiresIdle };
        }
        const permissionSelection = message.submissionOptions?.permissionSelection;
        const shouldSendPermissionOverrides =
          message.submissionOptions?.shouldSendPermissionOverrides === true;
        const config =
          shouldSendPermissionOverrides || permissionSelection?.kind === "custom"
            ? ((yield* gateway.requestOnHost(
                hostId,
                "config/read",
                { includeLayers: false, cwd: message.cwd },
                turnConnectionFence(connection),
              )).config as CanonicalPermissionConfig)
            : null;
        let legacyPermissions =
          config === null || permissionSelection != null
            ? null
            : canonicalPermissionsForMode(
                message.submissionOptions?.agentMode ?? "auto",
                preparationContext.runtimeWorkspaceRoots,
                config,
              );
        if (legacyPermissions && message.submissionOptions?.permissionProfileId != null) {
          legacyPermissions = {
            ...legacyPermissions,
            activePermissionProfile: {
              id: message.submissionOptions.permissionProfileId,
              extends: null,
            },
            runtimeWorkspaceRoots: [...preparationContext.runtimeWorkspaceRoots],
          };
        }
        const legacyFields = legacyPermissions
          ? nativePermissionRequestFields(legacyPermissions)
          : null;
        const selectedFields =
          permissionSelection == null
            ? null
            : materializeCodexPermissionSelection(
                permissionSelection,
                preparationContext.runtimeWorkspaceRoots,
                config,
              );
        const usePermissionSelection =
          preparationContext.usePermissionSelection &&
          (permissionSelection == null || permissionSelection.kind === "server-default");
        const useAppServerPermissionDefault =
          selectedFields == null && !shouldSendPermissionOverrides && usePermissionSelection;
        const start = yield* commands.prepareNativeStart(
          threadId,
          message.context.prompt,
          {
            clientUserMessageId,
            preparedPrompt,
            presentationClaim: presentation.readQueued(threadId, message.id),
          },
          {
            threadId,
            clientUserMessageId,
            input: preparedPrompt.inputItems,
            turnTrigger:
              typeof message.context.turnTrigger === "string"
                ? message.context.turnTrigger
                : "composer_queue",
            cwd: message.cwd,
            model: null,
            effort: null,
            collaborationMode: message.submissionOptions?.collaborationMode ?? null,
            serviceTier: message.submissionOptions?.serviceTier,
            summary: message.submissionOptions?.summary,
            ...(legacyFields ?? {}),
            ...(selectedFields ?? {}),
            additionalContext,
          },
          {
            attachments: steer.attachments,
            commentAttachments: preparedPrompt.commentAttachments,
            writingBlockContextPrepared: message.writingBlockAdditionalContext !== undefined,
            mcpAppModelContextAttachments: message.context.mcpAppModelContextAttachments,
            responseItems: appInput.responseItems,
            useAppServerPermissionDefault,
            usePermissionSelection,
            localTurnMetadata: {
              fileAttachmentCount:
                message.context.fileAttachments.length +
                (message.context.pastedTextAttachments?.length ?? 0) +
                message.context.addedFiles.length,
            },
          },
        );
        yield* Effect.try(() => assertTurnConnection(connection)).pipe(
          Effect.tapError(() => Effect.sync(() => releasePreparedNativeStart(clientUserMessageId))),
        );
        return { start, steer, requiresIdle };
      }).pipe(Effect.mapError((cause) => commandError("start", threadId, cause))),
    releasePreparedNativeStart,
    prepareNativeStart: (threadId, prompt, overrides, originalRequest, sourceContext) =>
      Effect.gen(function* () {
        const hostId = yield* hosts.resolve(threadId);
        const manager = yield* managers.get(hostId);
        const connection = captureTurnConnection(manager);
        const lock = yield* Semaphore.make(1);
        return yield* Effect.try({
          try: () => {
            assertTurnConnection(connection);
            const clientUserMessageId =
              overrides?.clientUserMessageId ??
              originalRequest?.clientUserMessageId ??
              createUuidV7();
            const input = overrides?.preparedPrompt?.inputItems ?? [
              { type: "text" as const, text: prompt, text_elements: [] },
            ];
            const original: TurnStartParams = structuredClone(
              originalRequest ?? {
                threadId,
                clientUserMessageId,
                input,
                ...(overrides?.preparedPrompt?.additionalContext
                  ? { additionalContext: overrides.preparedPrompt.additionalContext }
                  : {}),
                ...(overrides?.model !== undefined ? { model: overrides.model } : {}),
                ...(overrides?.reasoningEffort !== undefined
                  ? { effort: overrides.reasoningEffort }
                  : {}),
                ...(overrides?.serviceTier !== undefined
                  ? { serviceTier: overrides.serviceTier }
                  : {}),
                ...(overrides?.summary !== undefined ? { summary: overrides.summary } : {}),
              },
            );
            if (
              original.threadId !== threadId ||
              original.clientUserMessageId !== clientUserMessageId ||
              !isDeepStrictEqual(original.input, input)
            )
              throw new Error("Native preflight identity/input mismatch");
            if (nativePreparations.has(clientUserMessageId))
              throw new Error("Turn identity already prepared");
            const context = structuredClone(
              sourceContext ??
                (overrides?.preparedPrompt
                  ? {
                      attachments: [
                        ...overrides.preparedPrompt.fileAttachments,
                        ...overrides.preparedPrompt.addedFiles,
                      ],
                      commentAttachments: [...overrides.preparedPrompt.commentAttachments],
                    }
                  : undefined),
            );
            // Capture the peer wire value before retaining authority. JSON peers omit undefined
            // fields, while Electron's structured clone preserves them.
            const admitted = JSON.parse(
              JSON.stringify({
                request: original,
                ...(context === undefined ? {} : { context }),
              }),
            ) as ConversationFollowerTurnStart;
            nativePreparations.set(clientUserMessageId, {
              original: admitted.request,
              context: admitted.context,
              prompt,
              overrides: { ...overrides, clientUserMessageId },
              ...connection,
              plan: null,
              ownerId: undefined,
              injection: "pending",
              acceptAutomationRun: true,
              callerOwnsPresentation: false,
              lock,
              disposal: manager.onConnectionReset(() =>
                releasePreparedNativeStart(clientUserMessageId),
              ),
            });
            return structuredClone(admitted);
          },
          catch: (cause) => commandError("start", threadId, cause),
        });
      }).pipe(Effect.mapError((cause) => commandError("start", threadId, cause))),
    inspectPreparedNativeStart: (operation, executingPeerClientId) =>
      Effect.gen(function* () {
        const request = operation.request;
        const entry = yield* readNativePreparation(request, false);
        if (!isDeepStrictEqual(operation.context, entry.context))
          return yield* commandError(
            "start",
            request.threadId,
            new Error("Turn context does not match its admission"),
          );
        return yield* entry.lock.withPermit(
          Effect.gen(function* () {
            const ownerId = yield* validateExecutingOwner(entry, executingPeerClientId);
            yield* assertReceipt(entry);
            if (
              conversations.current(request.threadId)?.readCanonicalState()
                ?.unconfirmedTurnSubmissions?.length
            )
              return yield* commandError(
                "start",
                request.threadId,
                new Error("An earlier turn submission is not yet confirmed"),
              );
            const state = conversations.current(request.threadId)?.readCanonicalState();
            if (
              Array.isArray(entry.context?.responseItems) &&
              entry.context.responseItems.length > 0 &&
              (latestConversationTurn(state)?.status === "inProgress" ||
                state?.threadRuntimeStatus?.type === "active")
            )
              return yield* commandError(
                "start",
                request.threadId,
                new Error("App context must wait until the current turn finishes"),
              );
            if (entry.plan === null || entry.ownerId !== ownerId) {
              if (ownerId === null) {
                yield* ownerSettings.awaitCurrent(entry.manager.hostId, request.threadId);
                yield* assertReceipt(entry);
                if ((yield* validateExecutingOwner(entry, executingPeerClientId)) !== ownerId)
                  return yield* commandError(
                    "start",
                    request.threadId,
                    new Error("Turn owner changed while waiting for settings"),
                  );
              }
              const plan = yield* prepareStart(
                request.threadId,
                entry.prompt,
                entry.overrides,
                ownerId !== null,
                entry.original,
                entry.context,
              );
              yield* assertReceipt(entry);
              const currentOwnerId = yield* validateExecutingOwner(entry, executingPeerClientId);
              if (currentOwnerId !== ownerId)
                return yield* commandError(
                  "start",
                  request.threadId,
                  new Error("Turn owner changed during materialization"),
                );
              entry.plan = plan;
              entry.ownerId = ownerId;
            }
            if (!entry.plan.canonicalParams)
              return yield* commandError(
                "start",
                request.threadId,
                new Error("Prepared canonical turn context unavailable"),
              );
            return {
              request: structuredClone(entry.plan.request),
              params: structuredClone(entry.plan.canonicalParams),
              model: entry.plan.model,
              reasoningEffort: entry.plan.reasoningEffort,
              shouldUpdateReasoningEffort: entry.plan.shouldUpdateReasoningEffort,
              collaborationMode: structuredClone(entry.plan.collaborationMode),
              permissions: structuredClone(entry.plan.permissions),
              previousPermissions: structuredClone(entry.plan.previousPermissions),
            };
          }),
        );
      }).pipe(Effect.mapError((cause) => commandError("start", operation.request.threadId, cause))),
    executePreparedNativeStart: (request, executingPeerClientId) =>
      Effect.gen(function* () {
        const entry = yield* readNativePreparation(request, true);
        const plan = yield* entry.lock.withPermit(
          Effect.gen(function* () {
            const ownerId = yield* validateExecutingOwner(entry, executingPeerClientId);
            yield* assertReceipt(entry);
            if (
              !entry.plan ||
              entry.ownerId !== ownerId ||
              !isDeepStrictEqual(entry.plan.request, request)
            )
              return yield* commandError(
                "start",
                request.threadId,
                new Error("Turn owner or request changed after materialization"),
              );
            if (
              entry.plan.rendererOwnsState &&
              Array.isArray(entry.context?.responseItems) &&
              entry.context.responseItems.length > 0 &&
              entry.injection !== "complete"
            )
              return yield* commandError(
                "start",
                request.threadId,
                new Error("App context must be injected before starting the turn"),
              );
            nativePreparations.delete(entry.original.clientUserMessageId!);
            entry.disposal[Symbol.dispose]();
            return entry.plan;
          }),
        );
        const owner = entry.manager.stream.getRole(request.threadId);
        const entity = conversations.current(request.threadId);
        const assertCurrentOwner = () => {
          assertTurnOwner(entry, request.threadId, executingPeerClientId);
          if (
            entry.manager.stream.getRole(request.threadId) !== owner ||
            conversations.current(request.threadId) !== entity
          )
            throw new Error("Turn owner changed during native execution");
        };
        const responseItems =
          !plan.rendererOwnsState && entry.injection !== "complete"
            ? entry.context?.responseItems
            : undefined;
        if (
          responseItems !== undefined &&
          (!Array.isArray(responseItems) || !responseItems.every(isAppContextJson))
        )
          return yield* commandError(
            "start",
            request.threadId,
            new Error("Invalid app context response items"),
          );
        return yield* scheduleFirstTurnTitle(plan, entry.manager.hostId).pipe(
          Effect.andThen(
            conversations.runCommand(
              request.threadId,
              startTransaction(plan, {
                connection: entry,
                acceptAutomationRun: entry.acceptAutomationRun,
                returnNativeResponse: true,
                assertCurrentOwner,
                responseItems,
              }),
            ),
          ),
          Effect.flatMap((response) =>
            Effect.try({
              try: () => {
                assertCurrentOwner();
                return response as TurnStartResponse;
              },
              catch: (cause) => commandError("start", request.threadId, cause),
            }),
          ),
          Effect.onError(() =>
            Effect.sync(() => {
              if (!entry.callerOwnsPresentation) presentation.releaseClaim(plan.presentationClaim);
            }),
          ),
        );
      }).pipe(Effect.mapError((cause) => commandError("start", request.threadId, cause))),
    start: (threadId, prompt, overrides) =>
      startThroughOwner(threadId, prompt, overrides, true).pipe(
        Effect.map((result) => result as CodexTurnSummary | null),
        Effect.mapError((cause) =>
          cause instanceof Object && "_tag" in cause && cause._tag === "CodexRuntimeError"
            ? (cause as CodexRuntimeError)
            : commandError("start", threadId, cause),
        ),
        Effect.withSpan("CodexTurnCommands.start", { attributes: { threadId } }),
      ),
    startAutomation: (threadId, prompt, overrides) =>
      startThroughOwner(threadId, prompt, overrides, false).pipe(
        Effect.map((result) => result as CodexTurnSummary | null),
        Effect.mapError((cause) =>
          cause instanceof Object && "_tag" in cause && cause._tag === "CodexRuntimeError"
            ? (cause as CodexRuntimeError)
            : commandError("start", threadId, cause),
        ),
        Effect.withSpan("CodexTurnCommands.startAutomation", { attributes: { threadId } }),
      ),
    prepareNativeSteer: (input) =>
      Effect.gen(function* () {
        const hostId = yield* hosts.resolve(input.threadId);
        const manager = yield* managers.get(hostId);
        const connection = captureTurnConnection(manager);
        const { prepared, presentationClaim } = yield* prepareSteer(input);
        const clientUserMessageId = prepared.clientUserMessageId;
        const lock = yield* Semaphore.make(1);
        return yield* Effect.try({
          try: () => {
            assertTurnConnection(connection);
            if (nativeSteers.has(clientUserMessageId))
              throw new Error("Steer identity already prepared");
            nativeSteers.set(clientUserMessageId, {
              input: structuredClone(prepared),
              ...connection,
              presentationClaim,
              disposal: manager.onConnectionReset(() =>
                releasePreparedNativeSteer(clientUserMessageId),
              ),
              lock,
              completed: false,
              launch: null,
            });
            return structuredClone(prepared);
          },
          catch: (cause) => {
            presentation.releaseClaim(presentationClaim);
            return commandError("steer", input.threadId, cause);
          },
        });
      }).pipe(Effect.mapError((cause) => commandError("steer", input.threadId, cause))),
    inspectPreparedNativeSteer: (clientUserMessageId) =>
      Effect.try({
        try: () => {
          const entry = nativeSteers.get(clientUserMessageId);
          if (!entry || entry.completed || entry.outcomeUnknown)
            throw new Error("Native steer preparation unavailable");
          assertTurnConnection(entry);
          return structuredClone(entry.input);
        },
        catch: (cause) => commandError("steer", "", cause),
      }),
    executePreparedNativeSteer: (
      request,
      clientUserMessageId,
      executingPeerClientId,
      requestOptions,
    ) =>
      Effect.gen(function* () {
        const entry = yield* Effect.try({
          try: () => {
            const entry = nativeSteers.get(clientUserMessageId);
            if (
              !entry ||
              entry.completed ||
              entry.outcomeUnknown ||
              (entry.input.toolOutput == null
                ? request.method !== "turn/steer"
                : request.method !== "turn/start" ||
                  !isDeepStrictEqual(request.params.toolOutput, entry.input.toolOutput)) ||
              request.params.threadId !== entry.input.conversationId ||
              (request.method === "turn/steer" &&
                request.params.clientUserMessageId !== clientUserMessageId) ||
              !isDeepStrictEqual(request.params.input, entry.input.input) ||
              !isDeepStrictEqual(request.params.additionalContext, entry.input.additionalContext)
            )
              throw new Error("Native steer does not match its admission");
            assertTurnConnection(entry);
            return entry;
          },
          catch: (cause) => commandError("steer", request.params.threadId, cause),
        });
        return yield* entry.lock.withPermit(
          Effect.gen(function* () {
            yield* validateExecutingOwner(
              { ...entry, original: { threadId: entry.input.conversationId } },
              executingPeerClientId,
            );
            if (
              nativeSteers.get(clientUserMessageId) !== entry ||
              entry.completed ||
              entry.outcomeUnknown
            )
              return yield* commandError(
                "steer",
                entry.input.conversationId,
                new Error("Native steer preparation retired"),
              );
            const assertExecution = () => {
              assertTurnOwner(entry, entry.input.conversationId, executingPeerClientId);
              const entity = conversations.current(entry.input.conversationId);
              const owner = entry.manager.stream.getRole(entry.input.conversationId);
              if (!entity || !owner) throw new Error("Steering conversation is unavailable");
              entry.execution ??= { entity, owner };
              if (
                entry.execution.entity !== entity ||
                entry.execution.owner !== owner ||
                nativeSteers.get(clientUserMessageId) !== entry
              )
                throw new Error("Steering execution owner has retired");
            };
            yield* Effect.try(assertExecution);
            entry.launch ??= yield* presentation.begin(
              entry.presentationClaim,
              entry.input.conversationId,
              clientUserMessageId,
            );
            yield* Effect.try(assertExecution);
            const scheduling: CodexGatewayRequestOptions = {
              ...turnConnectionFence(entry),
              priority: "critical",
              timeoutMs: requestOptions?.timeoutMs ?? 30_000,
              onOutcomeUnknown: requestOptions?.onOutcomeUnknown
                ? (delivery) =>
                    Effect.sync(assertExecution).pipe(
                      Effect.andThen(requestOptions.onOutcomeUnknown!(delivery)),
                    )
                : undefined,
            };
            const nativeRequest =
              request.method === "turn/steer"
                ? gateway.requestForThread(
                    entry.input.conversationId,
                    "turn/steer",
                    request.params as GatewayTurnSteerParams,
                    scheduling,
                  )
                : gateway
                    .requestForThread(
                      entry.input.conversationId,
                      "turn/start",
                      request.params as GatewayTurnStartParams,
                      scheduling,
                    )
                    .pipe(Effect.map((response) => ({ turnId: response.turn.id })));
            const response = yield* nativeRequest.pipe(
              Effect.tapError((error) =>
                Effect.sync(() => {
                  entry.outcomeUnknown =
                    encodeCodexNativeRequestFailure(error).delivery?.stage === "outcome-unknown";
                }),
              ),
            );
            yield* Effect.try({
              try: assertExecution,
              catch: (cause) => commandError("steer", entry.input.conversationId, cause),
            });
            yield* presentation
              .bind(entry.launch, response.turnId)
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Accepted steer presentation could not bind", error),
                ),
              );
            entry.completed = true;
            return response as TurnSteerResponse;
          }),
        );
      }).pipe(Effect.mapError((cause) => commandError("steer", request.params.threadId, cause))),
    releasePreparedNativeSteer,
    steer: (input) =>
      steerThroughOwner(input).pipe(
        Effect.mapError((cause) =>
          cause instanceof Object && "_tag" in cause && cause._tag === "CodexRuntimeError"
            ? (cause as CodexRuntimeError)
            : commandError("steer", input.threadId, cause),
        ),
        Effect.withSpan("CodexTurnCommands.steer", {
          attributes: { threadId: input.threadId },
        }),
      ),
  });
  return commands;
});
