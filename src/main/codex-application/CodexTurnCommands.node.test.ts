import { install as installMainActions } from "./CodexMainConversationActions";
import { CodexQueuedFollowUps } from "./CodexQueuedFollowUps";
import { CodexMainConversationEdit } from "./CodexMainConversationEdit";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexMainConversationInterrupt } from "./CodexMainConversationInterrupt";
import { CodexMainConversationSettings } from "./CodexMainConversationSettings";
import { CodexMainConversationHistory } from "./CodexMainConversationHistory";
import { CodexManualCompactionRuntime } from "./CodexManualCompactionRuntime";
import { CodexServerRequestResponses } from "./CodexServerRequestResponses";
import { conversationFixture, turnFixture } from "./conversation-test-fixture";
import { residentConversationTurns } from "../../shared/codex-conversation-state/codex-turn-mutation";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import {
  createEmptyCodexPreparedPrompt,
  prepareCodexPrompt,
} from "../../shared/codex-prompt-preparation";
import { CodexTurnPresentation } from "./CodexTurnPresentation";
import {
  makeTestTurnPresentation,
  testSubmitPresentation,
} from "./CodexTurnPresentation.test-support";
import type {
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
} from "@nodex/codex-app-server-protocol/v2";
import type {
  CodexCanonicalConversationState,
  CodexCanonicalSteeringUserMessageItem,
} from "../../shared/codex-conversation-state/codex-conversation-state";
import { produce } from "immer";
import { CodexTurnDeliveryError } from "../../shared/codex-conversation-state/codex-turn-delivery";
import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ScopedCallbackRuntime, layer as callbackLayer } from "../app/ScopedCallbackRuntime";
import {
  CodexGateway,
  CodexThreadHostResolver,
  type CodexGatewayRequestOptions,
} from "../codex-runtime/CodexGateway";
import { CodexMainConversationManagers } from "./CodexMainConversationManagers";
import { CodexMainConversationResume } from "./CodexMainConversationResume";
import {
  createCodexPeerFrameReader,
  encodeCodexPeerFrame,
} from "../platform/node/CodexPeerFraming";
import type { CodexPeerMessage } from "../../shared/codex-peer-protocol";
import type { ConversationFollowerTurnStart } from "../../shared/codex-thread-follower-request";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { CoreModules, type CoreModuleClients } from "../core-runtime/CoreModules";
import { ProjectRuntimeLifecycleRuntime } from "../host-runtime/ProjectRuntimeLifecycleRuntime";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { CodexAutomationRunAcceptance } from "./CodexAutomationRunAcceptance";
import { CodexAutoThreadTitle } from "./CodexAutoThreadTitle";
import { CodexConversationMaterialization } from "./CodexConversationMaterialization";
import { CodexConversationProjection } from "./CodexConversationProjection";
import { CodexTurnAuthority } from "./CodexTurnAuthority";
import { CodexTurnCommands, make, type CodexTurnCommandsService } from "./CodexTurnCommands";
import {
  CodexTurnPreparation,
  type CodexTurnStartPlan,
  type CodexTurnStartPreparationInput,
} from "./CodexTurnPreparation";
import {
  ConversationEntityMap,
  live as conversationRuntimeMapLive,
} from "./internal/ConversationEntityMap";

const response = (): TurnStartResponse =>
  ({
    turn: {
      id: "turn-accepted",
      status: "inProgress",
      items: [{ id: "item-user", type: "userMessage", content: [] }],
      itemsView: "full",
      error: null,
      startedAt: 1,
      completedAt: null,
      durationMs: null,
    },
  }) as unknown as TurnStartResponse;

const missingThread = () =>
  codexRuntimeError({
    operation: "gateway.request",
    reason: "request",
    retryable: false,
    hostId: "local",
    method: "turn/start",
    cause: new CodexAppServerRequestError({
      code: -32600,
      errorMessage: "thread not found: thread-a",
    }),
  });

const plan = (attempt: number): CodexTurnStartPlan =>
  ({
    threadId: "thread-a",
    projectId: null,
    request: { threadId: "thread-a", clientUserMessageId: `client-${attempt}`, input: [] },
    canonicalParams: { clientUserMessageId: `client-${attempt}` },
    model: "gpt-test",
    reasoningEffort: null,
    shouldUpdateReasoningEffort: true,
    collaborationMode: null,
    permissions: conversationFixture("thread-a").currentPermissions,
    clientUserMessageId: `client-${attempt}`,
    rendererOwnsState: false,
    verifiedBuiltinFullAccess: false,
    executionReadOnly: false,
    promptText: "ship",
    startedAtMs: attempt,
    pendingWorkspace: null,
    workspaceCommit: { writableRoots: null, revision: null, hadWorkspaceState: false },
  }) as unknown as CodexTurnStartPlan;

interface SteerFixture {
  readonly expectedTurnId: string;
  readonly request: TurnSteerParams;
  readonly item: CodexCanonicalSteeringUserMessageItem;
}

