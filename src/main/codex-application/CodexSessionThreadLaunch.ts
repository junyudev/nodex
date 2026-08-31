import type { ThreadStartParams, ThreadStartResponse } from "@nodex/codex-app-server-protocol/v2";
import type { ClientRequestParamsByMethod } from "@nodex/effect-codex-app-server/rpc";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import { summarizeCodexPendingWorktreeLabel } from "../../shared/codex-pending-worktree";
import { createCodexTextUserInput } from "../../shared/codex-prompt-preparation";
import { createUuidV7 } from "../../shared/uuid-v7";
import type {
  CodexConversationSnapshot,
  CodexThreadDetail,
  CodexThreadStartForSessionInput,
  CodexThreadStartForSessionResult,
} from "../../shared/types";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway, codexGatewayGenerationFence } from "../codex-runtime/CodexGateway";
import type { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { allocateCodexPendingWorktreeRequest } from "../codex/codex-pending-worktree-request";
import { CoreModules } from "../core-runtime/CoreModules";
import { ProjectRuntimeLifecycleRuntime } from "../host-runtime/ProjectRuntimeLifecycleRuntime";
import { CodexAttachments } from "./CodexAttachments";
import { CodexFreshThreadLaunchRuntime } from "./CodexFreshThreadLaunchRuntime";
import { CodexPendingWorktreeRuntime } from "./CodexPendingWorktreeRuntime";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { CodexThreadLaunchCompletion } from "./CodexThreadLaunchCompletion";
import { ThreadCreationRuntime } from "./ThreadCreationRuntime";
import { CodexTurnCommands, type CodexTurnCommandsError } from "./CodexTurnCommands";
import { CodexTurnPreparation } from "./CodexTurnPreparation";

type GatewayThreadStartParams = ClientRequestParamsByMethod["thread/start"];

export interface CodexSessionThreadLaunchContext {
  readonly browserViewScopeId: string;
  readonly ownerClientId: string | null;
}

export class CodexSessionThreadLaunchError extends Data.TaggedError(
  "CodexSessionThreadLaunchError",
)<{
  readonly operation: "admit" | "pending" | "start" | "commit" | "first-turn";
  readonly sessionId: string;
  readonly cause: unknown;
}> {}

type CodexSessionThreadLaunchFailure =
  | CodexRuntimeError
  | CodexTurnCommandsError
  | CodexSessionThreadLaunchError;

export interface CodexSessionThreadLaunchService {
  readonly start: (
    input: CodexThreadStartForSessionInput,
    context: CodexSessionThreadLaunchContext,
  ) => Effect.Effect<CodexThreadStartForSessionResult, CodexSessionThreadLaunchFailure>;
}

export class CodexSessionThreadLaunch extends Context.Service<
  CodexSessionThreadLaunch,
  CodexSessionThreadLaunchService
>()("nodex/main/codex-application/CodexSessionThreadLaunch") {}

class SessionLaunchLane extends Context.Service<
  SessionLaunchLane,
  {
    readonly runExclusive: <A, E, R>(operation: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("nodex/main/codex-application/CodexSessionThreadLaunch/SessionLaunchLane") {}

const laneLayer = (_sessionId: string): Layer.Layer<SessionLaunchLane> =>
  Layer.effect(
    SessionLaunchLane,
    Semaphore.make(1).pipe(
      Effect.map((semaphore) =>
        SessionLaunchLane.of({
          runExclusive: (operation) => semaphore.withPermits(1)(operation),
        }),
      ),
    ),
  );

const detailFromSnapshot = (snapshot: CodexConversationSnapshot): CodexThreadDetail => ({
  ...snapshot,
  turns: snapshot.turns.map(({ items: _items, ...turn }) => turn),
  transcript: snapshot.turns.flatMap((turn) => turn.items),
});

export const make: Effect.Effect<
  CodexSessionThreadLaunch["Service"],
  never,
  | CodexFreshThreadLaunchRuntime
  | CodexAttachments
  | CodexAppServerCapabilities
  | CodexGateway
  | CodexPendingWorktreeRuntime
  | CodexThreadDirectory
  | CodexThreadLaunchCompletion
  | ThreadCreationRuntime
  | CodexTurnCommands
  | CodexTurnPreparation
  | CoreModules
  | ProjectRuntimeLifecycleRuntime
  | Scope.Scope
> = Effect.gen(function* () {
  const core = yield* CoreModules;
  const attachments = yield* CodexAttachments;
  const capabilities = yield* CodexAppServerCapabilities;
  const gateway = yield* CodexGateway;
  const projectLifecycle = yield* ProjectRuntimeLifecycleRuntime;
  const pendingWorktrees = yield* CodexPendingWorktreeRuntime;
  const directory = yield* CodexThreadDirectory;
  const turns = yield* CodexTurnCommands;
  const preparation = yield* CodexTurnPreparation;
  const freshLaunches = yield* CodexFreshThreadLaunchRuntime;
  const completion = yield* CodexThreadLaunchCompletion;
  const threadStarts = yield* ThreadCreationRuntime;
  const lanes = yield* LayerMap.make(laneLayer);

  const fail = (
    operation: CodexSessionThreadLaunchError["operation"],
    sessionId: string,
    cause: unknown,
  ) => new CodexSessionThreadLaunchError({ operation, sessionId, cause });

  const runExclusive = <A, E, R>(sessionId: string, operation: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      lanes
        .contextEffect(sessionId)
        .pipe(
          Effect.flatMap((context) =>
            Context.get(context, SessionLaunchLane).runExclusive(operation),
          ),
        ),
    );

  const admit = Effect.fn("CodexSessionThreadLaunch.admit")(function* (
    input: CodexThreadStartForSessionInput,
  ) {
    const response = yield* core.workspace
      .read({ kind: "session", session_id: input.sessionId })
      .pipe(Effect.mapError((cause) => fail("admit", input.sessionId, cause)));
    if (response.value.kind !== "session") {
      return yield* fail("admit", input.sessionId, new Error("Core returned a non-Session"));
    }
    const session = response.value.session;
    if ((session.project_id ?? null) !== input.projectId || session.thread_id) {
      return yield* fail(
        "admit",
        input.sessionId,
        new Error("Session ownership changed while starting its Thread"),
      );
    }
    if (!input.projectId) return null;
    const project = yield* core.workspace
      .read({ kind: "project", project_id: input.projectId }, undefined, input.projectId)
      .pipe(Effect.mapError((cause) => fail("admit", input.sessionId, cause)));
    if (project.value.kind !== "project" || project.value.project.lifecycle !== "active") {
      return yield* fail(
        "admit",
        input.sessionId,
        new Error("Threads cannot start for an inactive or removed Project"),
      );
    }
    return project.value.project;
  });

  const enqueuePending = (
    input: CodexThreadStartForSessionInput & { readonly projectId: string },
    sourceRoots: readonly string[],
  ): Effect.Effect<CodexThreadStartForSessionResult, CodexSessionThreadLaunchError> =>
    Effect.gen(function* () {
      const sourceWorkspaceRoot = sourceRoots[0]?.trim();
      if (!sourceWorkspaceRoot) throw new Error("Managed worktree requires a Project source root");
      const materializedGoal = input.threadGoalDraft
        ? yield* attachments.materializePastedText(input.threadGoalDraft.pastedTextAttachments)
        : null;
      const frozenGoal = input.threadGoalDraft
        ? {
            objective: input.threadGoalDraft.objective,
            pastedTextAttachments: materializedGoal?.attachments ?? [],
            imageAttachments: [...input.threadGoalDraft.imageAttachments],
          }
        : null;
      const allocated = allocateCodexPendingWorktreeRequest({
        hostId: gateway.localHostId,
        launchMode: "start-conversation",
        label: summarizeCodexPendingWorktreeLabel(input.prompt),
        initialThreadTitle: input.threadName ?? null,
        sourceWorkspaceRoot,
        startingState: input.worktreeStartingState ?? null,
        localEnvironmentConfigPath: input.runInEnvironmentPath ?? null,
        prompt: input.prompt,
        projectSessionId: input.sessionId,
        threadStartHostId: gateway.localHostId,
        threadGoalDraft: frozenGoal,
        heartbeatAutomation: input.heartbeatAutomation ?? null,
        sourceConversationId: null,
        sourceCollaborationMode: null,
        startConversationParamsInput: {
          input: [createCodexTextUserInput(input.prompt)],
          commentAttachments: input.promptInput?.commentAttachments ?? [],
          workspaceRoots: [...sourceRoots],
          cwd: sourceWorkspaceRoot,
          fileAttachments: [],
          addedFiles: [],
          agentMode: "auto",
          shouldSendPermissionOverrides: true,
          model: null,
          executionProfile: input.executionProfile ?? null,
          serviceTier: input.serviceTier ?? null,
          reasoningEffort: input.reasoningEffort ?? null,
          collaborationMode: null,
          config: {},
          threadSource:
            input.threadSource === "subagent" || input.threadSource === "system"
              ? input.threadSource
              : "user",
          workspaceKind: "project",
        },
      });
      if (!allocated.result.clientThreadId) {
        return yield* fail(
          "pending",
          input.sessionId,
          new Error("Conversation worktree allocation requires a client Thread identity"),
        );
      }
      yield* pendingWorktrees
        .create(allocated.request)
        .pipe(
          Effect.onError(() =>
            materializedGoal
              ? Effect.forEach(
                  materializedGoal.createdAttachmentPaths,
                  (attachmentPath) =>
                    attachments
                      .removePastedText({ path: attachmentPath, fsPath: attachmentPath, label: "" })
                      .pipe(Effect.ignore),
                  { discard: true },
                )
              : Effect.void,
          ),
        );
      return {
        kind: "pending" as const,
        pendingWorktreeId: allocated.result.pendingWorktreeId,
        clientThreadId: allocated.result.clientThreadId,
      };
    }).pipe(Effect.mapError((cause) => fail("pending", input.sessionId, cause)));

  const startImmediate = Effect.fn("CodexSessionThreadLaunch.startImmediate")(function* (
    input: CodexThreadStartForSessionInput,
    context: CodexSessionThreadLaunchContext,
    sourceRoots: readonly string[],
    capability: CodexAppServerCapabilitySnapshot,
  ): Effect.fn.Return<CodexThreadStartForSessionResult, CodexSessionThreadLaunchFailure> {
    const projectless = input.projectlessWorkspace;
    const workspaceRoots = projectless ? [projectless.workspaceRoot] : [...sourceRoots];
    const cwd = projectless?.cwd ?? workspaceRoots[0];
    if (!cwd) {
      return yield* fail(
        "start",
        input.sessionId,
        new Error("Thread launch requires a materialized workspace"),
      );
    }
    const executionProfile = input.executionProfile ?? null;
    const request: ThreadStartParams = {
      cwd,
      runtimeWorkspaceRoots: workspaceRoots,
      model: executionProfile?.modelId ?? input.model ?? null,
      modelProvider: executionProfile?.providerId ?? null,
      serviceTier: executionProfile?.serviceTier ?? input.serviceTier ?? null,
      baseInstructions: input.baseInstructions ?? null,
      developerInstructions: input.additionalDeveloperInstructions ?? null,
      threadSource: input.threadSource ?? "user",
      config: {
        ...(executionProfile?.harnessId ? { harness: executionProfile.harnessId } : {}),
        ...((executionProfile?.reasoningEffort ?? input.reasoningEffort)
          ? {
              model_reasoning_effort: executionProfile?.reasoningEffort ?? input.reasoningEffort,
            }
          : {}),
      },
    };
    let startedThreadId: string | null = null;
    let linked = false;
    return yield* Effect.gen(function* () {
      const response = (yield* gateway.requestLocal(
        "thread/start",
        request as GatewayThreadStartParams,
        codexGatewayGenerationFence(capability),
      )) as unknown as ThreadStartResponse;
      startedThreadId = response.thread.id;
      const entry = yield* directory
        .acceptSessionStart({
          response,
          sessionId: input.sessionId,
          projectId: input.projectId,
          executionProfile,
          runtimeWorkspaceRoots: workspaceRoots,
          fallbackCwd: cwd,
          projectlessOutputDirectory: projectless?.outputDirectory ?? null,
          projectlessWorkspaceBrowserRoot: projectless?.workspaceRoot ?? null,
        })
        .pipe(Effect.mapError((cause) => fail("commit", input.sessionId, cause)));
      linked = true;
      if (!entry.snapshot) {
        return yield* fail(
          "commit",
          input.sessionId,
          new Error("Thread has no canonical snapshot"),
        );
      }
      const outcome = {
        projectId: input.projectId,
        sessionId: input.sessionId,
        threadId: entry.summary.threadId,
        runInTarget: input.runInTarget ?? "localProject",
        startedAt: Date.now(),
        goalObjective:
          input.threadGoalMaterializedDraft?.objective.trim() ??
          input.threadGoalDraft?.objective.trim() ??
          "",
        rawGoalDraft: input.threadGoalDraft ?? null,
        heartbeatAutomation: input.heartbeatAutomation ?? null,
      };
      const detail = detailFromSnapshot(entry.snapshot);
      if (context.ownerClientId) {
        const plan = yield* preparation
          .start({
            threadId: entry.summary.threadId,
            prompt: input.prompt,
            overrides: {
              promptInput: input.promptInput,
              model: input.model,
              serviceTier: input.serviceTier,
              permissionMode: input.permissionMode,
              reasoningEffort: input.reasoningEffort,
              collaborationMode: input.collaborationMode,
            },
            rendererOwnsState: true,
          })
          .pipe(Effect.mapError((cause) => fail("first-turn", input.sessionId, cause)));
        if (!plan.canonicalParams) {
          return yield* fail(
            "first-turn",
            input.sessionId,
            new Error("Renderer-owned first Turn has no canonical parameters"),
          );
        }
        const freshLaunch = {
          ...outcome,
          launchId: createUuidV7(),
          rendererClientId: context.ownerClientId,
          clientUserMessageId: plan.clientUserMessageId,
          canonicalParams: plan.canonicalParams,
          turnStartParams: { ...plan.request, attachments: [] },
          verifiedBuiltinFullAccess: plan.verifiedBuiltinFullAccess,
        };
        freshLaunches.register(freshLaunch);
        return { kind: "started" as const, detail, freshLaunch };
      }
      const turn = yield* turns.start(entry.summary.threadId, input.prompt, {
        promptInput: input.promptInput,
        model: input.model,
        serviceTier: input.serviceTier,
        permissionMode: input.permissionMode,
        reasoningEffort: input.reasoningEffort,
        collaborationMode: input.collaborationMode,
      });
      if (!turn) {
        return yield* fail("first-turn", input.sessionId, new Error("Invalid first Turn"));
      }
      yield* completion.accepted(outcome);
      return { kind: "started" as const, detail };
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Effect.gen(function* () {
              completion.failed({
                projectId: input.projectId,
                sessionId: input.sessionId,
                threadId: startedThreadId ?? "",
                runInTarget: input.runInTarget ?? "localProject",
              });
              if (!startedThreadId || linked) return;
              yield* gateway
                .requestLocal(
                  "thread/delete",
                  { threadId: startedThreadId },
                  codexGatewayGenerationFence(capability),
                )
                .pipe(Effect.ignore);
            }),
      ),
    );
  });

  return CodexSessionThreadLaunch.of({
    start: (input, context) =>
      runExclusive(
        input.sessionId,
        projectLifecycle.runExclusive(
          input.projectId,
          Effect.gen(function* () {
            const project = yield* admit(input);
            const sourceRoots = project?.sources.map((source) => source.root) ?? [];
            if ((input.runInTarget ?? "localProject") === "newWorktree") {
              if (!input.projectId || !project) {
                return yield* fail(
                  "pending",
                  input.sessionId,
                  new Error("Projectless Threads cannot create managed worktrees"),
                );
              }
              return yield* enqueuePending({ ...input, projectId: input.projectId }, sourceRoots);
            }
            const capability = yield* capabilities.forHost(gateway.localHostId);
            return yield* threadStarts.materialize(
              capability.hostId,
              capability.generation,
              startImmediate(input, context, sourceRoots, capability),
              (result) => (result.kind === "started" ? result.detail.threadId : null),
            );
          }),
        ),
      ).pipe(
        Effect.withSpan("CodexSessionThreadLaunch.start", {
          attributes: { sessionId: input.sessionId },
        }),
      ),
  });
});
