import { randomUUID } from "node:crypto";
import type {
  TurnStartParams,
  TurnStartResponse,
  TurnSteerResponse,
} from "@nodex/codex-app-server-protocol/v2";
import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import type { ClientRequestParamsByMethod } from "@nodex/effect-codex-app-server/rpc";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type {
  CodexCanonicalWorktreeInitItem,
  CodexPreparedPrompt,
  CodexSteerTurnInput,
  CodexSteerTurnResult,
  CodexTurnStartOptions,
  CodexTurnSummary,
} from "../../shared/types";
import { createUuidV7 } from "../../shared/uuid-v7";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import type { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { CoreModules } from "../core-runtime/CoreModules";
import { ProjectRuntimeLifecycleRuntime } from "../host-runtime/ProjectRuntimeLifecycleRuntime";
import { CodexAutomationRunAcceptance } from "./CodexAutomationRunAcceptance";
import { CodexConversationMaterialization } from "./CodexConversationMaterialization";
import { CodexConversationProjection } from "./CodexConversationProjection";
import { CodexTurnAuthority, type CodexTurnAuthorityLaunch } from "./CodexTurnAuthority";
import {
  CodexTurnPreparation,
  type CodexTurnStartPlan,
  type CodexTurnSteerPlan,
} from "./CodexTurnPreparation";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

type GatewayTurnStartParams = ClientRequestParamsByMethod["turn/start"];
type GatewayTurnSteerParams = ClientRequestParamsByMethod["turn/steer"];

export type CodexTurnStartOverrides = CodexTurnStartOptions & {
  readonly agentConfigPermissionMode?: boolean;
  readonly clientUserMessageId?: string;
  readonly preparedPrompt?: CodexPreparedPrompt;
  readonly responsesapiClientMetadata?: TurnStartParams["responsesapiClientMetadata"];
  readonly worktreeInit?: CodexCanonicalWorktreeInitItem;
};

export interface CodexPreparedRendererTurn {
  readonly threadId: string;
  readonly projectId: string | null;
  readonly request: TurnStartParams;
  readonly clientUserMessageId: string;
  readonly verifiedBuiltinFullAccess: boolean;
  readonly startedAtMs: number;
}

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
  readonly start: (
    threadId: string,
    prompt: string,
    overrides?: CodexTurnStartOverrides,
  ) => Effect.Effect<CodexTurnSummary | null, CodexTurnCommandsError>;
  readonly startRendererOwned: (
    threadId: string,
    prompt: string,
    overrides?: CodexTurnStartOverrides,
  ) => Effect.Effect<TurnStartResponse, CodexTurnCommandsError>;
  /** Starts the first autonomous Automation Turn without marking the Run as user-accepted. */
  readonly startAutomation: (
    threadId: string,
    prompt: string,
    overrides?: CodexTurnStartOverrides,
  ) => Effect.Effect<CodexTurnSummary | null, CodexTurnCommandsError>;
  /** Executes an already materialized renderer-owned first Turn without re-planning it. */
  readonly acceptPreparedRendererTurn: (
    plan: CodexPreparedRendererTurn,
  ) => Effect.Effect<TurnStartResponse, CodexTurnCommandsError>;
  readonly steer: (
    input: CodexSteerTurnInput,
  ) => Effect.Effect<CodexSteerTurnResult | null, CodexTurnCommandsError>;
  /** Starts the next autonomous goal turn without projecting a synthetic user message. */
  readonly continueGoal: (threadId: string) => Effect.Effect<void, CodexTurnCommandsError>;
}

export class CodexTurnCommands extends Context.Service<
  CodexTurnCommands,
  CodexTurnCommandsService
>()("nodex/main/codex-application/CodexTurnCommands") {}