const makeHarness = (input: {
  readonly request: (
    attempt: number,
    options: CodexGatewayRequestOptions | undefined,
  ) => Effect.Effect<TurnStartResponse, ReturnType<typeof missingThread>>;
  readonly awaitSettings?: Effect.Effect<void>;
  readonly failAcceptedProjection?: boolean;
  readonly initialState?: CodexCanonicalConversationState;
  readonly preparedPlan?: CodexTurnStartPlan;
  readonly inject?: Effect.Effect<unknown, ReturnType<typeof missingThread>>;
  readonly ownerRecovering?: boolean;
  readonly discoveredOwner?: string;
  readonly appServerVersion?: string;
  readonly followerFailure?: string;
  readonly onSteerForward?: (input: unknown) => unknown;
  readonly onTitle?: () => Effect.Effect<void>;
  readonly onCaptured?: () => Effect.Effect<void>;
  readonly onManagerGet?: (count: number) => void;
  readonly beforeDispatch?: (method: string) => void;
  readonly steerPlan?: SteerFixture;
  readonly steerRequest?: (
    expectedTurnId: string,
    options: CodexGatewayRequestOptions | undefined,
  ) => Effect.Effect<TurnSteerResponse, ReturnType<typeof missingThread>>;
}) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const presentation = yield* makeTestTurnPresentation.pipe(
      Effect.provideService(Scope.Scope, scope),
    );
    const events: string[] = [];
    const forwarded: ConversationFollowerTurnStart[] = [];
    const dispatchFences: Array<{
      method: string;
      options: CodexGatewayRequestOptions | undefined;
    }> = [];
    const configReads: Array<{ includeLayers: boolean; cwd: string | null }> = [];
    const preparationInputs: CodexTurnStartPreparationInput[] = [];
    const callbacks = Context.get(
      yield* Layer.buildWithScope(callbackLayer, scope),
      ScopedCallbackRuntime,
    );
    let requests = 0;
    let preparations = 0;
    let ownsState = true;
    let hasRole = true;
    let ownerRole = { role: "owner" } as const;
    let followerRole: {
      readonly role: "follower";
      readonly ownerClientId: string;
    } = { role: "follower", ownerClientId: "renderer-owner" };
    let alive = true;
    let generation = 1;
    let managerGets = 0;
    const resetCallbacks = new Set<() => void>();
    const disposeCallbacks = new Set<() => void>();
    const register = (callbacks: Set<() => void>, callback: () => void) => {
      callbacks.add(callback);
      return {
        [Symbol.dispose]: () => {
          callbacks.delete(callback);
        },
      };
    };
    const assertCurrent = (nativeGeneration?: number) => {
      if (!alive) throw new Error("retired");
      if (nativeGeneration !== undefined && nativeGeneration !== generation)
        throw new Error("Native conversation connection retired");
    };
    const gateway = CodexGateway.of({
      localHostId: "local",
      requestRawOnHost: () => Effect.die("unused"),
      requestOnHost: ((_hostId: string, method: string, params: unknown) => {
        if (method !== "config/read") return Effect.die(`unexpected host method: ${method}`);
        const input = params as { includeLayers: boolean; cwd: string | null };
        configReads.push(input);
        return Effect.succeed({
          config: {
            sandbox_mode: "workspace-write",
            sandbox_workspace_write: {
              writable_roots: ["/configured"],
              network_access: true,
              exclude_tmpdir_env_var: false,
              exclude_slash_tmp: true,
            },
            approval_policy: "on-request",
            approvals_reviewer: "user",
          },
        });
      }) as CodexGateway["Service"]["requestOnHost"],
      requestForThread: ((
        _threadId: string,
        method: string,
        params: { expectedTurnId?: string },
        options: CodexGatewayRequestOptions | undefined,
      ) =>
        Effect.suspend(() => {
          dispatchFences.push({ method, options });
          input.beforeDispatch?.(method);
          if (options?.expectedHostId !== "local" || options.expectedGeneration !== generation)
            return Effect.fail(
              codexRuntimeError({
                operation: "gateway.generation-fence",
                reason: "session-lost",
                retryable: true,
                hostId: "local",
                generation,
                method,
              }),
            );
          if (method === "turn/steer" && input.steerRequest) {
            events.push(`steer:${params.expectedTurnId}`);
            return input.steerRequest(params.expectedTurnId!, options);
          }
          if (method === "thread/inject_items") {
            events.push("inject");
            return input.inject ?? Effect.succeed({});
          }
          if (method !== "turn/start") return Effect.die(`unexpected method: ${method}`);
          requests += 1;
          events.push(`request:${requests}`);
          return input.request(requests, options);
        })) as CodexGateway["Service"]["requestForThread"],
    } as unknown as CodexGateway["Service"]);
    const materialization = CodexConversationMaterialization.of({
      ensure: () => Effect.sync(() => events.push("ensure")),
      reload: () => Effect.sync(() => events.push("reload")),
    });
    const onTitle = input.onTitle;
    const preparation = CodexTurnPreparation.of({
      prepareCaptured: (_threadId, _submissionId, prompt, promptInput) =>
        Effect.promise(() =>
          prepareCodexPrompt(prompt, promptInput, {
            resolveImageInput: (source) => ({ type: "image", url: source }),
          }),
        ).pipe(Effect.tap(() => input.onCaptured?.() ?? Effect.void)),
      start: (preparationInput) =>
        Effect.sync(() => {
          preparationInputs.push(preparationInput);
          preparations += 1;
          events.push(`prepare:${preparations}`);
          const prepared = input.preparedPlan ?? plan(preparations);
          const clientUserMessageId =
            preparationInput.overrides?.clientUserMessageId ?? prepared.clientUserMessageId;
          return {
            ...prepared,
            clientUserMessageId,
            request: { ...prepared.request, clientUserMessageId },
            canonicalParams: prepared.canonicalParams
              ? { ...prepared.canonicalParams, clientUserMessageId }
              : null,
            rendererOwnsState: preparationInput.rendererOwnsState,
            isFirstTurn: onTitle !== undefined,
            presentationClaim: preparationInput.overrides?.presentationClaim,
          };
        }),
      steer: ({ command }) => {
        const fixture = input.steerPlan;
        if (!fixture) return Effect.die("unused");
        return Effect.succeed({
          conversationId: fixture.request.threadId,
          clientUserMessageId: fixture.request.clientUserMessageId!,
          input: fixture.request.input,
          restoreMessage: fixture.item.restoreMessage,
          attachments: fixture.item.attachments,
          additionalContext: fixture.request.additionalContext,
          ...(command.serviceTier !== undefined ? { serviceTier: command.serviceTier } : {}),
        });
      },
    });
    const projection = CodexConversationProjection.of({
      configureTurn: (
        value: Parameters<CodexConversationProjection["Service"]["configureTurn"]>[0],
      ) =>
        Effect.sync(() => {
          events.push("configure");
          if (input.initialState) aggregate.applyTurnConfiguration(value);
        }),
      admitTurn: (value: Parameters<CodexConversationProjection["Service"]["admitTurn"]>[0]) =>
        Effect.sync(() => {
          events.push("admit");
          if (input.initialState) aggregate.admitOptimisticTurn(value);
        }),
      acceptTurn: (value: Parameters<CodexConversationProjection["Service"]["acceptTurn"]>[0]) =>
        input.failAcceptedProjection
          ? Effect.fail({ _tag: "projection-failed" } as never)
          : Effect.sync(() => {
              events.push("accept");
              if (input.initialState) aggregate.acceptOptimisticTurn(value);
            }),
      rejectTurn: (value: Parameters<CodexConversationProjection["Service"]["rejectTurn"]>[0]) =>
        Effect.sync(() => {
          events.push("reject");
          if (input.initialState) aggregate.rejectOptimisticTurn(value);
        }),
      reconcileThreadStatus: () => Effect.sync(() => events.push("idle")),
    } as unknown as CodexConversationProjection["Service"]);
    const authority = CodexTurnAuthority.of({
      begin: () => Effect.sync(() => (events.push("authority:begin"), null)),
      bind: () => Effect.sync(() => events.push("authority:bind")),
      observeStarted: () => Effect.die("unused"),
      capture: () => Effect.die("unused"),
      inherit: () => Effect.die("unused"),
      abort: () => events.push("authority:abort"),
    });
    const automation = CodexAutomationRunAcceptance.of({
      accept: () => Effect.sync(() => (events.push("automation:accept"), true)),
    });
    const conversationsContext = yield* Layer.buildWithScope(conversationRuntimeMapLive, scope);
    const conversations = Context.get(conversationsContext, ConversationEntityMap);
    const aggregate = conversations.entity("thread-a");
    if (input.initialState) aggregate.acceptCanonicalState(input.initialState);
    aggregate.installQueuedFollowUpProjection({
      status: "ready",
      ledgerRevision: 1,
      projectionRevision: 1,
      entries: [
        {
          followUpId: "follow-up:paused",
          clientUserMessageId: "client-follow-up-paused",
          threadId: "thread-a",
          prompt: "later",
          promptInput: { text: "later" },
          createdAtMs: 1,
          collaborationMode: null,
          serviceTier: null,
          summary: null,
          pause: { kind: "failed", reason: "wait" },
        },
      ],
      inFlightFollowUpId: null,
      editingFollowUpId: null,
      error: null,
    });
    const projectLifecycle = ProjectRuntimeLifecycleRuntime.of({
      runExclusive: (_projectId, operation) => operation,
    });
    const workspace = ProjectWorkspace.of({
      replaceThreadWritableRoots: () => Effect.void,
      mergeThreadWritableRoots: () => Effect.void,
      commitThreadWorkspaceTransition: () => Effect.void,
      readThreadExecutionContext: () =>
        Effect.succeed({
          thread: {} as never,
          projectId: null,
          project: null,
          permissionMode: null,
          workspaceState: null,
        }),
    } as unknown as ProjectWorkspace["Service"]);
    const core = CoreModules.of({
      workspace: {
        read: () => Effect.die("unused"),
        apply: () => Effect.die("unused"),
      },
    } as unknown as CoreModuleClients);
    let actionHandler:
      | Parameters<CodexMainConversationManagers["Service"]["registerFollowerHandler"]>[0]
      | undefined;
    const managers = {
      registerFollowerHandler: (
        handler: Parameters<CodexMainConversationManagers["Service"]["registerFollowerHandler"]>[0],
      ) => {
        actionHandler = handler;
        return {
          [Symbol.dispose]: () => {
            actionHandler = undefined;
          },
        };
      },
      dispatchFollowerRequest: (
        hostId: string,
        request: Parameters<CodexMainConversationManagers["Service"]["dispatchFollowerRequest"]>[1],
      ) =>
        actionHandler ? actionHandler(hostId, request) : Effect.die("Main actions not installed"),
      get: () =>
        Effect.sync(() => {
          input.onManagerGet?.(++managerGets);
          return {
            hostId: "local",
            get generation() {
              return generation;
            },
            assertCurrent,
            findOwner: () => Promise.resolve(input.discoveredOwner ?? "renderer-owner"),
            onDispose: (callback: () => void) => register(disposeCallbacks, callback),
            onConnectionReset: (callback: () => void) => register(resetCallbacks, callback),
            coordination: {
              requestThreadFollower: async ({
                request,
                targetClientId,
              }: {
                request: { params: { turnStart: ConversationFollowerTurnStart } };
                targetClientId: string;
              }) => {
                if ("clientUserMessageId" in request.params) {
                  if (input.followerFailure) throw new Error(input.followerFailure);
                  return {
                    resultType: "success",
                    result: input.onSteerForward?.(request.params) ?? {
                      result: { turnId: "owner-turn" },
                    },
                  };
                }
                const operation = JSON.parse(
                  JSON.stringify(request.params.turnStart),
                ) as ConversationFollowerTurnStart;
                forwarded.push(operation);
                if (input.followerFailure) throw new Error(input.followerFailure);
                const prepared = await callbacks.runPromise(
                  commands.inspectPreparedNativeStart(operation, targetClientId),
                );
                const result = await callbacks.runPromise(
                  commands.executePreparedNativeStart(prepared.request, targetClientId),
                );
                return { resultType: "success", result: { result } };
              },
            },
            stream: {
              getRole: () => (!hasRole ? null : ownsState ? ownerRole : followerRole),
              setRole: (
                _threadId: string,
                role:
                  | { readonly role: "owner" }
                  | { readonly role: "follower"; readonly ownerClientId: string }
                  | null,
              ) => {
                if (!role) {
                  hasRole = false;
                  return;
                }
                hasRole = true;
                ownsState = role.role === "owner";
                if (role.role === "owner") ownerRole = role;
                else followerRole = role;
              },
              removeConversation: () => {
                hasRole = false;
              },
              setFollowing: () => {},
              waitForRevision: () => Promise.resolve(),
            },
          };
        }),
    } as unknown as CodexMainConversationManagers["Service"];
    if (input.steerPlan)
      aggregate.acceptCanonicalState(
        conversationFixture("thread-a", [
          turnFixture(input.steerPlan.expectedTurnId, "inProgress"),
        ]),
      );
    const commands: CodexTurnCommandsService = yield* make.pipe(
      Effect.provideService(CodexAutomationRunAcceptance, automation),
      Effect.provideService(
        CodexAutoThreadTitle,
        CodexAutoThreadTitle.of({
          scheduleFirstTurn: () => onTitle?.() ?? Effect.void,
          scheduleAddedThread: () => Effect.void,
        }),
      ),
      Effect.provideService(CodexConversationMaterialization, materialization),
      Effect.provideService(CodexMainConversationResume, {
        resume: () =>
          Effect.sync(() => {
            events.push("ensure");
            if (input.ownerRecovering)
              return { status: "not-ready", reason: "owner-recovering" } as const;
            if (!hasRole) {
              ownsState = true;
              hasRole = true;
              ownerRole = { role: "owner" };
            }
            return { status: "ready", snapshot: null } as const;
          }),
      }),
      Effect.provideService(CodexConversationProjection, projection),
      Effect.provideService(CodexMainConversationSettings, {
        awaitCurrent: () => input.awaitSettings ?? Effect.void,
        update: () => Effect.die("unused"),
      }),
      Effect.provideService(CodexGateway, gateway),
      Effect.provideService(CodexAppServerCapabilities, {
        forHost: () =>
          Effect.succeed(
            createCodexAppServerCapabilitySnapshot({
              hostId: "local",
              generation,
              userAgent: `Codex/${input.appServerVersion ?? "0.0.0"}`,
            }),
          ),
      } as unknown as CodexAppServerCapabilities["Service"]),
      Effect.provideService(CodexThreadHostResolver, { resolve: () => Effect.succeed("local") }),
      Effect.provideService(CodexMainConversationManagers, managers),
      Effect.provideService(CodexTurnAuthority, authority),
      Effect.provideService(CodexTurnPreparation, preparation),
      Effect.provideService(CodexTurnPresentation, presentation),
      Effect.provideService(ConversationEntityMap, conversations),
      Effect.provideService(CoreModules, core),
      Effect.provideService(ProjectWorkspace, workspace),
      Effect.provideService(ProjectRuntimeLifecycleRuntime, projectLifecycle),
      Effect.provideService(Scope.Scope, scope),
    );
    yield* installMainActions.pipe(
      Effect.provideService(CodexMainConversationManagers, managers),
      Effect.provideService(CodexTurnCommands, commands),
      Effect.provideService(ConversationEntityMap, conversations),
      Effect.provideService(ScopedCallbackRuntime, callbacks),
      Effect.provideService(CodexApplicationEventHub, {
        publish: () => {},
      } as unknown as CodexApplicationEventHub["Service"]),
      Effect.provideService(CodexQueuedFollowUps, {} as CodexQueuedFollowUps["Service"]),
      Effect.provideService(CodexMainConversationEdit, {} as CodexMainConversationEdit["Service"]),
      Effect.provideService(
        CodexMainConversationInterrupt,
        {} as CodexMainConversationInterrupt["Service"],
      ),
      Effect.provideService(
        CodexMainConversationSettings,
        {} as CodexMainConversationSettings["Service"],
      ),
      Effect.provideService(
        CodexMainConversationHistory,
        {} as CodexMainConversationHistory["Service"],
      ),
      Effect.provideService(
        CodexManualCompactionRuntime,
        {} as CodexManualCompactionRuntime["Service"],
      ),
      Effect.provideService(
        CodexServerRequestResponses,
        {} as CodexServerRequestResponses["Service"],
      ),
      Effect.provideService(Scope.Scope, scope),
    );
    return {
      presentation,
      aggregate,
      commands,
      events,
      forwarded,
      dispatchFences,
      configReads,
      preparationInputs,
      resetListenerCount: () => resetCallbacks.size,
      requests: () => requests,
      scope,
      changeOwner: () => {
        ownsState = !ownsState;
        if (ownsState) ownerRole = { role: "owner" };
        else followerRole = { role: "follower", ownerClientId: "renderer-owner" };
      },
      clearRole: () => {
        hasRole = false;
      },
      retire: () => {
        alive = false;
        for (const callback of [...disposeCallbacks, ...resetCallbacks]) callback();
      },
      reconnect: () => {
        // The same peer has recovered its role before the old action continues.
        generation += 1;
        for (const callback of [...resetCallbacks]) callback();
      },
      replaceEntity: () =>
        Effect.gen(function* () {
          yield* conversations.retire("thread-a");
          conversations
            .entity("thread-a")
            .acceptCanonicalState(
              conversationFixture("thread-a", [turnFixture("replacement-turn", "inProgress")]),
            );
        }),
    };
  });

const executionStateFixture = (hadPermissions = true) => {
  const base = conversationFixture("thread-a");
  const initialState = produce(base, (draft) => {
    draft.latestModel = "retained-model";
    draft.latestReasoningEffort = "high";
    draft.latestThreadSettings = {
      model: "next-turn-model",
      effort: "high",
      collaborationMode: base.latestCollaborationMode,
      personality: "pragmatic",
    };
    if (!hadPermissions) delete draft.currentPermissions;
  });
  const preparedPlan: CodexTurnStartPlan = {
    ...plan(1),
    canonicalParams: {
      ...conversationFixture("thread-a", [turnFixture("seed")]).turns[0]!.params,
      clientUserMessageId: "prepared-client",
      permissions: null,
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      runtimeWorkspaceRoots: [],
      useAppServerPermissionDefault: false,
      attachments: [],
      commentAttachments: [],
    },
    model: null,
    reasoningEffort: null,
    shouldUpdateReasoningEffort: true,
    collaborationMode: {
      mode: "plan",
      settings: {
        model: "single-turn-model",
        reasoning_effort: "low",
        developer_instructions: "Plan only",
      },
    },
    permissions: {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
    },
    previousPermissions: initialState.currentPermissions,
  };
  return { initialState, preparedPlan };
};

for (const hadPermissions of [true, false])
  for (const outcome of ["accepted", "rejected", "partial", "assigned"] as const) {
    it.effect(
      `Main ${outcome} preserves execution metadata and permission presence: ${hadPermissions}`,
      () =>
        Effect.gen(function* () {
          const fixture = executionStateFixture(hadPermissions);
          let nativeStatus: CodexCanonicalConversationState["threadRuntimeStatus"] | undefined;
          const harness = yield* makeHarness({
            ...fixture,
            request: () =>
              Effect.gen(function* () {
                const pending = harness.aggregate.readCanonicalState()!;
                assert.strictEqual(pending.latestModel, fixture.initialState.latestModel);
                assert.strictEqual(pending.latestReasoningEffort, null);
                assert.deepEqual(
                  pending.latestCollaborationMode,
                  fixture.preparedPlan.collaborationMode,
                );
                assert.deepEqual(
                  pending.latestThreadSettings,
                  fixture.initialState.latestThreadSettings,
                );
                assert.deepEqual(pending.currentPermissions, fixture.preparedPlan.permissions);
                if (outcome === "accepted") {
                  harness.aggregate.mutateCanonicalState((draft) => {
                    draft.threadRuntimeStatus = { type: "idle" };
                  }, 10);
                  nativeStatus = harness.aggregate.readCanonicalState()!.threadRuntimeStatus;
                  return { turn: { ...response().turn, status: "completed" } };
                }
                if (outcome === "partial" || outcome === "assigned") {
                  harness.aggregate.mutateCanonicalState((draft) => {
                    const turn = draft.turns[0]!;
                    turn.items.push({
                      type: "agentMessage",
                      id: "partial",
                      text: "Observed content",
                      phase: "commentary",
                      delivery: null,
                      memoryCitation: null,
                      questions: null,
                    });
                    if (outcome === "assigned") turn.turnId = "assigned-turn";
                    draft.threadRuntimeStatus = { type: "active", activeFlags: [] };
                  }, 10);
                  nativeStatus = harness.aggregate.readCanonicalState()!.threadRuntimeStatus;
                }
                return yield* codexRuntimeError({
                  operation: "gateway.request",
                  reason: "request",
                  retryable: false,
                  cause: new Error("Actual native rejection"),
                });
              }),
          });
          const result = yield* harness.commands.start("thread-a", "ship").pipe(Effect.result);
          const state = harness.aggregate.readCanonicalState()!;
          assert.strictEqual(result._tag, outcome === "accepted" ? "Success" : "Failure");
          assert.strictEqual(state.latestModel, fixture.initialState.latestModel);
          assert.strictEqual(state.latestReasoningEffort, null);
          assert.deepEqual(state.latestCollaborationMode, fixture.preparedPlan.collaborationMode);
          assert.deepEqual(state.latestThreadSettings, fixture.initialState.latestThreadSettings);
          assert.deepEqual(
            state.currentPermissions,
            outcome === "accepted"
              ? fixture.preparedPlan.permissions
              : fixture.initialState.currentPermissions,
          );
          assert.strictEqual(
            Object.hasOwn(state, "currentPermissions"),
            outcome === "accepted" || hadPermissions,
          );
          if (nativeStatus) assert.strictEqual(state.threadRuntimeStatus, nativeStatus);
          if (outcome === "rejected") {
            assert.deepEqual(residentConversationTurns(state), []);
            assert.strictEqual(state.threadRuntimeStatus.type, "idle");
          }
          if (outcome === "partial")
            assert.strictEqual(state.turns[0]?.error?.message, "Actual native rejection");
          if (outcome === "assigned") {
            assert.strictEqual(state.turns[0]?.status, "inProgress");
            assert.strictEqual(state.turns[0]?.error, null);
          }
          yield* Scope.close(harness.scope, Exit.void);
        }),
    );
  }