const isSteerTurnInactive = (error: unknown): boolean => {
  if (!(typeof error === "object" && error !== null && "_tag" in error)) return false;
  if ((error as { readonly _tag: string })._tag !== "CodexRuntimeError") return false;
  const cause = (error as CodexRuntimeError).cause;
  if (!(cause instanceof CodexAppServerRequestError)) return false;
  const codexErrorInfo =
    typeof cause.data === "object" && cause.data !== null
      ? (cause.data as Record<string, unknown>).codexErrorInfo
      : null;
  if (
    typeof codexErrorInfo === "object" &&
    codexErrorInfo !== null &&
    "activeTurnNotSteerable" in codexErrorInfo
  ) {
    return true;
  }
  const message = cause.message.toLowerCase();
  return (
    message.includes("steerturninactiveerror") ||
    message.includes("active turn not steerable") ||
    (message.includes("active turn") && message.includes("not") && message.includes("steer"))
  );
};

const isThreadNotFound = (error: unknown): boolean => {
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

const parseSteerTurnMismatchActualTurnId = (error: unknown): string | null => {
  const cause =
    typeof error === "object" && error !== null && "cause" in error
      ? (error as { readonly cause: unknown }).cause
      : error;
  const message = cause instanceof Error ? cause.message : String(cause);
  return (
    /expected active turn id [`']?[^`'\s]+[`']? but found [`']?([^`'\s]+)[`']?/iu.exec(
      message,
    )?.[1] ??
    /ExpectedTurnMismatch\s*\{[^}]*actual:\s*"([^"]+)"/u.exec(message)?.[1] ??
    null
  );
};

export const make: Effect.Effect<
  CodexTurnCommandsService,
  never,
  | CodexConversationProjection
  | CodexConversationMaterialization
  | CodexAutomationRunAcceptance
  | CodexGateway
  | CodexTurnAuthority
  | CodexTurnPreparation
  | ConversationEntityMap
  | CoreModules
  | ProjectRuntimeLifecycleRuntime
  | Scope.Scope