it.effect("accepted Main Turn cannot overwrite a newer live environment selection", () =>
  Effect.gen(function* () {
    const fixture = executionStateFixture();
    const initialState = produce(fixture.initialState, (draft) => {
      draft.environments = [{ environmentId: "old", cwd: "/old", runtimeWorkspaceRoots: ["/old"] }];
      draft.environmentSelectionEvidence = { source: "live", updatedAt: 10 };
    });
    const preparedPlan: CodexTurnStartPlan = {
      ...fixture.preparedPlan,
      environments: [
        {
          environmentId: "prepared",
          cwd: "/prepared",
          runtimeWorkspaceRoots: ["/prepared"],
        },
      ],
    };
    const harness = yield* makeHarness({
      initialState,
      preparedPlan,
      request: () =>
        Effect.sync(() => {
          harness.aggregate.mutateCanonicalState((draft) => {
            draft.environments = [
              { environmentId: "newer", cwd: "/newer", runtimeWorkspaceRoots: ["/newer"] },
            ];
            draft.environmentSelectionEvidence = { source: "live", updatedAt: 12 };
          }, 12_000);
          return response();
        }),
    });

    yield* harness.commands.start("thread-a", "ship");
    assert.deepEqual(harness.aggregate.readCanonicalState()?.environments, [
      { environmentId: "newer", cwd: "/newer", runtimeWorkspaceRoots: ["/newer"] },
    ]);
    assert.deepEqual(harness.aggregate.readCanonicalState()?.environmentSelectionEvidence, {
      source: "live",
      updatedAt: 12,
    });
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

it.effect("Main waits for its owner settings before materializing execution", () =>
  Effect.gen(function* () {
    const waiting = yield* Deferred.make<void>();
    const settings = yield* Deferred.make<void>();
    const harness = yield* makeHarness({
      ...executionStateFixture(),
      request: () => Effect.succeed(response()),
      awaitSettings: Deferred.succeed(waiting, undefined).pipe(
        Effect.andThen(Deferred.await(settings)),
      ),
    });
    const pending = yield* harness.commands.start("thread-a", "ship").pipe(Effect.forkScoped);
    yield* Deferred.await(waiting);
    assert.strictEqual(harness.requests(), 0);
    assert.isFalse(harness.events.some((event) => event.startsWith("prepare:")));
    yield* Deferred.succeed(settings, undefined);
    yield* Fiber.join(pending);
    assert.strictEqual(harness.requests(), 1);
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

it.effect("Main retained delivery fences duplicate submission until the actual response", () =>
  Effect.gen(function* () {
    const fixture = executionStateFixture();
    const reply = yield* Deferred.make<TurnStartResponse>();
    const uncertainRecorded = yield* Deferred.make<void>();
    const delivery = {
      requestId: "turn/start:real-transport-id",
      method: "turn/start",
      stage: "outcome-unknown",
    } as const;
    const harness = yield* makeHarness({
      ...fixture,
      request: (_attempt, options) =>
        Effect.gen(function* () {
          yield* options!.onOutcomeUnknown!(delivery);
          yield* Deferred.succeed(uncertainRecorded, undefined);
          return yield* Deferred.await(reply);
        }),
    });
    const pending = yield* harness.commands.start("thread-a", "ship").pipe(Effect.forkScoped);
    yield* Deferred.await(uncertainRecorded);
    const uncertain = harness.aggregate.readCanonicalState()!;
    assert.strictEqual(uncertain.unconfirmedTurnSubmissions?.[0]?.requestId, delivery.requestId);
    assert.strictEqual(uncertain.turns[0]?.status, "inProgress");
    const duplicate = yield* harness.commands.start("thread-a", "duplicate").pipe(Effect.result);
    assert.strictEqual(duplicate._tag, "Failure");
    assert.strictEqual(harness.requests(), 1);
    yield* Deferred.succeed(reply, response());
    yield* Fiber.join(pending);
    assert.isUndefined(harness.aggregate.readCanonicalState()?.unconfirmedTurnSubmissions);
    assert.strictEqual(
      harness.aggregate.readCanonicalState()?.turns[0]?.turnId,
      response().turn.id,
    );
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

it.effect(
  "Main uncertain context injection terminalizes its placeholder without sending a Turn",
  () =>
    Effect.gen(function* () {
      const fixture = executionStateFixture(false);
      const delivery = {
        requestId: "thread/inject_items:real-transport-id",
        method: "thread/inject_items",
        stage: "outcome-unknown",
      } as const;
      const harness = yield* makeHarness({
        ...fixture,
        request: () => Effect.succeed(response()),
        inject: Effect.fail(
          codexRuntimeError({
            operation: "scheduler.execution",
            reason: "outcome-unknown",
            retryable: false,
            cause: new CodexTurnDeliveryError("Context injection timed out", delivery),
          }),
        ),
      });
      const prepared = yield* harness.commands.prepareNativeStart(
        "thread-a",
        "ship",
        undefined,
        undefined,
        {
          responseItems: [{ type: "message", role: "user", content: [] }],
        },
      );
      const inspected = yield* harness.commands.inspectPreparedNativeStart(prepared);
      const result = yield* harness.commands
        .executePreparedNativeStart(inspected.request)
        .pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(harness.requests(), 0);
      const state = harness.aggregate.readCanonicalState()!;
      assert.strictEqual(state.turns[0]?.status, "failed");
      assert.strictEqual(state.turns[0]?.error?.message, "Context injection timed out");
      assert.strictEqual(state.threadRuntimeStatus.type, "idle");
      assert.isFalse(Object.hasOwn(state, "currentPermissions"));
      assert.deepEqual(state.unconfirmedTurnSubmissions, [
        {
          ...delivery,
          clientUserMessageId: inspected.request.clientUserMessageId!,
          terminal: true,
        },
      ]);
      harness.commands.releasePreparedNativeStart(prepared.request.clientUserMessageId!);
      yield* Scope.close(harness.scope, Exit.void);
    }),
);

it.effect("rematerializes once after thread-not-found and retries a fresh transaction", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      request: (attempt) =>
        attempt === 1 ? Effect.fail(missingThread()) : Effect.succeed(response()),
    });

    const result = yield* harness.commands.start("thread-a", "ship");

    assert.strictEqual(result?.turnId, "turn-accepted");
    assert.strictEqual(harness.requests(), 2);
    assert.deepEqual(harness.events, [
      "ensure",
      "prepare:1",
      "authority:begin",
      "admit",
      "request:1",
      "authority:abort",
      "reject",
      "reload",
      "prepare:2",
      "authority:begin",
      "admit",
      "request:2",
      "authority:bind",
      "accept",
      "automation:accept",
    ]);
    assert.deepEqual(harness.aggregate.readQueuedFollowUpProjection().entries[0]?.pause, {
      kind: "failed",
      reason: "wait",
    });
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

it.effect("returns the accepted protocol outcome when a secondary projection fails", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      request: () => Effect.succeed(response()),
      failAcceptedProjection: true,
    });

    const result = yield* harness.commands.start("thread-a", "ship");

    assert.deepEqual(result, {
      threadId: "thread-a",
      turnId: "turn-accepted",
      status: "inProgress",
      itemIds: ["item-user"],
    });
    assert.isTrue(harness.events.includes("automation:accept"));
    assert.isFalse(harness.events.includes("reject"));
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

it.effect("starts a system Automation turn without accepting its inbox run", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      request: () => Effect.succeed(response()),
    });

    const result = yield* harness.commands.startAutomation("thread-a", "ship");

    assert.strictEqual(result?.turnId, "turn-accepted");
    assert.isFalse(harness.events.includes("automation:accept"));
    assert.isTrue(harness.events.includes("accept"));
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

it.effect("adopts an exact fresh native Thread before the first Main Turn", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      initialState: conversationFixture("thread-a"),
      request: () => Effect.succeed(response()),
    });
    harness.clearRole();

    const result = yield* harness.commands.start("thread-a", "ship", {
      freshNativeThread: { hostId: "local", generation: 1 },
    });

    assert.strictEqual(result?.turnId, "turn-accepted");
    assert.strictEqual(harness.requests(), 1);
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

it.effect("rejects a fresh native Thread from a retired generation", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      initialState: conversationFixture("thread-a"),
      request: () => Effect.succeed(response()),
    });
    harness.clearRole();

    const result = yield* harness.commands
      .start("thread-a", "ship", {
        freshNativeThread: { hostId: "local", generation: 2 },
      })
      .pipe(Effect.result);

    assert.strictEqual(result._tag, "Failure");
    assert.strictEqual(harness.requests(), 0);
    assert.deepEqual(harness.events, []);
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

for (const entrypoint of ["start", "startAutomation"] as const) {
  it.effect(`defers Main ${entrypoint} before preparation while the owner is recovering`, () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        ownerRecovering: true,
        request: () => Effect.succeed(response()),
      });
      const result = yield* harness.commands[entrypoint]("thread-a", "ship").pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.deepEqual(harness.events, ["ensure"]);
      yield* Scope.close(harness.scope, Exit.void);
    }),
  );
  it.effect(`routes Main ${entrypoint} through the window owner with one native execution`, () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ request: () => Effect.succeed(response()) });
      harness.changeOwner();
      const result = yield* harness.commands[entrypoint]("thread-a", "ship", {
        model: "gpt-selected",
        reasoningEffort: "high",
        serviceTier: null,
      });
      assert.strictEqual(result?.turnId, "turn-accepted");
      assert.strictEqual(harness.forwarded.length, 1);
      assert.deepEqual(harness.forwarded[0]?.request.input, [
        { type: "text", text: "ship", text_elements: [] },
      ]);
      assert.strictEqual(harness.forwarded[0]?.request.model, "gpt-selected");
      assert.strictEqual(harness.forwarded[0]?.request.effort, "high");
      assert.strictEqual(harness.forwarded[0]?.request.serviceTier, null);
      assert.strictEqual(harness.requests(), 1);
      assert.strictEqual(harness.events.filter((event) => event === "authority:begin").length, 1);
      assert.strictEqual(harness.events.includes("automation:accept"), entrypoint === "start");
      for (const projection of ["configure", "admit", "accept"])
        assert.isFalse(harness.events.includes(projection));
      const replay = yield* harness.commands
        .inspectPreparedNativeStart(harness.forwarded[0]!, "renderer-owner")
        .pipe(Effect.result);
      assert.strictEqual(replay._tag, "Failure");
      yield* Scope.close(harness.scope, Exit.void);
    }),
  );
}

it.effect("recovers an unavailable window before admitting a Main-owned Turn", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      request: () => Effect.succeed(response()),
      followerFailure: "no-client-found: owner disconnected",
    });
    harness.changeOwner();
    const result = yield* harness.commands.start("thread-a", "ship");
    assert.strictEqual(result?.turnId, "turn-accepted");
    assert.strictEqual(harness.forwarded.length, 1);
    assert.strictEqual(harness.requests(), 1);
    assert.strictEqual(harness.events.filter((event) => event === "ensure").length, 2);
    assert.ok(harness.events.includes("admit"));
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

it.effect("executes through the followed owner while another peer still advertises ownership", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      discoveredOwner: "previous-owner",
      request: () => Effect.succeed(response()),
    });
    harness.changeOwner();
    const result = yield* harness.commands.start("thread-a", "ship");
    assert.strictEqual(result?.turnId, "turn-accepted");
    assert.strictEqual(harness.forwarded.length, 1);
    assert.strictEqual(harness.requests(), 1);
    assert.strictEqual(harness.events.filter((event) => event === "authority:begin").length, 1);
    const replay = yield* harness.commands
      .inspectPreparedNativeStart(harness.forwarded[0]!, "previous-owner")
      .pipe(Effect.result);
    assert.strictEqual(replay._tag, "Failure");
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

it.effect("releases rejected Main admission without retrying an uncertain peer outcome", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      request: () => Effect.succeed(response()),
      followerFailure: "timeout: outcome unknown",
    });
    harness.changeOwner();
    const result = yield* harness.commands.start("thread-a", "ship").pipe(Effect.result);
    assert.strictEqual(result._tag, "Failure");
    assert.strictEqual(harness.forwarded.length, 1);
    assert.strictEqual(harness.requests(), 0);
    assert.strictEqual(harness.events.filter((event) => event === "ensure").length, 1);
    const released = yield* harness.commands
      .inspectPreparedNativeStart(harness.forwarded[0]!, "renderer-owner")
      .pipe(Effect.result);
    assert.strictEqual(released._tag, "Failure");
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

const questionSteerPlan = (): SteerFixture => ({
  expectedTurnId: "question-turn",
  request: {
    threadId: "thread-a",
    expectedTurnId: "question-turn",
    input: [],
    clientUserMessageId: "question-message",
  },
  item: {
    id: "steer-question",
    type: "steeringUserMessage",
    targetTurnId: "question-turn",
    targetTurnStartedAtMs: null,
    status: "pending",
    clientUserMessageId: "question-message",
    input: [],
    attachments: [],
    compareKey: { rawText: "", imageCount: 0 },
    restoreMessage: { context: { commentAttachments: [] } },
  },
});

it.effect("routes a public steer through its current window owner without a Main mutation", () =>
  Effect.gen(function* () {
    const forwarded: unknown[] = [];
    const harness = yield* makeHarness({
      request: () => Effect.die("No native start is allowed"),
      steerPlan: questionSteerPlan(),
      steerRequest: () => Effect.die("Main must not bypass the owning window"),
      onSteerForward: (input) => {
        forwarded.push(input);
        return { result: { turnId: "owner-turn" } };
      },
    });
    harness.changeOwner();
    const result = yield* harness.commands.steer({ threadId: "thread-a", prompt: "answer" });
    assert.deepEqual(result, { turnId: "owner-turn" });
    assert.strictEqual(forwarded.length, 1);
    assert.deepEqual(harness.events, []);
    assert.strictEqual(harness.resetListenerCount(), 0);
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

for (const message of ["SteerTurnInactiveError: active turn not steerable"]) {
  it.effect(`does not redirect a question reply after ${message}`, () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        request: () => Effect.succeed(response()),
        steerPlan: questionSteerPlan(),
        steerRequest: () =>
          Effect.fail(
            codexRuntimeError({
              operation: "gateway.request",
              reason: "request",
              retryable: false,
              hostId: "local",
              method: "turn/steer",
              cause: new CodexAppServerRequestError({ code: -32600, errorMessage: message }),
            }),
          ),
      });
      const result = yield* Effect.exit(
        harness.commands.steer({
          threadId: "thread-a",
          expectedTurnId: "question-turn",
          prompt: "answer",
        }),
      );
      assert.isTrue(Exit.isFailure(result));
      assert.strictEqual(harness.requests(), 0);
      assert.deepEqual(harness.events, ["steer:question-turn"]);
      assert.deepEqual(
        residentConversationTurns(harness.aggregate.readCanonicalState())[0]!.items,
        [],
      );
      yield* Scope.close(harness.scope, Exit.void);
    }),
  );
}

it.effect("accepts a question reply only in its originating Turn", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      request: () => Effect.succeed(response()),
      steerPlan: questionSteerPlan(),
      steerRequest: (turnId) => Effect.succeed({ turnId }),
    });
    assert.deepEqual(
      yield* harness.commands.steer({
        threadId: "thread-a",
        expectedTurnId: "question-turn",
        prompt: "answer",
      }),
      { turnId: "question-turn" },
    );
    assert.strictEqual(harness.requests(), 0);
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

for (const mismatchMessage of [
  "expected active turn id `question-turn` but found `corrected-turn`",
  'ExpectedTurnMismatch { expected: "question-turn", actual: "corrected-turn" }',
])
  it.effect(`retries a question reply once after ${mismatchMessage}`, () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        request: () => Effect.succeed(response()),
        steerPlan: questionSteerPlan(),
        steerRequest: (turnId) =>
          turnId === "corrected-turn"
            ? Effect.succeed({ turnId })
            : Effect.fail(
                codexRuntimeError({
                  operation: "gateway.request",
                  reason: "request",
                  retryable: false,
                  hostId: "local",
                  method: "turn/steer",
                  cause: new CodexAppServerRequestError({
                    code: -32600,
                    errorMessage: mismatchMessage,
                  }),
                }),
              ),
      });
      assert.deepEqual(
        yield* harness.commands.steer({
          threadId: "thread-a",
          expectedTurnId: "question-turn",
          prompt: "answer",
        }),
        { turnId: "corrected-turn" },
      );
      assert.strictEqual(harness.requests(), 0);
      assert.deepEqual(harness.events, ["steer:question-turn", "steer:corrected-turn"]);
      const turn = residentConversationTurns(harness.aggregate.readCanonicalState())[0]!;
      assert.strictEqual(turn.turnId, "corrected-turn");
      assert.strictEqual(turn.items.length, 1);
      const item = turn.items[0]!;
      assert.strictEqual(item.type, "steeringUserMessage");
      if (item.type === "steeringUserMessage") {
        assert.strictEqual(item.targetTurnId, "corrected-turn");
        assert.strictEqual(item.status, "accepted");
      }
      yield* Scope.close(harness.scope, Exit.void);
    }),
  );

for (const accepted of [true, false]) {
  it.effect(
    `Main steering records the gateway identity and settles its late response: ${accepted}`,
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const reply = yield* Deferred.make<TurnSteerResponse, ReturnType<typeof missingThread>>();
        const delivery = {
          requestId: "turn/steer:physical-request",
          method: "turn/steer",
          stage: "outcome-unknown",
        } as const;
        const harness = yield* makeHarness({
          request: () => Effect.succeed(response()),
          steerPlan: questionSteerPlan(),
          steerRequest: (_turnId, options) =>
            Effect.gen(function* () {
              assert.ok(options);
              assert.strictEqual(options.priority, "critical");
              assert.strictEqual(options.timeoutMs, 30_000);
              yield* options.onOutcomeUnknown!(delivery);
              yield* Deferred.succeed(entered, undefined);
              return yield* Deferred.await(reply);
            }),
        });
        const pending = yield* harness.commands
          .steer({ threadId: "thread-a", expectedTurnId: "question-turn", prompt: "answer" })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const state = harness.aggregate.readCanonicalState()!;
        assert.strictEqual(state.unconfirmedTurnSubmissions?.[0]?.requestId, delivery.requestId);
        assert.strictEqual(
          residentConversationTurns(state)[0]?.items[0]?.type,
          "steeringUserMessage",
        );
        if (accepted) yield* Deferred.succeed(reply, { turnId: "question-turn" });
        else
          yield* Deferred.fail(
            reply,
            codexRuntimeError({
              operation: "gateway.request",
              reason: "request",
              retryable: false,
              cause: new CodexAppServerRequestError({
                code: -32600,
                errorMessage: "Native rejected reply",
              }),
            }),
          );
        const settled = yield* Fiber.join(pending).pipe(Effect.result);
        assert.strictEqual(settled._tag, accepted ? "Success" : "Failure");
        const after = harness.aggregate.readCanonicalState()!;
        assert.isUndefined(after.unconfirmedTurnSubmissions);
        assert.strictEqual(residentConversationTurns(after)[0]?.items.length, accepted ? 1 : 0);
        yield* Scope.close(harness.scope, Exit.void);
      }),
  );
}

it.effect("retains a dispatched question reply when its outcome is unknown", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      request: () => Effect.succeed(response()),
      steerPlan: questionSteerPlan(),
      steerRequest: () =>
        Effect.fail(
          codexRuntimeError({
            operation: "scheduler.execution",
            reason: "outcome-unknown",
            retryable: false,
            hostId: "local",
            method: "turn/steer",
            cause: new CodexTurnDeliveryError("Steering delivery is unknown", {
              requestId: "native-steer-unknown",
              method: "turn/steer",
              stage: "outcome-unknown",
            }),
          }),
        ),
    });
    const result = yield* harness.commands
      .steer({
        threadId: "thread-a",
        expectedTurnId: "question-turn",
        prompt: "answer",
      })
      .pipe(Effect.result);
    assert.strictEqual(result._tag, "Failure");
    assert.deepEqual(harness.events, ["steer:question-turn"]);
    const state = harness.aggregate.readCanonicalState()!;
    assert.strictEqual(state.unconfirmedTurnSubmissions?.length, 1);
    assert.strictEqual(state.unconfirmedTurnSubmissions?.[0]?.stage, "outcome-unknown");
    assert.strictEqual(state.unconfirmedTurnSubmissions?.[0]?.method, "turn/steer");
    const item = residentConversationTurns(state)[0]!.items[0]!;
    assert.strictEqual(item.type, "steeringUserMessage");
    if (item.type === "steeringUserMessage") {
      assert.strictEqual(item.status, "pending");
      assert.strictEqual(
        item.clientUserMessageId,
        state.unconfirmedTurnSubmissions?.[0]?.clientUserMessageId,
      );
    }
    assert.strictEqual(harness.requests(), 0);
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

for (const retry of [false, true])
  it.effect(`binds an accepted projectless Turn to its original receipt with retry=${retry}`, () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        request: (attempt) =>
          retry && attempt === 1 ? Effect.fail(missingThread()) : Effect.succeed(response()),
      });
      const target = { kind: "thread", threadId: "thread-a" } as const;
      const ticket = yield* harness.presentation.capture(11, {
        target,
        presentation: testSubmitPresentation,
      });
      const presentationClaim = yield* harness.presentation.claim(ticket, target, "client-1");
      yield* harness.commands.start(target.threadId, "ship", {
        presentationClaim,
        clientUserMessageId: "client-1",
      });
      assert.equal(
        harness.presentation.read(target.threadId, "turn-accepted")?.windowSessionId,
        "window-a",
      );
      yield* Scope.close(harness.scope, Exit.void);
    }),
  );

for (const change of ["changeOwner", "retire", "reconnect"] as const) {
  it.effect(`rejects a consumed preparation after ${change} during title scheduling`, () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        request: () => Effect.succeed(response()),
        onTitle: (): Effect.Effect<void> => Effect.sync(() => harness[change]()),
      });
      const admitted = yield* harness.commands.prepareNativeStart("thread-a", "ship");
      const prepared = yield* harness.commands.inspectPreparedNativeStart(admitted);
      const outcome = yield* harness.commands
        .executePreparedNativeStart(prepared.request)
        .pipe(Effect.result);
      assert.strictEqual(outcome._tag, "Failure");
      assert.strictEqual(harness.requests(), 0);
      assert.isFalse(harness.events.includes("admit"));
      yield* Scope.close(harness.scope, Exit.void);
    }),
  );
}

const contextSteerIntent = {
  steerId: "steer-context",
  recoveryRow: {
    followUpId: "follow-up-context",
    clientUserMessageId: "steer-client",
    threadId: "thread-a",
    prompt: "answer",
    promptInput: { text: "answer" },
    createdAtMs: 1,
    collaborationMode: null,
    serviceTier: null,
    summary: null,
    pause: null,
  },
};
const contextSteerPlan = (): SteerFixture => {
  const original = questionSteerPlan();
  return {
    ...original,
    request: { ...original.request, clientUserMessageId: "steer-client" },
    item: { ...original.item, clientUserMessageId: "steer-client" },
  };
};

const nativeSteerPlan = (): SteerFixture => {
  const base = contextSteerPlan();
  const input = [{ type: "text" as const, text: "answer", text_elements: [] }];
  return {
    ...base,
    request: { ...base.request, clientUserMessageId: "steer-client", input },
    item: {
      ...base.item,
      input,
      attachments: [],
      restoreMessage: {
        queueRow: contextSteerIntent.recoveryRow,
        context: { commentAttachments: [] },
      },
    },
  };
};