> = Effect.gen(function* () {
  const conversations = yield* ConversationEntityMap;
  const gateway = yield* CodexGateway;
  const projectLifecycle = yield* ProjectRuntimeLifecycleRuntime;
  const automationRuns = yield* CodexAutomationRunAcceptance;
  const materialization = yield* CodexConversationMaterialization;
  const projection = yield* CodexConversationProjection;
  const preparation = yield* CodexTurnPreparation;
  const authority = yield* CodexTurnAuthority;
  const core = yield* CoreModules;

  const commandError = (
    operation: "start" | "steer",
    threadId: string,
    cause: unknown,
  ): CodexTurnCommandError =>
    cause instanceof CodexTurnCommandError
      ? cause
      : new CodexTurnCommandError({ operation, threadId, cause });

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

  const rollbackStart = (
    plan: CodexTurnStartPlan,
    state: {
      readonly launch: CodexTurnAuthorityLaunch | null;
      readonly optimisticAdmitted: boolean;
      readonly protocolCommitted: boolean;
    },
  ) =>
    Effect.gen(function* () {
      if (state.protocolCommitted) return;
      authority.abort(state.launch);
      if (!state.optimisticAdmitted) return;
      const observedAtMs = yield* Clock.currentTimeMillis;
      yield* projection.rejectTurn({
        threadId: plan.threadId,
        clientUserMessageId: plan.clientUserMessageId,
        failureItemId: randomUUID(),
        observedAtMs,
      });
      yield* projection
        .reconcileThreadStatus(plan.threadId)
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Failed to reconcile rejected Turn status").pipe(
              Effect.annotateLogs({ threadId: plan.threadId, cause: String(cause) }),
            ),
          ),
        );
    });

  const startTransaction = (
    plan: CodexTurnStartPlan,
    options: {
      readonly acceptAutomationRun: boolean;
      readonly projectOptimisticTurn: boolean;
    } = { acceptAutomationRun: true, projectOptimisticTurn: true },
  ) =>
    projectLifecycle.runExclusive(
      plan.projectId,
      Effect.gen(function* () {
        yield* assertProjectActive(plan);
        const canonicalParams = plan.canonicalParams;
        if (!plan.rendererOwnsState && (!canonicalParams || !plan.permissionContext)) {
          return yield* commandError(
            "start",
            plan.threadId,
            new Error("Main-owned Turn requires a hydrated canonical conversation"),
          );
        }

        const transaction: {
          launch: CodexTurnAuthorityLaunch | null;
          optimisticAdmitted: boolean;
          protocolCommitted: boolean;
        } = { launch: null, optimisticAdmitted: false, protocolCommitted: false };

        return yield* Effect.gen(function* () {
          if (!plan.rendererOwnsState && canonicalParams && plan.permissionContext) {
            yield* projection.configureTurn({
              threadId: plan.threadId,
              settings: plan.settings,
              permissions: plan.permissionContext,
            });
          }
          transaction.launch = yield* authority.begin(
            plan.threadId,
            plan.verifiedBuiltinFullAccess,
          );
          if (!plan.rendererOwnsState && canonicalParams && options.projectOptimisticTurn) {
            yield* projection.admitTurn({
              threadId: plan.threadId,
              params: canonicalParams,
              currentCollaborationModel: plan.currentCollaborationModel,
              startedAtMs: plan.startedAtMs,
              ...(plan.worktreeInit ? { worktreeInit: plan.worktreeInit } : {}),
            });
            transaction.optimisticAdmitted = true;
            yield* projection.markThreadActive(plan.threadId);
          }

          const response = (yield* gateway.requestForThread(
            plan.threadId,
            "turn/start",
            plan.request as GatewayTurnStartParams,
          )) as unknown as TurnStartResponse;

          yield* Effect.uninterruptible(
            Effect.sync(() => {
              transaction.protocolCommitted = true;
            }).pipe(
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
                !plan.rendererOwnsState && canonicalParams && options.projectOptimisticTurn
                  ? Clock.currentTimeMillis.pipe(
                      Effect.flatMap((observedAtMs) =>
                        projection.acceptTurn({
                          threadId: plan.threadId,
                          clientUserMessageId: plan.clientUserMessageId,
                          turn: response.turn,
                          recovery: {
                            params: canonicalParams,
                            currentCollaborationModel: plan.currentCollaborationModel,
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

          yield* projection
            .markThreadActive(plan.threadId)
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Turn accepted but secondary active projection failed").pipe(
                  Effect.annotateLogs({ threadId: plan.threadId, cause: String(cause) }),
                ),
              ),
            );
          if (plan.rendererOwnsState) return response;
          return {
            threadId: plan.threadId,
            turnId: response.turn.id,
            status: response.turn.status,
            itemIds: response.turn.items.map((item) => item.id),
          } satisfies CodexTurnSummary;
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? rollbackStart(plan, transaction) : Effect.void,
          ),
        );
      }),
    );

  const prepareStart = (
    threadId: string,
    prompt: string,
    overrides: CodexTurnStartOverrides | undefined,
    rendererOwnsState: boolean,
  ) =>
    preparation
      .start({
        threadId,
        prompt,
        ...(overrides ? { overrides } : {}),
        rendererOwnsState,
      })
      .pipe(Effect.mapError((cause) => commandError("start", threadId, cause)));

  const startInLane = (
    threadId: string,
    prompt: string,
    overrides: CodexTurnStartOverrides | undefined,
    rendererOwnsState: boolean,
    acceptAutomationRun = true,
  ) => {
    const execute = () =>
      prepareStart(threadId, prompt, overrides, rendererOwnsState).pipe(
        Effect.flatMap((plan) =>
          startTransaction(plan, { acceptAutomationRun, projectOptimisticTurn: true }),
        ),
      );
    if (rendererOwnsState) return execute();
    return materialization.ensure(threadId).pipe(
      Effect.mapError((cause) => commandError("start", threadId, cause)),
      Effect.andThen(execute()),
      Effect.catch((cause) => {
        if (!isThreadNotFound(cause)) return Effect.fail(cause);
        return Effect.logWarning("Turn start is rematerializing a missing app-server Thread").pipe(
          Effect.annotateLogs({ threadId }),
          Effect.andThen(materialization.reload(threadId)),
          Effect.andThen(execute()),
        );
      }),
    );
  };

  const start = (
    threadId: string,
    prompt: string,
    overrides: CodexTurnStartOverrides | undefined,
    rendererOwnsState: boolean,
    acceptAutomationRun = true,
  ) =>
    conversations.runCommand(
      threadId,
      startInLane(threadId, prompt, overrides, rendererOwnsState, acceptAutomationRun),
    );

  const steerInLane = (input: CodexSteerTurnInput) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const nonce = yield* Random.nextIntBetween(0, 36 ** 6);
      const intent =
        input.intent ??
        ({
          steerId: `steer:${input.threadId}:${now}:${nonce.toString(36).padStart(6, "0")}`,
          recoveryRow: {
            followUpId: `follow-up:${createUuidV7()}`,
            clientUserMessageId: randomUUID(),
            threadId: input.threadId,
            prompt: input.prompt,
            promptInput: input.promptInput ?? { text: input.prompt },
            createdAtMs: now,
            collaborationMode: input.collaborationMode ?? null,
            serviceTier: input.serviceTier ?? null,
            summary: input.summary ?? null,
            pause: null,
            payloadRef: null,
          },
        } as const);
      const plan = yield* preparation
        .steer({
          command: input,
          steerId: intent.steerId,
          recoveryRow: intent.recoveryRow,
        })
        .pipe(Effect.mapError((cause) => commandError("steer", input.threadId, cause)));
      return yield* runSteerTransaction(plan);
    });

  const runSteerTransaction = (plan: CodexTurnSteerPlan) => {
    let optimisticAdmitted = false;
    let targetTurnId = plan.expectedTurnId;
    const rollback = () =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((observedAtMs) =>
          optimisticAdmitted
            ? projection.rejectSteer({
                threadId: plan.threadId,
                turnId: targetTurnId,
                itemId: plan.steerId,
                observedAtMs,
              })
            : Effect.void,
        ),
      );
    const retarget = (nextTurnId: string) =>
      Effect.gen(function* () {
        if (nextTurnId === targetTurnId) return;
        const observedAtMs = yield* Clock.currentTimeMillis;
        yield* projection.retargetSteer({
          threadId: plan.threadId,
          fromTurnId: targetTurnId,
          toTurnId: nextTurnId,
          itemId: plan.steerId,
          observedAtMs,
        });
        targetTurnId = nextTurnId;
      });
    const request = (expectedTurnId: string) =>
      gateway.requestForThread(plan.threadId, "turn/steer", {
        ...plan.request,
        expectedTurnId,
      } as GatewayTurnSteerParams) as Effect.Effect<TurnSteerResponse, CodexRuntimeError>;
    return Effect.gen(function* () {
      const observedAtMs = yield* Clock.currentTimeMillis;
      yield* projection.admitSteer({
        threadId: plan.threadId,
        turnId: plan.expectedTurnId,
        item: plan.item,
        observedAtMs,
      });
      optimisticAdmitted = true;
      let response: TurnSteerResponse;
      const firstAttempt = yield* Effect.exit(request(targetTurnId));
      if (firstAttempt._tag === "Success") {
        response = firstAttempt.value;
      } else {
        const actualTurnId = parseSteerTurnMismatchActualTurnId(firstAttempt.cause);
        if (!actualTurnId || actualTurnId === targetTurnId) {
          return yield* Effect.failCause(firstAttempt.cause);
        }
        yield* retarget(actualTurnId);
        response = yield* request(actualTurnId);
      }
      if (typeof response.turnId !== "string") {
        yield* rollback();
        optimisticAdmitted = false;
        return null;
      }
      yield* retarget(response.turnId);
      return { turnId: response.turnId };
    }).pipe(
      Effect.catch((error) =>
        error._tag === "CodexRuntimeError" && error.reason === "outcome-unknown"
          ? Effect.succeed<CodexSteerTurnResult>({ turnId: targetTurnId, outcome: "unknown" })
          : Effect.fail(error),
      ),
      Effect.onExit((exit) => (Exit.isFailure(exit) ? rollback() : Effect.void)),
      Effect.catch((error) => {
        if (!plan.fallbackStart || !isSteerTurnInactive(error)) return Effect.fail(error);
        return rollback().pipe(
          Effect.andThen(
            startInLane(
              plan.threadId,
              plan.fallbackStart.prompt,
              plan.fallbackStart.overrides,
              false,
            ),
          ),
          Effect.map((started) =>
            started && "turnId" in started && typeof started.turnId === "string"
              ? { turnId: started.turnId }
              : null,
          ),
        );
      }),
      Effect.mapError((cause) =>
        cause instanceof Object && "_tag" in cause && cause._tag === "CodexRuntimeError"
          ? (cause as CodexRuntimeError)
          : commandError("steer", plan.threadId, cause),
      ),
    );
  };

  return CodexTurnCommands.of({
    start: (threadId, prompt, overrides) =>
      start(threadId, prompt, overrides, false).pipe(
        Effect.map((result) => result as CodexTurnSummary | null),
        Effect.mapError((cause) =>
          cause instanceof Object && "_tag" in cause && cause._tag === "CodexRuntimeError"
            ? (cause as CodexRuntimeError)
            : commandError("start", threadId, cause),
        ),
        Effect.withSpan("CodexTurnCommands.start", { attributes: { threadId } }),
      ),
    startRendererOwned: (threadId, prompt, overrides) =>
      start(threadId, prompt, overrides, true).pipe(
        Effect.map((result) => result as TurnStartResponse),
        Effect.mapError((cause) =>
          cause instanceof Object && "_tag" in cause && cause._tag === "CodexRuntimeError"
            ? (cause as CodexRuntimeError)
            : commandError("start", threadId, cause),
        ),
        Effect.withSpan("CodexTurnCommands.startRendererOwned", { attributes: { threadId } }),
      ),
    startAutomation: (threadId, prompt, overrides) =>
      start(threadId, prompt, overrides, false, false).pipe(
        Effect.map((result) => result as CodexTurnSummary | null),
        Effect.mapError((cause) =>
          cause instanceof Object && "_tag" in cause && cause._tag === "CodexRuntimeError"
            ? (cause as CodexRuntimeError)
            : commandError("start", threadId, cause),
        ),
        Effect.withSpan("CodexTurnCommands.startAutomation", { attributes: { threadId } }),
      ),
    acceptPreparedRendererTurn: (plan) =>
      conversations
        .runCommand(
          plan.threadId,
          startTransaction({
            ...plan,
            canonicalParams: null,
            currentCollaborationModel: "",
            settings: {} as CodexTurnStartPlan["settings"],
            permissionContext: null,
            rendererOwnsState: true,
            promptText: "",
          }),
        )
        .pipe(
          Effect.map((result) => result as TurnStartResponse),
          Effect.mapError((cause) =>
            cause instanceof Object && "_tag" in cause && cause._tag === "CodexRuntimeError"
              ? (cause as CodexRuntimeError)
              : commandError("start", plan.threadId, cause),
          ),
          Effect.withSpan("CodexTurnCommands.acceptPreparedRendererTurn", {
            attributes: { threadId: plan.threadId },
          }),
        ),
    steer: (input) =>
      conversations.runCommand(input.threadId, steerInLane(input)).pipe(
        Effect.withSpan("CodexTurnCommands.steer", {
          attributes: { threadId: input.threadId },
        }),
      ),
    continueGoal: (threadId) =>
      conversations
        .runCommand(
          threadId,
          materialization.ensure(threadId).pipe(
            Effect.mapError((cause) => commandError("start", threadId, cause)),
            Effect.andThen(prepareStart(threadId, "", undefined, false)),
            Effect.flatMap((plan) =>
              startTransaction(plan, {
                acceptAutomationRun: true,
                projectOptimisticTurn: false,
              }),
            ),
            Effect.asVoid,
          ),
        )
        .pipe(
          Effect.mapError((cause) => commandError("start", threadId, cause)),
          Effect.withSpan("CodexTurnCommands.continueGoal", { attributes: { threadId } }),
        ),
  });
});