for (const outcome of ["accepted", "unknown", "rejected", "unavailable"] as const) {
  it.effect(`associates steer presentation only with ${outcome} submission evidence`, () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        request: () => Effect.succeed(response()),
        steerPlan: contextSteerPlan(),
        steerRequest: (turnId) =>
          outcome === "unknown" || outcome === "rejected"
            ? Effect.fail(
                codexRuntimeError({
                  operation: "gateway.request",
                  reason: outcome === "unknown" ? "outcome-unknown" : "request",
                  retryable: false,
                  hostId: "local",
                  method: "turn/steer",
                  cause:
                    outcome === "unknown"
                      ? new CodexTurnDeliveryError("steer outcome", {
                          requestId: "native-steer-presentation",
                          method: "turn/steer",
                          stage: "outcome-unknown",
                        })
                      : new Error("steer outcome"),
                }),
              )
            : Effect.succeed({ turnId }),
      });
      const target = { kind: "thread", threadId: "thread-a" } as const;
      const firstTicket = yield* harness.presentation.capture(11, {
        target,
        presentation: testSubmitPresentation,
      });
      const first = yield* harness.presentation.begin(
        yield* harness.presentation.claim(firstTicket, target, "original-message"),
        target.threadId,
      );
      yield* harness.presentation.bind(first, "question-turn");
      const ticket =
        outcome === "unavailable"
          ? undefined
          : yield* harness.presentation.capture(22, {
              target,
              presentation: { ...testSubmitPresentation, rendererGeneration: "renderer-b" },
            });
      const result = yield* Effect.exit(
        harness.commands.steer({
          threadId: target.threadId,
          expectedTurnId: "question-turn",
          prompt: "answer",
          intent: contextSteerIntent,
          presentationTicket: ticket,
        }),
      );
      if (outcome === "rejected") {
        assert.isTrue(Exit.isFailure(result));
        assert.equal(
          harness.presentation.read(target.threadId, "question-turn")?.windowSessionId,
          "window-a",
        );
      } else {
        if (outcome === "unknown") {
          assert.isTrue(Exit.isFailure(result));
          assert.equal(
            harness.presentation.read(target.threadId, "question-turn")?.windowSessionId,
            "window-a",
          );
          yield* harness.presentation.observeUserMessage(
            target.threadId,
            "question-turn",
            "steer-client",
          );
        } else assert.isTrue(Exit.isSuccess(result));
        assert.equal(
          harness.presentation.read(target.threadId, "question-turn")?.windowSessionId ?? null,
          outcome === "unavailable" ? null : "window-b",
        );
      }
      yield* Scope.close(harness.scope, Exit.void);
    }),
  );
}

it.effect(
  "claims an exact prepared native turn once without replanning or losing Main authority",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ request: () => Effect.succeed(response()) });
      const request = yield* harness.commands.prepareNativeStart("thread-a", "ship");
      assert.strictEqual(harness.events.filter((event) => event.startsWith("prepare:")).length, 0);
      const premature = yield* harness.commands
        .executePreparedNativeStart(request.request)
        .pipe(Effect.result);
      assert.strictEqual(premature._tag, "Failure");
      const changedContext = yield* harness.commands
        .inspectPreparedNativeStart({ ...request, context: { inheritThreadSettings: false } })
        .pipe(Effect.result);
      assert.strictEqual(changedContext._tag, "Failure");
      const materialized = yield* harness.commands.inspectPreparedNativeStart(request);
      const altered = yield* harness.commands
        .executePreparedNativeStart({ ...materialized.request, model: "other" })
        .pipe(Effect.result);
      assert.strictEqual(altered._tag, "Failure");
      assert.strictEqual(harness.requests(), 0);
      const result = yield* harness.commands.executePreparedNativeStart(materialized.request);
      assert.strictEqual(result.turn.id, "turn-accepted");
      assert.strictEqual(harness.requests(), 1);
      assert.strictEqual(harness.events.filter((event) => event.startsWith("prepare:")).length, 1);
      assert.ok(harness.events.includes("authority:begin"));
      assert.ok(harness.events.includes("admit"));
      const replay = yield* harness.commands
        .executePreparedNativeStart(materialized.request)
        .pipe(Effect.result);
      assert.strictEqual(replay._tag, "Failure");
      assert.strictEqual(harness.requests(), 1);
      yield* Scope.close(harness.scope, Exit.void);
    }),
);

for (const change of ["changeOwner", "retire", "reconnect"] as const) {
  it.effect(`rejects a native preparation after ${change}`, () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ request: () => Effect.succeed(response()) });
      const request = yield* harness.commands.prepareNativeStart("thread-a", "ship");
      const materialized = yield* harness.commands.inspectPreparedNativeStart(request);
      harness[change]();
      const result = yield* harness.commands
        .executePreparedNativeStart(materialized.request)
        .pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(harness.requests(), 0);
      harness.commands.releasePreparedNativeStart(request.request.clientUserMessageId!);
      yield* Scope.close(harness.scope, Exit.void);
    }),
  );
}

it.effect("only lets the current physical renderer owner inspect and execute a prepared turn", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ request: () => Effect.succeed(response()) });
    harness.changeOwner();
    const request = yield* harness.commands.prepareNativeStart("thread-a", "ship");
    const wrong = yield* harness.commands
      .inspectPreparedNativeStart(request, "another-window")
      .pipe(Effect.result);
    assert.strictEqual(wrong._tag, "Failure");
    const params = yield* harness.commands.inspectPreparedNativeStart(request, "renderer-owner");
    assert.strictEqual(params.params.clientUserMessageId, request.request.clientUserMessageId);
    const native = yield* harness.commands.executePreparedNativeStart(
      params.request,
      "renderer-owner",
    );
    assert.strictEqual(native.turn.id, "turn-accepted");
    assert.strictEqual(harness.requests(), 1);
    assert.ok(harness.events.includes("authority:begin"));
    assert.ok(!harness.events.includes("admit"));
    assert.ok(!harness.events.includes("accept"));
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

it.effect("admits native steering once while its current owner controls optimistic state", () =>
  Effect.gen(function* () {
    const plan = nativeSteerPlan();
    const harness = yield* makeHarness({
      request: () => Effect.succeed(response()),
      steerPlan: plan,
      steerRequest: (turnId) => Effect.succeed({ turnId }),
    });
    const prepared = yield* harness.commands.prepareNativeSteer({
      threadId: "thread-a",
      prompt: "answer",
      intent: contextSteerIntent,
    });
    const request = {
      method: "turn/steer" as const,
      params: { ...plan.request, expectedTurnId: "owner-current-turn" },
    };
    const altered = yield* harness.commands
      .executePreparedNativeSteer(
        { ...request, params: { ...request.params, input: [] } },
        prepared.clientUserMessageId,
      )
      .pipe(Effect.result);
    assert.strictEqual(altered._tag, "Failure");
    const result = yield* harness.commands.executePreparedNativeSteer(
      request,
      prepared.clientUserMessageId,
    );
    assert.deepEqual(result, { turnId: "owner-current-turn" });
    assert.deepEqual(
      residentConversationTurns(harness.aggregate.readCanonicalState()).flatMap(
        (turn) => turn.items,
      ),
      [],
    );
    const repeated = yield* harness.commands
      .executePreparedNativeSteer(request, prepared.clientUserMessageId)
      .pipe(Effect.result);
    assert.strictEqual(repeated._tag, "Failure");
    harness.commands.releasePreparedNativeSteer(prepared.clientUserMessageId);
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

const queuedPreparationContext = {
  runtimeWorkspaceRoots: ["/repo"],
  usePermissionSelection: false,
} as const;

for (const owner of ["main", "renderer"] as const)
  it.effect(`${owner} queued app context is injected once inside its owner transaction`, () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        request: () => Effect.succeed({ turn: { id: "queued-turn" } } as TurnStartResponse),
      });
      if (owner === "renderer") harness.changeOwner();
      const executingPeer = owner === "renderer" ? "renderer-owner" : undefined;
      const message = {
        id: "captured-id",
        cwd: "/repo",
        context: {
          prompt: "review",
          fileAttachments: [],
          addedFiles: [],
          commentAttachments: [],
          imageAttachments: [],
          mcpAppModelContextAttachments: [
            { id: "app", title: "context", text: "model context", imageAttachments: [] },
          ],
        },
      };
      const prepared = yield* harness.commands.prepareNativeQueuedMessage(
        "thread-a",
        message,
        "start",
        queuedPreparationContext,
      );
      assert.isTrue(prepared.requiresIdle);
      assert.deepEqual(prepared.steer.restoreMessage, message);
      assert.strictEqual(prepared.start?.request.clientUserMessageId, message.id);
      assert.ok(prepared.start);
      const materialized = yield* harness.commands.inspectPreparedNativeStart(
        prepared.start,
        executingPeer,
      );
      if (owner === "renderer") {
        const premature = yield* harness.commands
          .executePreparedNativeStart(materialized.request, executingPeer)
          .pipe(Effect.result);
        assert.strictEqual(premature._tag, "Failure");
        yield* harness.commands.injectPreparedNativeStart(prepared.start, executingPeer);
        const duplicate = yield* harness.commands
          .injectPreparedNativeStart(prepared.start, executingPeer)
          .pipe(Effect.result);
        assert.strictEqual(duplicate._tag, "Failure");
      }
      yield* harness.commands.executePreparedNativeStart(materialized.request, executingPeer);
      assert.isTrue(harness.events.indexOf("inject") < harness.events.indexOf("request:1"));
      if (owner === "main")
        assert.isTrue(harness.events.indexOf("admit") < harness.events.indexOf("inject"));
      assert.strictEqual(harness.events.filter((event) => event === "inject").length, 1);
      const repeated = yield* harness.commands
        .executePreparedNativeStart(materialized.request, executingPeer)
        .pipe(Effect.result);
      assert.strictEqual(repeated._tag, "Failure");
      yield* Scope.close(harness.scope, Exit.void);
    }),
  );

for (const permissionMode of ["auto", "guardian-approvals", "full-access", "custom"] as const) {
  it.effect(
    `materializes a queued permission choice after owner replacement: ${permissionMode}`,
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ request: () => Effect.succeed(response()) });
        const message = {
          id: "captured-permission",
          cwd: "/repo",
          context: {
            prompt: "queued",
            fileAttachments: [],
            addedFiles: [],
            commentAttachments: [],
            imageAttachments: [],
          },
          submissionOptions: { agentMode: permissionMode, shouldSendPermissionOverrides: true },
        };
        try {
          const prepared = yield* harness.commands.prepareNativeQueuedMessage(
            "thread-a",
            message,
            "start",
            queuedPreparationContext,
          );
          assert.ok(prepared.start);
          assert.deepEqual(harness.configReads, [{ includeLayers: false, cwd: "/repo" }]);
          if (permissionMode === "auto") {
            assert.strictEqual(prepared.start.request.approvalPolicy, "on-request");
            assert.strictEqual(prepared.start.request.permissions, ":workspace");
            assert.strictEqual(prepared.start.request.approvalsReviewer, "user");
          } else if (permissionMode === "guardian-approvals") {
            assert.strictEqual(prepared.start.request.approvalPolicy, "on-request");
            assert.isUndefined(prepared.start.request.permissions);
            assert.strictEqual(prepared.start.request.approvalsReviewer, "guardian_subagent");
            assert.strictEqual(prepared.start.request.sandboxPolicy?.type, "workspaceWrite");
          } else if (permissionMode === "full-access") {
            assert.strictEqual(prepared.start.request.approvalPolicy, "never");
            assert.strictEqual(prepared.start.request.permissions, ":danger-full-access");
            assert.strictEqual(prepared.start.request.approvalsReviewer, "user");
          } else {
            assert.strictEqual(prepared.start.request.approvalPolicy, "on-request");
            assert.isUndefined(prepared.start.request.permissions);
            assert.strictEqual(prepared.start.request.approvalsReviewer, "user");
            assert.strictEqual(prepared.start.request.sandboxPolicy?.type, "workspaceWrite");
          }
          yield* harness.commands.inspectPreparedNativeStart(prepared.start);
          assert.deepEqual(
            harness.preparationInputs.at(-1)?.originalRequest,
            prepared.start.request,
          );
          assert.isUndefined(harness.preparationInputs.at(-1)?.overrides?.permissionMode);
          harness.changeOwner();
          yield* harness.commands.inspectPreparedNativeStart(prepared.start, "renderer-owner");
          assert.strictEqual(harness.preparationInputs.length, 2);
          assert.deepEqual(
            harness.preparationInputs.at(-1)?.originalRequest,
            prepared.start.request,
          );
          assert.isUndefined(harness.preparationInputs.at(-1)?.overrides?.permissionMode);
          assert.strictEqual(
            harness.preparationInputs.at(-1)?.overrides?.clientUserMessageId,
            message.id,
          );
        } finally {
          yield* Scope.close(harness.scope, Exit.void);
        }
      }),
  );
}

it.effect(
  "a captured display mode without override intent does not replace current permissions",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ request: () => Effect.succeed(response()) });
      try {
        const prepared = yield* harness.commands.prepareNativeQueuedMessage(
          "thread-a",
          {
            id: "implicit-permission",
            cwd: "/repo",
            context: {
              prompt: "queued",
              fileAttachments: [],
              addedFiles: [],
              commentAttachments: [],
              imageAttachments: [],
            },
            submissionOptions: { agentMode: "full-access", shouldSendPermissionOverrides: false },
          },
          "start",
          queuedPreparationContext,
        );
        assert.ok(prepared.start);
        assert.lengthOf(harness.configReads, 0);
        yield* harness.commands.inspectPreparedNativeStart(prepared.start);
        assert.strictEqual(harness.preparationInputs.at(-1)?.overrides?.permissionMode, undefined);
      } finally {
        yield* Scope.close(harness.scope, Exit.void);
      }
    }),
);

for (const selection of [
  { kind: "agent-mode", agentMode: "granular" },
  { kind: "profile", profileId: "team-profile" },
  { kind: "custom" },
  { kind: "server-default" },
] as const) {
  it.effect(`materializes queued modern permission selection: ${selection.kind}`, () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ request: () => Effect.succeed(response()) });
      try {
        const prepared = yield* harness.commands.prepareNativeQueuedMessage(
          "thread-a",
          {
            id: `modern-${selection.kind}`,
            cwd: "/repo",
            context: {
              prompt: "queued",
              fileAttachments: [],
              addedFiles: [],
              commentAttachments: [],
              imageAttachments: [],
            },
            submissionOptions: { permissionSelection: selection },
          },
          "start",
          { runtimeWorkspaceRoots: ["/repo"], usePermissionSelection: true },
        );
        assert.ok(prepared.start);
        const { request, context } = prepared.start;
        assert.strictEqual(harness.configReads.length, selection.kind === "custom" ? 1 : 0);
        if (selection.kind === "agent-mode") {
          assert.strictEqual(request.permissions, ":workspace");
          assert.deepEqual(request.approvalPolicy, {
            granular: {
              sandbox_approval: false,
              rules: false,
              skill_approval: false,
              request_permissions: true,
              mcp_elicitations: false,
            },
          });
          assert.strictEqual(request.approvalsReviewer, "user");
          assert.isUndefined(request.runtimeWorkspaceRoots);
          assert.isFalse(context?.usePermissionSelection ?? true);
          assert.isFalse(context?.useAppServerPermissionDefault ?? true);
        } else if (selection.kind === "profile") {
          assert.strictEqual(request.permissions, "team-profile");
          assert.isUndefined(request.approvalPolicy);
          assert.isUndefined(request.approvalsReviewer);
          assert.isUndefined(request.runtimeWorkspaceRoots);
          assert.isFalse(context?.usePermissionSelection ?? true);
          assert.isFalse(context?.useAppServerPermissionDefault ?? true);
        } else if (selection.kind === "custom") {
          assert.isUndefined(request.permissions);
          assert.strictEqual(request.approvalPolicy, "on-request");
          assert.strictEqual(request.approvalsReviewer, "user");
          assert.strictEqual(request.sandboxPolicy?.type, "workspaceWrite");
          assert.isUndefined(request.runtimeWorkspaceRoots);
          assert.isFalse(context?.usePermissionSelection ?? true);
          assert.isFalse(context?.useAppServerPermissionDefault ?? true);
        } else {
          assert.isUndefined(request.permissions);
          assert.isUndefined(request.approvalPolicy);
          assert.isUndefined(request.approvalsReviewer);
          assert.isUndefined(request.runtimeWorkspaceRoots);
          assert.isTrue(context?.usePermissionSelection ?? false);
          assert.isTrue(context?.useAppServerPermissionDefault ?? false);
        }
      } finally {
        yield* Scope.close(harness.scope, Exit.void);
      }
    }),
  );
}

const reconnectMessage = {
  id: "reconnect-message",
  cwd: "/repo",
  context: {
    prompt: "answer",
    fileAttachments: [],
    addedFiles: [],
    commentAttachments: [],
    imageAttachments: [],
    mcpAppModelContextAttachments: [
      { id: "app", title: "context", text: "model context", imageAttachments: [] },
    ],
  },
};

for (const mode of ["start", "steer"] as const) {
  for (const serviceTier of [null, "priority"] as const) {
    it.effect(
      `retains captured ${serviceTier ?? "Standard"} tier while preparing a queued ${mode}`,
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness({ request: () => Effect.succeed(response()) });
          try {
            const message = { ...reconnectMessage, submissionOptions: { serviceTier } };
            const prepared = yield* harness.commands.prepareNativeQueuedMessage(
              "thread-a",
              message,
              mode,
              queuedPreparationContext,
            );
            assert.strictEqual(prepared.steer.serviceTier, serviceTier);
            assert.deepEqual(prepared.steer.restoreMessage, message);
            if (mode === "start")
              assert.strictEqual(prepared.start?.request.serviceTier, serviceTier);
          } finally {
            yield* Scope.close(harness.scope, Exit.void);
          }
        }),
    );
  }
}

for (const mode of ["direct", "queued", "delegated"] as const) {
  it.effect(`revokes ${mode} steering admission on a same-manager reconnect`, () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        request: () => Effect.succeed(response()),
        steerPlan: nativeSteerPlan(),
        steerRequest: (turnId) => Effect.succeed({ turnId }),
      });
      const prepared =
        mode === "direct"
          ? yield* harness.commands.prepareNativeSteer({
              threadId: "thread-a",
              prompt: "answer",
              intent: contextSteerIntent,
            })
          : mode === "queued"
            ? (yield* harness.commands.prepareNativeQueuedMessage(
                "thread-a",
                reconnectMessage,
                "steer",
                queuedPreparationContext,
              )).steer
            : (yield* harness.commands.prepareNativeToolMessage(
                "thread-a",
                "source",
                "answer",
                "steer",
              )).steer;
      assert.strictEqual(harness.resetListenerCount(), 1);
      harness.reconnect();
      assert.strictEqual(harness.resetListenerCount(), 0);
      const inspection = yield* harness.commands
        .inspectPreparedNativeSteer(prepared.clientUserMessageId)
        .pipe(Effect.result);
      assert.strictEqual(inspection._tag, "Failure");
      const native = prepared.toolOutput
        ? {
            method: "turn/start" as const,
            params: {
              threadId: "thread-a",
              input: prepared.input,
              toolOutput: prepared.toolOutput,
            },
          }
        : {
            method: "turn/steer" as const,
            params: {
              threadId: "thread-a",
              input: prepared.input,
              clientUserMessageId: prepared.clientUserMessageId,
              expectedTurnId: "question-turn",
              additionalContext: prepared.additionalContext,
            },
          };
      const execution = yield* harness.commands
        .executePreparedNativeSteer(native, prepared.clientUserMessageId)
        .pipe(Effect.result);
      assert.strictEqual(execution._tag, "Failure");
      assert.strictEqual(harness.dispatchFences.length, 0);
      yield* Scope.close(harness.scope, Exit.void);
    }),
  );
}

for (const mode of ["queued", "delegated"] as const) {
  for (const phase of ["capturing input", "registering admission"] as const) {
    it.effect(`rejects ${mode} preparation that crossed a native reconnect while ${phase}`, () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          request: () => Effect.succeed(response()),
          onCaptured: (): Effect.Effect<void> =>
            phase === "capturing input" ? Effect.sync(() => harness.reconnect()) : Effect.void,
          onManagerGet: (count): void => {
            if (phase === "registering admission" && count === 2) harness.reconnect();
          },
        });
        const result = yield* (
          mode === "queued"
            ? harness.commands.prepareNativeQueuedMessage(
                "thread-a",
                reconnectMessage,
                "start",
                queuedPreparationContext,
              )
            : harness.commands.prepareNativeToolMessage("thread-a", "source", "answer", "start")
        ).pipe(Effect.result);
        assert.strictEqual(result._tag, "Failure");
        assert.strictEqual(harness.resetListenerCount(), 0);
        assert.strictEqual(harness.dispatchFences.length, 0);
        yield* Scope.close(harness.scope, Exit.void);
      }),
    );
  }
}

for (const method of ["turn/start", "turn/steer", "thread/inject_items"] as const) {
  it.effect(`keeps the admitted generation when ${method} waits for native readiness`, () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        request: () => Effect.succeed(response()),
        steerPlan: method === "turn/steer" ? nativeSteerPlan() : undefined,
        steerRequest: (turnId) => Effect.succeed({ turnId }),
        beforeDispatch: (): void => harness.reconnect(),
      });
      const operation = Effect.gen(function* () {
        if (method === "turn/steer") {
          const input = yield* harness.commands.prepareNativeSteer({
            threadId: "thread-a",
            prompt: "answer",
            intent: contextSteerIntent,
          });
          return yield* harness.commands.executePreparedNativeSteer(
            { method, params: nativeSteerPlan().request },
            input.clientUserMessageId,
          );
        }
        if (method === "thread/inject_items") {
          const prepared = yield* harness.commands.prepareNativeQueuedMessage(
            "thread-a",
            reconnectMessage,
            "start",
            queuedPreparationContext,
          );
          assert.ok(prepared.start);
          yield* harness.commands.inspectPreparedNativeStart(prepared.start);
          return yield* harness.commands.injectPreparedNativeStart(prepared.start);
        }
        const start = yield* harness.commands.prepareNativeStart("thread-a", "ship");
        const plan = yield* harness.commands.inspectPreparedNativeStart(start);
        return yield* harness.commands.executePreparedNativeStart(plan.request);
      });
      const result = yield* operation.pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.deepEqual(
        harness.dispatchFences.map(({ method, options }) => ({
          method,
          hostId: options?.expectedHostId,
          generation: options?.expectedGeneration,
        })),
        [{ method, hostId: "local", generation: 1 }],
      );
      assert.strictEqual(harness.requests(), 0);
      assert.isFalse(harness.events.includes("inject"));
      assert.isFalse(harness.events.some((event) => event.startsWith("steer:")));
      yield* Scope.close(harness.scope, Exit.void);
    }),
  );
}

it.effect("does not adopt an old native turn response into the recovered manager", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      request: (): Effect.Effect<TurnStartResponse> =>
        Effect.sync(() => {
          harness.reconnect();
          return response();
        }),
    });
    const result = yield* harness.commands.start("thread-a", "ship").pipe(Effect.result);
    assert.strictEqual(result._tag, "Failure");
    assert.strictEqual(harness.requests(), 1);
    assert.isFalse(harness.events.includes("accept"));
    assert.isFalse(harness.events.includes("authority:bind"));
    assert.isFalse(harness.events.includes("automation:accept"));
    assert.isFalse(harness.events.includes("reject"));
    yield* Scope.close(harness.scope, Exit.void);
  }),
);

for (const invalidation of ["reconnect", "owner-replacement", "entity-replacement"] as const) {
  it.effect(`does not bind an old steering response after ${invalidation}`, () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        request: () => Effect.succeed(response()),
        steerPlan: nativeSteerPlan(),
        steerRequest: (turnId): Effect.Effect<TurnSteerResponse> =>
          Effect.gen(function* () {
            if (invalidation === "reconnect") harness.reconnect();
            else if (invalidation === "entity-replacement") yield* harness.replaceEntity();
            else {
              harness.changeOwner();
              harness.changeOwner();
            }
            return { turnId };
          }),
      });
      const presentationTicket = yield* harness.presentation.capture(11, {
        target: { kind: "thread", threadId: "thread-a" },
        presentation: testSubmitPresentation,
      });
      const prepared = yield* harness.commands.prepareNativeSteer({
        threadId: "thread-a",
        prompt: "answer",
        intent: contextSteerIntent,
        presentationTicket,
      });
      const result = yield* harness.commands
        .executePreparedNativeSteer(
          { method: "turn/steer", params: nativeSteerPlan().request },
          prepared.clientUserMessageId,
        )
        .pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(harness.dispatchFences.length, 1);
      harness.commands.releasePreparedNativeSteer(prepared.clientUserMessageId);
      assert.strictEqual(harness.resetListenerCount(), 0);
      assert.isNull(harness.presentation.read("thread-a", "question-turn") ?? null);
      yield* Scope.close(harness.scope, Exit.void);
    }),
  );
}

it.effect(
  "accepts a queued turn through peer framing without weakening prepared value checks",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ request: () => Effect.succeed(response()) });
      harness.changeOwner();
      const prepared = yield* harness.commands.prepareNativeQueuedMessage(
        "thread-a",
        {
          id: "peer-queued-message",
          cwd: "/repo",
          context: {
            prompt: "ship",
            fileAttachments: [],
            addedFiles: [],
            commentAttachments: [],
            imageAttachments: [],
          },
        },
        "start",
        queuedPreparationContext,
      );
      assert.ok(prepared.start);
      const received: CodexPeerMessage[] = [];
      createCodexPeerFrameReader((message) => received.push(message))(
        encodeCodexPeerFrame({
          type: "request",
          requestId: "peer-request",
          sourceClientId: "follower",
          targetClientId: "renderer-owner",
          hostId: "local",
          version: 3,
          method: "thread-follower-start-turn",
          params: { conversationId: "thread-a", turnStart: prepared.start },
        }),
      );
      const packet = received[0];
      assert.ok(packet?.type === "request");
      const forwarded = (packet.params as { turnStart: ConversationFollowerTurnStart }).turnStart;
      const modified = yield* harness.commands
        .inspectPreparedNativeStart(
          {
            ...forwarded,
            request: { ...forwarded.request, model: "unadmitted-model" },
          },
          "renderer-owner",
        )
        .pipe(Effect.result);
      assert.strictEqual(modified._tag, "Failure");
      const changedContext = yield* harness.commands
        .inspectPreparedNativeStart(
          {
            ...forwarded,
            context: { ...forwarded.context, useAppServerPermissionDefault: true },
          },
          "renderer-owner",
        )
        .pipe(Effect.result);
      assert.strictEqual(changedContext._tag, "Failure");
      const materialized = yield* harness.commands.inspectPreparedNativeStart(
        forwarded,
        "renderer-owner",
      );
      yield* harness.commands.executePreparedNativeStart(materialized.request, "renderer-owner");
      assert.strictEqual(harness.requests(), 1);
      const duplicate = yield* harness.commands
        .executePreparedNativeStart(materialized.request, "renderer-owner")
        .pipe(Effect.result);
      assert.strictEqual(duplicate._tag, "Failure");
      assert.strictEqual(harness.requests(), 1);
      yield* Scope.close(harness.scope, Exit.void);
    }),
);
it.effect(
  "trusted delegated steering admits only its exact tool output and sends no user input",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        request: () => Effect.succeed({ turn: { id: "tool-turn" } } as TurnStartResponse),
      });
      const prepared = yield* harness.commands.prepareNativeToolMessage(
        "thread-a",
        "source<&",
        "check <this>",
        "steer",
      );
      assert.deepEqual(prepared.steer.input, []);
      assert.deepEqual(prepared.steer.toolOutput, {
        name: "send_message_to_thread",
        namespace: "codex_app",
        output:
          "<codex_delegation>\n  <source_thread_id>source&lt;&amp;</source_thread_id>\n  <input>check &lt;this&gt;</input>\n</codex_delegation>",
      });
      const native = {
        method: "turn/start" as const,
        params: { threadId: "thread-a", input: [], toolOutput: prepared.steer.toolOutput },
      };
      const altered = yield* harness.commands
        .executePreparedNativeSteer(
          {
            ...native,
            params: {
              ...native.params,
              toolOutput: { ...prepared.steer.toolOutput!, output: "different" },
            },
          },
          prepared.steer.clientUserMessageId,
        )
        .pipe(Effect.result);
      assert.strictEqual(altered._tag, "Failure");
      const result = yield* harness.commands.executePreparedNativeSteer(
        native,
        prepared.steer.clientUserMessageId,
      );
      assert.deepEqual(result, { turnId: "tool-turn" });
      assert.isFalse(harness.events.some((event) => event.startsWith("admit-steer:")));
      yield* Scope.close(harness.scope, Exit.void);
    }),
);
it.effect(
  "older hosts receive the same escaped delegation as text rather than unsupported tool output",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        appServerVersion: "0.151.0-alpha.3",
        request: () => Effect.succeed({ turn: { id: "legacy-turn" } } as TurnStartResponse),
      });
      const prepared = yield* harness.commands.prepareNativeToolMessage(
        "thread-a",
        "source",
        "check <this>",
        "steer",
      );
      assert.isUndefined(prepared.steer.toolOutput);
      assert.deepEqual(prepared.steer.input, [
        {
          type: "text",
          text: "<codex_delegation>\n  <source_thread_id>source</source_thread_id>\n  <input>check &lt;this&gt;</input>\n</codex_delegation>",
          text_elements: [],
        },
      ]);
      harness.commands.releasePreparedNativeSteer(prepared.steer.clientUserMessageId);
      yield* Scope.close(harness.scope, Exit.void);
    }),
);
it.effect(
  "admits an owner-authorized userless native start without manufacturing a user message",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        request: () => Effect.succeed({ turn: { id: "resumed-turn" } } as TurnStartResponse),
      });
      const original = { threadId: "thread-a", input: [], clientUserMessageId: "resume-id" };
      const prepared = yield* harness.commands.prepareNativeStart(
        "thread-a",
        "",
        { clientUserMessageId: "resume-id", preparedPrompt: createEmptyCodexPreparedPrompt() },
        original,
      );
      const materialized = yield* harness.commands.inspectPreparedNativeStart(prepared);
      assert.deepEqual(materialized.request.input, []);
      const result = yield* harness.commands.executePreparedNativeStart(materialized.request);
      assert.strictEqual(result.turn.id, "resumed-turn");
      yield* Scope.close(harness.scope, Exit.void);
    }),
);
