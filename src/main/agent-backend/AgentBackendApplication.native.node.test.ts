// @effect-diagnostics strictEffectProvide:off
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { AgentConversationSnapshot } from "../../shared/agent-conversation";
import type { ClaudeModelSelection } from "../../shared/claude-models";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import type { CodexPermissionMode, ProjectSessionThreadLinkInput } from "../../shared/types";
import type { NativePermissionMode } from "../../shared/agent-backend-api";
import { CodexPlatform } from "../app/CodexApplicationLive";
import { CodexGitProbe } from "../codex-application/CodexGitProbe";
import { testLayer as configLayer } from "../app/MainConfig";
import {
  createNativeAppToolClaimIssuer,
  captureAppToolAuthority,
} from "../app-tools/AppToolCaller";
import { NativePromptImages } from "./NativePromptImages";
import { NativeAppToolSession } from "../app-tools/NativeAppToolSession";
import {
  bindingLayer,
  NativeConversationBinding,
  NativeConversationExtension,
} from "../app-tools/NativeConversationExtension";
import type { DesktopProjectWorkspaceNativeAgentState } from "../core-client/project-workspace-adapter";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { AgentBackendRegistry } from "./AgentBackendRegistry";
import {
  make as makeApplication,
  type AgentBackendApplicationError,
} from "./AgentBackendApplication";
import {
  emptyAgentConversationSnapshot,
  beginAgentConversationTurn,
  completeAgentConversationTurn,
} from "./AgentConversationProjection";
import { agentRuntimeError, type AgentRuntimeError } from "./AgentRuntimeError";
import type { AgentSessionHandle, AgentSessionPermissionPolicy } from "./AgentSessionHandle";
import { AcpBackendSessionManager } from "./acp/AcpBackendSessionManager";
import { ClaudeSessionManager, type OpenClaudeSessionInput } from "./claude/ClaudeSessionManager";
import { NativeTurnAuthority } from "./NativeTurnAuthority";
import { createUuidV7 } from "../../shared/uuid-v7";

const binding = { kind: "claude" as const, instanceConfigId: "work" };
const durableId = "native-session";

/** Exercises the Application callbacks through a scoped manager without launching Claude. */
const makeFixtureWithInitialBinding = (initiallyBound: boolean) =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.Scope;
    const promptStarted = yield* Deferred.make<void>();
    const finishPrompt = yield* Deferred.make<void>();
    const authorityReadBlocked = yield* Deferred.make<void>();
    const releaseAuthorityRead = yield* Deferred.make<void>();
    const initialBindStarted = yield* Deferred.make<void>();
    const releaseInitialBind = yield* Deferred.make<void>();
    let pauseInitialBind = false;
    let pauseAfterModel: string | null = null;
    let pauseNextRead = false;
    let promptReserved = false;
    let promptCalls = 0;
    let sentCalls = 0;
    let policyCalls = 0;
    const policies: AgentSessionPermissionPolicy[] = [];
    const permissionWrites: Array<{ projectId: string | null; mode: CodexPermissionMode }> = [];
    const rejectedPolicies = new Set<AgentSessionPermissionPolicy>();
    let currentPermissionMode: CodexPermissionMode | null = "auto";
    let failPermissionWrite = false;
    let beforePermissionWrite: Effect.Effect<void> = Effect.void;
    let afterPermissionWrite: Effect.Effect<void, AgentRuntimeError> = Effect.void;
    let beforePermissionPolicy: (
      policy: AgentSessionPermissionPolicy,
    ) => Effect.Effect<void> = () => Effect.void;
    let projectActive = true;
    let intelligenceCalls = 0;
    let openCalls = 0;
    let currentNativeHome = "/native-home";
    let freezeCalls = 0;
    const toolOutputReads: Array<[string, string]> = [];
    let onToolOutputRead: Effect.Effect<void> = Effect.void;
    const snapshot = yield* SubscriptionRef.make<AgentConversationSnapshot>({
      ...emptyAgentConversationSnapshot({
        threadId: "native",
        sessionId: durableId,
        backend: "claude",
      }),
      metadata: {
        revision: 0,
        configOptions: [],
        modes: null,
        capabilities: {} as never,
        requestedSelection: { model: "default", effort: "default" } as ClaudeModelSelection,
      },
    });
    const statuses: string[] = [];
    const bound: Array<{
      backendSessionId: string;
      expectedBackendSessionId?: string;
      nativeState?: DesktopProjectWorkspaceNativeAgentState;
    }> = [];
    let nativeState: DesktopProjectWorkspaceNativeAgentState = {
      preferences: { model: "default", effort: "default", interaction_mode: "default" },
      ever_saved: true,
      turns: [],
    };
    let currentId: string | null = initiallyBound ? durableId : null;
    let nativeId = durableId;
    let onPrepareImages: Effect.Effect<void> = Effect.void;
    let extraRoot = "/workspace";
    let currentCwd = "/workspace";
    let currentManagedWorktreePath: string | null = null;
    let runtimeCwd = "/workspace";
    let runtimeSuspended = false;
    let executionHandoff = false;
    let executionRecoveryRequired = false;
    let suspendedCalls = 0;
    const runtimeLocations: string[] = [];
    const launchDirectories: string[][] = [];
    let currentProjectId: string | null = "project";
    let onOpen: Effect.Effect<void> = Effect.void;
    let threadBinding: typeof binding = binding;
    let failStatus = false;
    let failBinding = false;
    let hooks: OpenClaudeSessionInput | null = null;
    let runtimeScope: Scope.Closeable | null = null;
    let issuer: ReturnType<typeof createNativeAppToolClaimIssuer> | null = null;
    let live: AgentSessionHandle | null = null;
    const reinitialize = (cwd: string) =>
      Effect.gen(function* () {
        if (runtimeScope) yield* Scope.close(runtimeScope, Exit.void);
        runtimeScope = yield* Scope.fork(ownerScope);
        runtimeCwd = cwd;
        runtimeSuspended = false;
        runtimeLocations.push(cwd);
        if (hooks?.acquireLaunchContext) {
          const context = yield* hooks.acquireLaunchContext(cwd).pipe(Scope.provide(runtimeScope));
          launchDirectories.push([...(context.additionalDirectories ?? [])]);
        }
      });
    const handle: AgentSessionHandle = {
      threadId: "native",
      get sessionId() {
        return nativeId;
      },
      snapshot,
      capabilities: {} as never,
      modes: null,
      configOptions: [],
      prompt: (text, options) =>
        Effect.gen(function* () {
          if (promptReserved || (yield* SubscriptionRef.get(snapshot)).status === "running")
            return yield* agentRuntimeError({
              operation: "prompt",
              reason: "request",
              retryable: false,
              cause: new Error("busy"),
            });
          const id = options?.clientUserMessageId;
          if (!id || !hooks?.onTurnAdmitted || !hooks.onTurnSettled)
            return yield* Effect.die("Missing native admission callback");
          promptCalls += 1;
          promptReserved = true;
          yield* hooks.onTurnAdmitted({ sequence: 1, clientUserMessageId: id, text });
          sentCalls += 1;
          yield* SubscriptionRef.update(snapshot, (current) =>
            beginAgentConversationTurn(current, 1, text, id),
          );
          yield* Deferred.succeed(promptStarted, undefined);
          yield* Deferred.await(finishPrompt);
          yield* SubscriptionRef.update(snapshot, (current) =>
            completeAgentConversationTurn(current, 1, {
              status: "completed",
              stopReason: "end_turn",
              error: null,
            }),
          );
          yield* hooks.onTurnSettled({
            sequence: 1,
            clientUserMessageIds: [id],
            status: "completed",
            stopReason: "end_turn",
            nativeSessionId: durableId,
            everSaved: true,
          });
          promptReserved = false;
          return { stopReason: "end_turn" };
        }),
      cancel: Effect.void,
      suspendExecution: Effect.gen(function* () {
        if (runtimeScope) yield* Scope.close(runtimeScope, Exit.void);
        runtimeScope = null;
        runtimeSuspended = true;
        suspendedCalls += 1;
      }),
      setExecutionRecoveryRequired: (required) =>
        Effect.sync(() => {
          executionRecoveryRequired = required;
        }),
      withExecutionHandoff: (use) =>
        Effect.sync(() => {
          executionHandoff = true;
        }).pipe(
          Effect.andThen(use),
          Effect.onExit(() =>
            Effect.suspend(() =>
              runtimeSuspended && !executionRecoveryRequired
                ? reinitialize(runtimeCwd)
                : Effect.void,
            ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              executionHandoff = false;
            }),
          ),
        ),
      withExecutionLocation: (location, use) =>
        Effect.uninterruptibleMask((restore) => {
          const source = runtimeCwd;
          return reinitialize(location.workspaceRoot).pipe(
            Effect.andThen(restore(use)),
            Effect.onExit((exit) => (Exit.isFailure(exit) ? reinitialize(source) : Effect.void)),
            Effect.onExit(() =>
              Effect.suspend(() => (executionHandoff ? handle.suspendExecution! : Effect.void)),
            ),
          );
        }),
      setIntelligence: (selected) =>
        Effect.gen(function* () {
          intelligenceCalls += 1;
          if (promptReserved)
            return yield* agentRuntimeError({
              operation: "settings",
              reason: "request",
              retryable: false,
              cause: new Error("busy"),
            });
          yield* SubscriptionRef.update(snapshot, (current) => ({
            ...current,
            metadata: {
              ...current.metadata!,
              requestedSelection: selected,
              effectiveSelection: {
                model: "gateway-routed-model",
                effort: "medium",
                permissionMode: "default",
              },
            },
          }));
        }),
      setPermissionPolicy: (next) =>
        Effect.gen(function* () {
          policyCalls += 1;
          policies.push(next);
          yield* beforePermissionPolicy(next);
          if (rejectedPolicies.has(next))
            return yield* agentRuntimeError({
              operation: "native permission",
              reason: "authorization",
              retryable: false,
              cause: new Error("Native policy refused"),
            });
          const permissionMode: NativePermissionMode =
            next === "ask"
              ? "auto"
              : next === "approve-for-me"
                ? "guardian-approvals"
                : "full-access";
          yield* SubscriptionRef.update(snapshot, (current) => ({
            ...current,
            metadata: {
              ...current.metadata!,
              permissionMode,
              effectiveSelection: {
                ...current.metadata?.effectiveSelection,
                model: current.metadata?.effectiveSelection?.model ?? null,
                effort: current.metadata?.effectiveSelection?.effort ?? null,
                permissionMode: next === "full-access" ? "bypassPermissions" : "default",
              },
            },
          }));
        }),
      readHistoryToolOutput: (nativeMessageId, toolUseId) =>
        Effect.gen(function* () {
          toolOutputReads.push([nativeMessageId, toolUseId]);
          yield* onToolOutputRead;
          return { text: "Native output", truncated: false, originalBytes: 13 };
        }),
      setMode: () => Effect.void,
      setConfigOption: () => Effect.succeed([]),
    };
    const close = Effect.gen(function* () {
      if (runtimeScope) yield* Scope.close(runtimeScope, Exit.void);
      live = null;
    });
    const manager = ClaudeSessionManager.of({
      nativeHome: () => Effect.sync(() => currentNativeHome),
      nativeCatalog: () => Effect.die("No catalog request"),
      nativeSessionInfo: () => Effect.die("No metadata request"),
      discover: () => Effect.die("No discovery"),
      models: () => Effect.die("No discovery"),
      open: (input) =>
        Effect.gen(function* () {
          openCalls += 1;
          hooks = input;
          executionRecoveryRequired = input.executionRecoveryRequired === true;
          runtimeSuspended = executionRecoveryRequired;
          if (executionRecoveryRequired)
            yield* SubscriptionRef.update(snapshot, (current) => ({
              ...current,
              status: "idle" as const,
              error: null,
            }));
          yield* onOpen;
          runtimeCwd = input.workspaceRoot;
          if (!executionRecoveryRequired) runtimeScope = yield* Scope.fork(ownerScope);
          if (input.acquireLaunchContext && runtimeScope)
            yield* input
              .acquireLaunchContext(input.workspaceRoot)
              .pipe(Scope.provide(runtimeScope));
          live = handle;
          return handle;
        }),
      get: () => Effect.succeed(live),
      close: () => close,
      observe: () => Effect.void,
      unobserve: () => Effect.void,
      changes: Stream.empty,
    });
    const application = makeApplication.pipe(
      Effect.provideService(ClaudeSessionManager, manager),
      Effect.provideService(AcpBackendSessionManager, {
        get: () => Effect.succeed(null),
        open: () => Effect.die("No ACP launch"),
        close: () => Effect.void,
        observe: () => Effect.void,
        unobserve: () => Effect.void,
        changes: Stream.empty,
      }),
      Effect.provideService(AgentBackendRegistry, {
        resolve: (selected) =>
          Effect.succeed({
            kind: "claude",
            binding: selected as typeof binding,
            displayName: "Claude",
            instance: {} as never,
          }),
        resolveAcpInstance: () => Effect.die("No ACP binding"),
      }),
      Effect.provideService(ProjectWorkspace, {
        readThreadExecutionContext: () =>
          Effect.succeed({
            projectId: currentProjectId,
            permissionMode: currentPermissionMode,
            writableRoots: [extraRoot],
            workspaceState: null,
          }),
        getThread: () =>
          Effect.gen(function* () {
            if (pauseNextRead) {
              pauseNextRead = false;
              yield* Deferred.succeed(authorityReadBlocked, undefined);
              yield* Deferred.await(releaseAuthorityRead);
            }
            return {
              threadId: "native",
              projectId: currentProjectId,
              sessionId: "session",
              backendBinding: threadBinding,
              cwd: currentCwd,
              managedWorktreePath: currentManagedWorktreePath,
              archived: false,
              executionHostId: "local",
              statusType: statuses.at(-1) ?? "idle",
              updatedAt: 1,
            };
          }),
        getProject: () =>
          Effect.succeed({
            id: "project",
            lifecycle: projectActive ? "active" : "archived",
            primaryWorkspaceRoot: "/workspace",
          }),
        readProjectPermissionMode: () => Effect.succeed(currentPermissionMode),
        readProjectlessPermissionMode: Effect.sync(() => currentPermissionMode),
        setProjectPermissionMode: (projectId: string, mode: CodexPermissionMode) =>
          Effect.gen(function* () {
            yield* beforePermissionWrite;
            if (failPermissionWrite)
              return yield* agentRuntimeError({
                operation: "Core permission",
                reason: "authorization",
                retryable: false,
                cause: new Error("Core permission write refused"),
              });
            permissionWrites.push({ projectId, mode });
            currentPermissionMode = mode;
            yield* afterPermissionWrite;
            return mode;
          }),
        setProjectlessPermissionMode: (mode: CodexPermissionMode) =>
          Effect.gen(function* () {
            yield* beforePermissionWrite;
            if (failPermissionWrite)
              return yield* agentRuntimeError({
                operation: "Core permission",
                reason: "authorization",
                retryable: false,
                cause: new Error("Core permission write refused"),
              });
            permissionWrites.push({ projectId: null, mode });
            currentPermissionMode = mode;
            yield* afterPermissionWrite;
            return mode;
          }),
        readThreadBackendSession: () =>
          Effect.succeed(
            currentId
              ? {
                  threadId: "native",
                  backendBinding: binding,
                  backendSessionId: currentId,
                  nativeHome: "/native-home",
                  nativeState,
                  updatedAt: 1,
                }
              : null,
          ),
        updateThread: (_id: string, patch: { status?: { statusType: string } }) =>
          Effect.gen(function* () {
            if (failStatus)
              return yield* agentRuntimeError({
                operation: "Core status",
                reason: "authorization",
                retryable: false,
                cause: new Error("Core status refused"),
              });
            if (patch.status) statuses.push(patch.status.statusType);
            return {};
          }),
        bindThreadBackendSession: (input: {
          backendSessionId: string;
          expectedBackendSessionId?: string;
          nativeState?: DesktopProjectWorkspaceNativeAgentState;
        }) =>
          Effect.gen(function* () {
            bound.push(input);
            if (pauseInitialBind && currentId === null) {
              pauseInitialBind = false;
              yield* Deferred.succeed(initialBindStarted, undefined);
              yield* Deferred.await(releaseInitialBind);
            }
            if (
              failBinding ||
              (input.expectedBackendSessionId && input.expectedBackendSessionId !== currentId)
            )
              return yield* agentRuntimeError({
                operation: "Core identity",
                reason: "authorization",
                retryable: false,
                cause: new Error("Core identity compare-and-set refused"),
              });
            currentId = input.backendSessionId;
            if (input.nativeState) nativeState = input.nativeState;
            if (pauseAfterModel && nativeState.preferences.model === pauseAfterModel) {
              pauseAfterModel = null;
              pauseNextRead = true;
            }
          }),
      } as never),
      Effect.provideService(NativeTurnAuthority, {
        freeze: (input) =>
          Effect.sync(() => {
            freezeCalls += 1;
            return {
              threadId: input.threadId,
              turnId: input.turnId,
              rootThreadId: input.threadId,
              actorProjectId: input.projectId,
              libraryId: "library",
              storeEpoch: "epoch",
              frozenAtMs: 1,
              scope: "project",
              source: "project_turn",
              readOnly: input.readOnly,
            } as FrozenNodexAgentTurnAuthority;
          }),
      }),
      Effect.provideService(NativeAppToolSession, {
        acquire: (input) =>
          Effect.gen(function* () {
            const issued = createNativeAppToolClaimIssuer({
              ...input,
              capture: () => input.isCurrent,
            });
            issuer = issued;
            yield* Effect.addFinalizer(() => Effect.sync(issued.close));
            return {
              launchContext: { systemPromptAppend: "Trusted application tools", mcpServers: {} },
              beginTurn: (authority) => Effect.sync(() => issued.beginTurn(authority)),
              endTurn: issued.endTurn,
              setBackgroundTasks: issued.setBackgroundTasks,
              revoke: issued.close,
            };
          }),
      }),
      Effect.provideService(CodexPlatform, {
        runtime: {
          browserRuntime: { status: "available", bundle: { paths: { node: "/fixture/node" } } },
        },
      } as never),
      Effect.provideService(NativePromptImages, {
        prepare: () =>
          onPrepareImages.pipe(Effect.as([{ mediaType: "image/png" as const, data: "YWJj" }])),
        materialize: () => Effect.die("Unexpected image materialization"),
      }),
      Effect.provide(configLayer()),
    );
    return {
      executionRecoveryRequired: () => executionRecoveryRequired,
      runtimeSuspended: () => runtimeSuspended,
      suspendedCalls: () => suspendedCalls,
      application,
      snapshot,
      statuses,
      runtimeLocations,
      launchDirectories,
      commitExecutionLocation: (cwd: string, managedWorktreePath: string | null = null) =>
        Effect.sync(() => {
          currentCwd = cwd;
          extraRoot = cwd;
          currentManagedWorktreePath = managedWorktreePath;
        }),
      bound,
      setFailStatus: (value: boolean) => {
        failStatus = value;
      },
      setFailBinding: (value: boolean) => {
        failBinding = value;
      },
      claim: () => issuer?.claim() ?? null,
      identity: () => currentId,
      openCalls: () => openCalls,
      changeNativeHome: () => {
        currentNativeHome = "/other-home";
      },
      pauseInitialBind: () => {
        pauseInitialBind = true;
      },
      initialBindStarted: Deferred.await(initialBindStarted),
      releaseInitialBind: Deferred.succeed(releaseInitialBind, undefined),
      promptStarted: Deferred.await(promptStarted),
      finishPrompt: Deferred.succeed(finishPrompt, undefined),
      promptCalls: () => promptCalls,
      sentCalls: () => sentCalls,
      policyCalls: () => policyCalls,
      policies,
      permissionWrites,
      permissionMode: () => currentPermissionMode,
      changePermissionMode: (mode: CodexPermissionMode | null) => {
        currentPermissionMode = mode;
      },
      setProjectless: () => {
        currentProjectId = null;
      },
      setProjectArchived: () => {
        projectActive = false;
      },
      rejectPolicy: (policy: AgentSessionPermissionPolicy) => {
        rejectedPolicies.add(policy);
      },
      setFailPermissionWrite: () => {
        failPermissionWrite = true;
      },
      beforePermissionWrite: (effect: Effect.Effect<void>) => {
        beforePermissionWrite = effect;
      },
      afterPermissionWrite: (effect: Effect.Effect<void, AgentRuntimeError>) => {
        afterPermissionWrite = effect;
      },
      beforePermissionPolicy: (read: typeof beforePermissionPolicy) => {
        beforePermissionPolicy = read;
      },
      intelligenceCalls: () => intelligenceCalls,
      freezeCalls: () => freezeCalls,
      rebindSession: (sessionId: string) => {
        currentId = sessionId;
      },
      commitNativeIdentity: (sessionId: string) =>
        Effect.sync(() => {
          nativeId = sessionId;
        }),
      nativeLive: () => live !== null,
      changeRoots: () => {
        extraRoot = "/other-root";
      },
      changeProject: () => {
        currentProjectId = "reassigned-project";
      },
      onOpen: (effect: Effect.Effect<void>) => {
        onOpen = effect;
      },
      prepareImages: (effect: Effect.Effect<void>) => {
        onPrepareImages = effect;
      },
      toolOutputReads,
      onToolOutputRead: (effect: Effect.Effect<void>) => {
        onToolOutputRead = effect;
      },
      pauseAdmissionAfterSelection: (model: string) => {
        pauseAfterModel = model;
      },
      authorityReadBlocked: Deferred.await(authorityReadBlocked),
      releaseAuthorityRead: Deferred.succeed(releaseAuthorityRead, undefined),
      changeBinding: () => {
        threadBinding = { ...binding, instanceConfigId: "other" };
      },
      hooks: () => {
        if (!hooks) throw new Error("Open the native session first");
        return hooks;
      },
    };
  });
const makeFixture = makeFixtureWithInitialBinding(true);

const nativeDestination = {
  hostId: "local",
  projectId: "project",
  cwd: "/destination",
  workspaceRoots: ["/destination"],
  managedWorktreePath: null,
  projectlessOutputDirectory: null,
  projectlessWorkspaceBrowserRoot: null,
} as const;

it.effect("failed Git recovery seals the retained source until the verified retry completes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const app = yield* fixture.application;
      yield* app.openAgentSession({ threadId: "native" });
      const submission = {
        threadId: "native",
        operationId: "retry-recovered-files",
        prompt: "resume safely",
      };
      const failed = yield* Effect.result(
        app.withAgentExecutionHandoff(
          "native",
          Effect.gen(function* () {
            yield* app.setExecutionRecoveryRequired("native", true);
            yield* app.nativeConversations.stopExecution("native");
            return yield* agentRuntimeError({
              operation: "Git rollback",
              reason: "request",
              retryable: false,
              cause: new Error("Source files need recovery"),
            });
          }),
        ),
      );
      assert.equal(failed._tag, "Failure");
      assert.isTrue(fixture.runtimeSuspended());
      assert.isTrue(fixture.executionRecoveryRequired());
      assert.deepEqual(fixture.runtimeLocations, []);
      assert.equal((yield* app.readAgentSession("native"))?.snapshot.sessionId, durableId);
      assert.equal(
        (yield* Effect.result(app.nativeConversations.submit(submission)))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.result(app.controlAgentSession({ threadId: "native", kind: "compact" })))
          ._tag,
        "Failure",
      );
      yield* app.withAgentExecutionHandoff(
        "native",
        Effect.gen(function* () {
          yield* app.nativeConversations.stopExecution("native");
          yield* app.withAgentExecutionLocation(
            "native",
            { ...nativeDestination, cwd: "/workspace", workspaceRoots: ["/workspace"] },
            Effect.void,
          );
          yield* app.setExecutionRecoveryRequired("native", false);
        }),
      );
      assert.isFalse(fixture.runtimeSuspended());
      assert.isFalse(fixture.executionRecoveryRequired());
      const accepted = yield* app.nativeConversations.submit(submission);
      yield* fixture.finishPrompt;
      assert.equal(
        (yield* app.nativeConversations.wait("native", accepted.turnId)).outcome,
        "completed",
      );
    }),
  ),
);

it.effect(
  "unresolved runtime and Core locations retain their sealed native owner for recovery",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const app = yield* fixture.application;
        yield* app.openAgentSession({ threadId: "native" });
        yield* app.withAgentExecutionHandoff(
          "native",
          Effect.gen(function* () {
            yield* app.setExecutionRecoveryRequired("native", true);
            yield* app.nativeConversations.stopExecution("native");
            const failed = yield* Effect.result(
              app.withAgentExecutionLocation(
                "native",
                nativeDestination,
                fixture.commitExecutionLocation("/destination").pipe(
                  Effect.andThen(
                    Effect.fail(
                      agentRuntimeError({
                        operation: "Core rollback",
                        reason: "authorization",
                        retryable: false,
                        cause: new Error("Core still retains destination"),
                      }),
                    ),
                  ),
                ),
              ),
            );
            assert.equal(failed._tag, "Failure");
          }),
        );
        assert.isTrue(fixture.runtimeSuspended());
        assert.isTrue(fixture.nativeLive());
        assert.equal((yield* app.readAgentSession("native"))?.snapshot.sessionId, durableId);
        assert.equal(
          (yield* Effect.result(app.setExecutionRecoveryRequired("native", false)))._tag,
          "Failure",
        );
        assert.isTrue(fixture.nativeLive());
        yield* app.withAgentExecutionHandoff(
          "native",
          Effect.gen(function* () {
            const unrelated = {
              ...nativeDestination,
              cwd: "/unrelated",
              workspaceRoots: ["/unrelated"],
            };
            assert.equal(
              (yield* Effect.result(
                app.withAgentExecutionLocation("native", unrelated, Effect.void),
              ))._tag,
              "Failure",
            );
            yield* app.withAgentExecutionLocation("native", nativeDestination, Effect.void);
            yield* app.setExecutionRecoveryRequired("native", false);
          }),
        );
        assert.isTrue(fixture.nativeLive());
        assert.isFalse(fixture.runtimeSuspended());
        assert.isFalse(fixture.executionRecoveryRequired());
        assert.deepEqual(fixture.launchDirectories, [
          ["/destination"],
          ["/workspace"],
          ["/destination"],
          ["/destination"],
        ]);
      }),
    ),
);

it.effect("startup recovery seals unopened native sessions without launching their runtime", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const app = yield* fixture.application;
      yield* app.nativeConversations.setExecutionRecoveryRequired("native", true);
      assert.equal(fixture.openCalls(), 0);
      assert.equal(
        (yield* Effect.result(app.openAgentSession({ threadId: "native" })))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.result(
          app.promptAgentSession({ threadId: "native", prompt: "unsafe source" }),
        ))._tag,
        "Failure",
      );
      yield* app.nativeConversations.withExecutionHandoff(
        "native",
        Effect.gen(function* () {
          assert.isTrue(fixture.hooks().executionRecoveryRequired);
          assert.isTrue(fixture.runtimeSuspended());
          assert.deepEqual(fixture.runtimeLocations, []);
          yield* app.nativeConversations.stopExecution("native");
          yield* app.withAgentExecutionLocation(
            "native",
            nativeDestination,
            fixture.commitExecutionLocation("/destination"),
          );
          yield* app.nativeConversations.setExecutionRecoveryRequired("native", false);
        }),
      );
      assert.isFalse(fixture.runtimeSuspended());
      assert.isTrue(fixture.nativeLive());
    }),
  ),
);

it.effect("internal recovery replaces a failed native runtime with the same deferred UUID", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const app = yield* fixture.application;
      yield* app.openAgentSession({ threadId: "native" });
      yield* app.setExecutionRecoveryRequired("native", true);
      yield* SubscriptionRef.update(fixture.snapshot, (snapshot) => ({
        ...snapshot,
        status: "failed" as const,
        error: "Native transport stopped",
      }));
      yield* app.withAgentExecutionHandoff(
        "native",
        Effect.gen(function* () {
          assert.equal(fixture.openCalls(), 2);
          assert.isTrue(fixture.hooks().executionRecoveryRequired);
          assert.isTrue(fixture.runtimeSuspended());
          assert.equal((yield* app.readAgentSession("native"))?.snapshot.sessionId, durableId);
          yield* app.withAgentExecutionLocation(
            "native",
            nativeDestination,
            fixture.commitExecutionLocation("/destination"),
          );
          yield* app.setExecutionRecoveryRequired("native", false);
        }),
      );
      assert.isTrue(fixture.nativeLive());
      assert.isFalse(fixture.runtimeSuspended());
      const accepted = yield* app.nativeConversations.submit({
        threadId: "native",
        operationId: "reopened-recovery",
        prompt: "after reconnect",
      });
      yield* fixture.finishPrompt;
      assert.equal(
        (yield* app.nativeConversations.wait("native", accepted.turnId)).outcome,
        "completed",
      );
    }),
  ),
);

it.effect("native handoff rejects submissions and mutations through preparation and cleanup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const app = yield* fixture.application;
      yield* app.openAgentSession({ threadId: "native" });
      const prepared = yield* Deferred.make<void>();
      const move = yield* Deferred.make<void>();
      const committed = yield* Deferred.make<void>();
      const clean = yield* Deferred.make<void>();
      const input = {
        threadId: "native",
        prompt: "retained draft",
        operationId: "retry-after-handoff",
      };
      const handoff = yield* app.nativeConversations
        .withExecutionHandoff(
          "native",
          Effect.gen(function* () {
            yield* app.nativeConversations.stopExecution("native");
            yield* Deferred.succeed(prepared, undefined);
            yield* Deferred.await(move);
            yield* app.withAgentExecutionLocation(
              "native",
              nativeDestination,
              fixture.commitExecutionLocation("/destination"),
            );
            yield* Deferred.succeed(committed, undefined);
            yield* Deferred.await(clean);
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(prepared);
      assert.isTrue(fixture.runtimeSuspended());
      assert.equal((yield* app.readAgentSession("native"))?.snapshot.sessionId, durableId);
      assert.isNotNull(yield* app.nativeConversations.read("native"));
      const mutations: readonly Effect.Effect<unknown, AgentBackendApplicationError | Error>[] = [
        app.promptAgentSession({ threadId: "native", prompt: "blocked draft" }),
        app.nativeConversations.submit(input),
        app.setAgentIntelligence({
          threadId: "native",
          selection: { model: "default", effort: "default" },
        }),
        app.setAgentMode({ threadId: "native", modeId: "plan" }),
        app.setAgentConfigOption({ threadId: "native", configId: "effort", value: "high" }),
        app.controlAgentSession({ threadId: "native", kind: "compact" }),
        app.controlAgentSession({
          threadId: "native",
          kind: "steer",
          prompt: "blocked steer",
          clientUserMessageId: createUuidV7(),
        }),
        app.forkAgentSession({ threadId: "native", nativeMessageId: "message" }),
        app.authenticateAgentSession({ threadId: "native", methodId: "reconnect" }),
        app.closeAgentSession("native"),
      ];
      for (const mutation of mutations)
        assert.equal((yield* Effect.result(mutation))._tag, "Failure");
      assert.equal(fixture.promptCalls(), 0);
      assert.equal(fixture.intelligenceCalls(), 0);
      yield* Deferred.succeed(move, undefined);
      yield* Deferred.await(committed);
      assert.isTrue(fixture.runtimeSuspended());
      assert.equal((yield* Effect.result(app.nativeConversations.submit(input)))._tag, "Failure");
      yield* Deferred.succeed(clean, undefined);
      yield* Fiber.join(handoff);
      assert.isFalse(fixture.runtimeSuspended());
      assert.equal(fixture.suspendedCalls(), 2);
      assert.equal((yield* app.readAgentSession("native"))?.snapshot.sessionId, durableId);
      const submission = yield* app.nativeConversations.submit(input);
      assert.isString(submission.turnId);
      assert.equal(fixture.promptCalls(), 1);
      yield* fixture.finishPrompt;
      assert.equal(
        (yield* app.nativeConversations.wait("native", submission.turnId)).outcome,
        "completed",
      );
    }),
  ),
);

it.effect("cancelled native preparation releases admission and restores the source Query", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const app = yield* fixture.application;
      yield* app.openAgentSession({ threadId: "native" });
      const prepared = yield* Deferred.make<void>();
      const paused = yield* Deferred.make<void>();
      const handoff = yield* app
        .withAgentExecutionHandoff(
          "native",
          app.nativeConversations
            .stopExecution("native")
            .pipe(
              Effect.andThen(Deferred.succeed(prepared, undefined)),
              Effect.andThen(Deferred.await(paused)),
            ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(prepared);
      assert.equal(
        (yield* Effect.result(app.withAgentExecutionHandoff("native", Effect.void)))._tag,
        "Failure",
      );
      yield* Fiber.interrupt(handoff);
      assert.isFalse(fixture.runtimeSuspended());
      assert.deepEqual(fixture.runtimeLocations, ["/workspace"]);
      const accepted = yield* app.nativeConversations.submit({
        threadId: "native",
        operationId: "after-cancel",
        prompt: "continue source",
      });
      yield* fixture.finishPrompt;
      assert.equal(
        (yield* app.nativeConversations.wait("native", accepted.turnId)).outcome,
        "completed",
      );
    }),
  ),
);

it.effect(
  "native execution commits the exact prepared location while external reads stay fenced",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const app = yield* fixture.application;
        yield* app.openAgentSession({ threadId: "native" });
        const result = yield* app.withAgentExecutionLocation(
          "native",
          nativeDestination,
          Effect.gen(function* () {
            assert.deepEqual(fixture.runtimeLocations, ["/destination"]);
            assert.deepEqual(fixture.launchDirectories, [["/destination"]]);
            assert.equal((yield* Effect.result(app.readAgentSession("native")))._tag, "Failure");
            assert.isTrue(fixture.nativeLive());
            yield* fixture.commitExecutionLocation("/destination");
            return "committed";
          }),
        );
        assert.equal(result, "committed");
        assert.equal((yield* app.readAgentSession("native"))?.snapshot.sessionId, durableId);
        assert.equal(fixture.openCalls(), 1);
        assert.equal(fixture.sentCalls(), 0);
        assert.isTrue(fixture.nativeLive());
      }),
    ),
);

it.effect("native relocation rejects unrelated Core location and restores source Query", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const app = yield* fixture.application;
      yield* app.openAgentSession({ threadId: "native" });
      assert.equal(
        (yield* Effect.result(
          app.withAgentExecutionLocation("native", nativeDestination, Effect.void),
        ))._tag,
        "Failure",
      );
      assert.deepEqual(fixture.runtimeLocations, ["/destination", "/workspace"]);
      assert.deepEqual(fixture.launchDirectories, [["/destination"], ["/workspace"]]);
      assert.equal((yield* app.readAgentSession("native"))?.snapshot.sessionId, durableId);
      assert.isTrue(fixture.nativeLive());
      assert.equal(fixture.sentCalls(), 0);
    }),
  ),
);

it.effect(
  "native relocation rejects changed Project and remote destinations before runtime switch",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const app = yield* fixture.application;
        yield* app.openAgentSession({ threadId: "native" });
        for (const destination of [
          { ...nativeDestination, projectId: "other-project" },
          { ...nativeDestination, hostId: "remote" },
          { ...nativeDestination, cwd: "/workspace", workspaceRoots: ["/workspace", "/unrelated"] },
        ])
          assert.equal(
            (yield* Effect.result(
              app.withAgentExecutionLocation("native", destination, Effect.void),
            ))._tag,
            "Failure",
          );
        assert.deepEqual(fixture.runtimeLocations, []);
        assert.isTrue(fixture.nativeLive());
      }),
    ),
);

it.effect(
  "native profile changes block resume and close an already opened conversation before execution",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const unopened = yield* makeFixture;
        const unopenedApp = yield* unopened.application;
        unopened.changeNativeHome();
        yield* Effect.flip(unopenedApp.openAgentSession({ threadId: "native" }));
        assert.equal(unopened.openCalls(), 0);
        const opened = yield* makeFixture;
        const app = yield* opened.application;
        yield* app.openAgentSession({ threadId: "native" });
        opened.changeNativeHome();
        yield* Effect.flip(app.promptAgentSession({ threadId: "native", prompt: "continue" }));
        assert.equal(opened.promptCalls(), 0);
        assert.isFalse(opened.nativeLive());
      }),
    ),
);

it.effect("native tool output is fenced before and after its exact history read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const app = yield* fixture.application;
      yield* app.openAgentSession({ threadId: "native" });
      const input = {
        threadId: "native",
        expectedSessionId: durableId,
        nativeMessageId: "result",
        toolUseId: "bash",
      };
      yield* Effect.flip(app.readAgentToolOutput({ ...input, expectedSessionId: "foreign" }));
      assert.deepEqual(fixture.toolOutputReads, []);
      assert.deepEqual(yield* app.readAgentToolOutput(input), {
        text: "Native output",
        truncated: false,
        originalBytes: 13,
      });
      assert.deepEqual(fixture.toolOutputReads, [["result", "bash"]]);
      fixture.onToolOutputRead(Effect.sync(fixture.changeBinding));
      yield* Effect.flip(app.readAgentToolOutput(input));
      assert.isNull(fixture.claim());
    }),
  ),
);

it.effect("concurrent native opens and controls wait for the first Core identity publication", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixtureWithInitialBinding(false);
      const app = yield* fixture.application;
      fixture.pauseInitialBind();
      const opening = yield* app.openAgentSession({ threadId: "native" }).pipe(Effect.forkChild);
      yield* fixture.initialBindStarted;
      const duplicate = yield* app.openAgentSession({ threadId: "native" }).pipe(Effect.forkChild);
      const reading = yield* app.readAgentSession("native").pipe(Effect.forkChild);
      const changing = yield* app
        .setAgentIntelligence({
          threadId: "native",
          selection: { model: "model-a", effort: "default" },
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.isUndefined(duplicate.pollUnsafe());
      assert.isUndefined(reading.pollUnsafe());
      assert.isUndefined(changing.pollUnsafe());
      assert.isNull(fixture.identity());
      assert.isTrue(fixture.nativeLive());
      assert.equal(fixture.intelligenceCalls(), 0);
      assert.equal(fixture.openCalls(), 1);
      yield* fixture.releaseInitialBind;
      assert.equal((yield* Fiber.join(opening)).snapshot.sessionId, durableId);
      assert.equal((yield* Fiber.join(duplicate)).snapshot.sessionId, durableId);
      assert.equal((yield* Fiber.join(reading))?.snapshot.sessionId, durableId);
      yield* Fiber.join(changing);
      assert.equal(fixture.identity(), durableId);
      assert.isTrue(fixture.nativeLive());
      assert.equal(fixture.intelligenceCalls(), 1);
      assert.equal(fixture.openCalls(), 1);
    }),
  ),
);

it.effect("native draft permission selection launches from Core without Codex requirements", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const projectId of ["project", null]) {
        const fixture = yield* makeFixture;
        if (projectId === null) fixture.setProjectless();
        const app = yield* fixture.application;
        assert.equal(yield* app.readNativePermissionMode(projectId), "auto");
        assert.equal(yield* app.setNativePermissionMode(projectId, "full-access"), "full-access");
        yield* app.openAgentSession({ threadId: "native" });
        assert.equal(fixture.hooks().permissionPolicy, "full-access");
        assert.equal(yield* fixture.hooks().readPermissionPolicy!, "full-access");
        assert.deepEqual(fixture.permissionWrites, [{ projectId, mode: "full-access" }]);
        fixture.changePermissionMode("auto");
        assert.equal(yield* fixture.hooks().readPermissionPolicy!, "ask");
      }
    }),
  ),
);

it.effect(
  "live native permissions apply and persist distinct Ask, automatic approval and Full access",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const app = yield* fixture.application;
        yield* app.openAgentSession({ threadId: "native" });
        for (const mode of ["guardian-approvals", "full-access", "auto"] as const) {
          const result = yield* app.controlAgentSession({
            threadId: "native",
            kind: "permission-mode",
            mode,
          });
          assert.equal(fixture.permissionMode(), mode);
          assert.equal(result.snapshot.metadata?.permissionMode, mode);
          assert.equal(
            result.snapshot.metadata?.effectiveSelection?.permissionMode,
            mode === "full-access" ? "bypassPermissions" : "default",
          );
          assert.equal(
            yield* fixture.hooks().readPermissionPolicy!,
            mode === "auto" ? "ask" : mode === "full-access" ? "full-access" : "approve-for-me",
          );
        }
        assert.deepEqual(fixture.permissionWrites, [
          { projectId: "project", mode: "guardian-approvals" },
          { projectId: "project", mode: "full-access" },
          { projectId: "project", mode: "auto" },
        ]);
      }),
    ),
);

it.effect("a refused native permission selection cannot save a misleading Core preference", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const app = yield* fixture.application;
      yield* app.openAgentSession({ threadId: "native" });
      fixture.rejectPolicy("full-access");
      yield* Effect.flip(
        app.controlAgentSession({
          threadId: "native",
          kind: "permission-mode",
          mode: "full-access",
        }),
      );
      assert.equal(fixture.permissionMode(), "auto");
      assert.lengthOf(fixture.permissionWrites, 0);
      assert.deepEqual(fixture.policies, ["ask", "full-access", "ask"]);
      assert.isTrue(fixture.nativeLive());
      assert.equal((yield* SubscriptionRef.get(fixture.snapshot)).metadata?.permissionMode, "auto");
    }),
  ),
);

it.effect("an uncertain Core permission save closes its owner without claiming a rollback", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const app = yield* fixture.application;
      yield* app.openAgentSession({ threadId: "native" });
      fixture.setFailPermissionWrite();
      yield* Effect.flip(
        app.controlAgentSession({
          threadId: "native",
          kind: "permission-mode",
          mode: "full-access",
        }),
      );
      assert.equal(fixture.permissionMode(), "auto");
      assert.lengthOf(fixture.permissionWrites, 0);
      assert.deepEqual(fixture.policies, ["ask", "full-access"]);
      assert.isFalse(fixture.nativeLive());
    }),
  ),
);

it.effect("native permission changes reject Custom and inactive Projects before writing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const app = yield* fixture.application;
      fixture.changePermissionMode("custom");
      assert.equal(yield* app.readNativePermissionMode("project"), "auto");
      yield* Effect.flip(app.setNativePermissionMode("project", "custom" as NativePermissionMode));
      fixture.setProjectArchived();
      yield* Effect.flip(app.setNativePermissionMode("project", "full-access"));
      assert.lengthOf(fixture.permissionWrites, 0);
      assert.equal(fixture.openCalls(), 0);
    }),
  ),
);

it.effect("cancelling an uncommitted native permission change restores its previous policy", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const app = yield* fixture.application;
      const saving = yield* Deferred.make<void>();
      yield* app.openAgentSession({ threadId: "native" });
      fixture.beforePermissionPolicy((policy) =>
        policy === "full-access"
          ? Deferred.succeed(saving, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.void,
      );
      const changing = yield* app
        .controlAgentSession({
          threadId: "native",
          kind: "permission-mode",
          mode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(saving);
      assert.equal((yield* SubscriptionRef.get(fixture.snapshot)).metadata?.permissionMode, "auto");
      yield* Fiber.interrupt(changing);
      assert.equal(fixture.permissionMode(), "auto");
      assert.lengthOf(fixture.permissionWrites, 0);
      assert.deepEqual(fixture.policies, ["ask", "full-access", "ask"]);
      assert.equal((yield* SubscriptionRef.get(fixture.snapshot)).metadata?.permissionMode, "auto");
      assert.isTrue(fixture.nativeLive());
      fixture.beforePermissionPolicy(() => Effect.void);
      yield* app.controlAgentSession({
        threadId: "native",
        kind: "permission-mode",
        mode: "full-access",
      });
      assert.equal(fixture.permissionMode(), "full-access");
    }),
  ),
);

it.effect("cancellation after a Core permission commit retains the confirmed native policy", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const projectless of [false, true]) {
        const fixture = yield* makeFixture;
        const app = yield* fixture.application;
        if (projectless) fixture.setProjectless();
        yield* app.openAgentSession({ threadId: "native" });
        const committed = yield* Deferred.make<void>();
        const releaseRead = yield* Deferred.make<void>();
        fixture.afterPermissionWrite(
          Deferred.succeed(committed, undefined).pipe(Effect.andThen(Deferred.await(releaseRead))),
        );
        const changing = yield* app
          .controlAgentSession({
            threadId: "native",
            kind: "permission-mode",
            mode: "full-access",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(committed);
        const interrupting = yield* Fiber.interrupt(changing).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        assert.equal(fixture.permissionMode(), "full-access");
        yield* Deferred.succeed(releaseRead, undefined);
        yield* Fiber.join(interrupting);
        assert.isTrue(Exit.isFailure(yield* Fiber.await(changing)));
        assert.deepEqual(fixture.permissionWrites, [
          { projectId: projectless ? null : "project", mode: "full-access" },
        ]);
        assert.deepEqual(fixture.policies, ["ask", "full-access"]);
        assert.equal(
          (yield* SubscriptionRef.get(fixture.snapshot)).metadata?.permissionMode,
          "full-access",
        );
        assert.isTrue(fixture.nativeLive());
      }
    }),
  ),
);

it.effect(
  "a failed read after a Core permission commit closes the owner and preserves durable truth",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const app = yield* fixture.application;
        yield* app.openAgentSession({ threadId: "native" });
        fixture.afterPermissionWrite(
          Effect.fail(
            agentRuntimeError({
              operation: "Core permission read",
              reason: "request",
              retryable: false,
              cause: new Error("Read failed after commit"),
            }),
          ),
        );
        yield* Effect.flip(
          app.controlAgentSession({
            threadId: "native",
            kind: "permission-mode",
            mode: "full-access",
          }),
        );
        assert.equal(fixture.permissionMode(), "full-access");
        assert.deepEqual(fixture.policies, ["ask", "full-access"]);
        assert.isFalse(fixture.nativeLive());
        fixture.afterPermissionWrite(Effect.void);
        const reopened = yield* app.openAgentSession({ threadId: "native" });
        assert.equal(reopened.snapshot.metadata?.permissionMode, "full-access");
      }),
    ),
);

it.effect("permission persistence has a deadline even when the caller has cancelled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const app = yield* fixture.application;
      yield* app.openAgentSession({ threadId: "native" });
      const committed = yield* Deferred.make<void>();
      fixture.afterPermissionWrite(
        Deferred.succeed(committed, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const changing = yield* app
        .controlAgentSession({
          threadId: "native",
          kind: "permission-mode",
          mode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(committed);
      const interrupting = yield* Fiber.interrupt(changing).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(interrupting);
      assert.isTrue(Exit.isFailure(yield* Fiber.await(changing)));
      assert.equal(fixture.permissionMode(), "full-access");
      assert.deepEqual(fixture.policies, ["ask", "full-access"]);
      assert.isFalse(fixture.nativeLive());
    }),
  ),
);

it.effect("a failed initial native binding releases its owner and every pending opener", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixtureWithInitialBinding(false);
      const app = yield* fixture.application;
      fixture.pauseInitialBind();
      fixture.setFailBinding(true);
      const opening = yield* app
        .openAgentSession({ threadId: "native" })
        .pipe(Effect.exit, Effect.forkChild);
      yield* fixture.initialBindStarted;
      const duplicate = yield* app
        .openAgentSession({ threadId: "native" })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* fixture.releaseInitialBind;
      assert.isTrue(Exit.isFailure(yield* Fiber.join(opening)));
      assert.isTrue(Exit.isFailure(yield* Fiber.join(duplicate)));
      assert.isFalse(fixture.nativeLive());
      assert.isNull(fixture.identity());
      fixture.setFailBinding(false);
      yield* app.openAgentSession({ threadId: "native" });
      assert.equal(fixture.identity(), durableId);
      assert.equal(fixture.openCalls(), 2);
    }),
  ),
);

it.effect(
  "interrupting an initial opener clears its handoff while a waiter cannot cancel its owner",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixtureWithInitialBinding(false);
        const app = yield* fixture.application;
        fixture.pauseInitialBind();
        const opening = yield* app.openAgentSession({ threadId: "native" }).pipe(Effect.forkChild);
        yield* fixture.initialBindStarted;
        const waiter = yield* app.openAgentSession({ threadId: "native" }).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(waiter);
        assert.isTrue(fixture.nativeLive());
        assert.isUndefined(opening.pollUnsafe());
        const observer = yield* app.readAgentSession("native").pipe(Effect.exit, Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(opening);
        assert.isTrue(Exit.isFailure(yield* Fiber.join(observer)));
        assert.isFalse(fixture.nativeLive());
        assert.isNull(fixture.identity());
        yield* app.openAgentSession({ threadId: "native" });
        assert.equal(fixture.identity(), durableId);
        assert.equal(fixture.openCalls(), 2);
      }),
    ),
);

it.effect(
  "same-profile Core rebinding cannot publish, control, send, or overwrite a stale owner",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const actions = ["read", "open", "intelligence", "prompt"] as const;
        for (const action of actions) {
          const fixture = yield* makeFixture;
          const app = yield* fixture.application;
          yield* app.openAgentSession({ threadId: "native" });
          fixture.rebindSession("rebound-native-session");
          const operation: Effect.Effect<unknown, Error> =
            action === "read"
              ? app.readAgentSession("native")
              : action === "open"
                ? app.openAgentSession({ threadId: "native" })
                : action === "intelligence"
                  ? app.setAgentIntelligence({
                      threadId: "native",
                      selection: { model: "default", effort: "default" },
                    })
                  : app.promptAgentSession({ threadId: "native", prompt: "stale" });
          assert.isTrue(Exit.isFailure(yield* Effect.exit(operation)));
          assert.equal(fixture.identity(), "rebound-native-session");
          assert.equal(fixture.policyCalls(), 0, action);
          assert.equal(fixture.intelligenceCalls(), 0, action);
          assert.equal(fixture.sentCalls(), 0, action);
          assert.lengthOf(fixture.bound, 0, action);
        }
      }),
    ),
);

it.effect("repeated open preserves launch roots and rejects a changed execution context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const app = yield* fixture.application;
      yield* app.openAgentSession({ threadId: "native" });
      yield* app.openAgentSession({ threadId: "native" });
      fixture.changeRoots();
      yield* Effect.flip(app.openAgentSession({ threadId: "native" }));
      assert.isFalse(fixture.nativeLive());
      assert.equal(fixture.intelligenceCalls(), 0);
      assert.lengthOf(fixture.bound, 0);
    }),
  ),
);

it.effect(
  "new native owner opening rechecks Core identity and roots after the asynchronous launch",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const drift of ["identity", "roots"] as const) {
          const fixture = yield* makeFixture;
          const app = yield* fixture.application;
          fixture.onOpen(
            Effect.sync(() => {
              if (drift === "identity") fixture.rebindSession("rebound-native-session");
              else fixture.changeRoots();
            }),
          );
          yield* Effect.flip(app.openAgentSession({ threadId: "native" }));
          assert.isFalse(fixture.nativeLive());
          assert.equal(fixture.sentCalls(), 0);
          assert.lengthOf(fixture.bound, 0);
          if (drift === "identity") assert.equal(fixture.identity(), "rebound-native-session");
        }
      }),
    ),
);

it.effect("native admission rechecks Core identity after asynchronous image preparation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const app = yield* fixture.application;
      yield* app.openAgentSession({ threadId: "native" });
      fixture.prepareImages(Effect.sync(() => fixture.rebindSession("rebound-native-session")));
      yield* Effect.flip(
        app.promptAgentSession({
          threadId: "native",
          prompt: "look",
          images: [{ source: "/fixture/image.png" }],
        }),
      );
      assert.equal(fixture.freezeCalls(), 0);
      assert.equal(fixture.sentCalls(), 0);
      assert.deepEqual(fixture.statuses, []);
      assert.lengthOf(fixture.bound, 0);
      assert.isNull(fixture.claim());
    }),
  ),
);

it.effect("native history refuses a Core identity changed during a delayed read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const app = yield* fixture.application;
      yield* app.openAgentSession({ threadId: "native" });
      fixture.onToolOutputRead(Effect.sync(() => fixture.rebindSession("rebound-native-session")));
      yield* Effect.flip(
        app.readAgentToolOutput({
          threadId: "native",
          expectedSessionId: durableId,
          nativeMessageId: "result",
          toolUseId: "bash",
        }),
      );
      assert.lengthOf(fixture.toolOutputReads, 1);
      assert.equal(fixture.identity(), "rebound-native-session");
      assert.lengthOf(fixture.bound, 0);
    }),
  ),
);

it.effect("a stale native settlement cannot write its identity or idle status back to Core", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const app = yield* fixture.application;
      yield* app.openAgentSession({ threadId: "native" });
      yield* fixture.hooks().onTurnAdmitted!({
        sequence: 1,
        clientUserMessageId: "accepted",
        text: "Run",
      });
      const claim = fixture.claim();
      fixture.rebindSession("rebound-native-session");
      yield* Effect.flip(
        fixture.hooks().onTurnSettled!({
          sequence: 1,
          clientUserMessageIds: ["accepted"],
          status: "completed",
          stopReason: "end_turn",
          nativeSessionId: durableId,
          everSaved: true,
        }),
      );
      assert.isFalse(claim?.isActive());
      assert.equal(fixture.identity(), "rebound-native-session");
      assert.lengthOf(fixture.bound, 0);
      assert.deepEqual(fixture.statuses, ["active"]);
    }),
  ),
);

it.effect(
  "native app claims revalidate Core identity and execution roots without a UI control",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const drift of ["identity", "roots", "profile", "project"] as const) {
          const fixture = yield* makeFixture;
          const app = yield* fixture.application;
          yield* app.openAgentSession({ threadId: "native" });
          yield* fixture.hooks().onTurnAdmitted!({
            sequence: 1,
            clientUserMessageId: "accepted",
            text: "Run",
          });
          const claim = fixture.claim();
          assert.isNotNull(claim);
          assert.isNotNull(
            yield* captureAppToolAuthority(claim!, { capture: () => Effect.die("No Codex") }),
          );
          if (drift === "identity") fixture.rebindSession("rebound-native-session");
          else if (drift === "roots") fixture.changeRoots();
          else if (drift === "profile") fixture.changeBinding();
          else fixture.changeProject();
          assert.isNull(
            yield* captureAppToolAuthority(claim!, { capture: () => Effect.die("No Codex") }),
          );
          assert.lengthOf(fixture.bound, 0);
        }
      }),
    ),
);

it.effect("trusted reset and rollback handoffs preserve the owner and reject stale callbacks", () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const reason of ["reset", "rollback"] as const) {
        const fixture = yield* makeFixture;
        const app = yield* fixture.application;
        yield* app.openAgentSession({ threadId: "native" });
        yield* fixture.hooks().onSessionIdentityChanged!({
          previousSessionId: durableId,
          sessionId: "next-native-session",
          reason,
          everSaved: false,
        });
        yield* Effect.flip(
          app.setAgentIntelligence({
            threadId: "native",
            selection: { model: "default", effort: "default" },
          }),
        );
        assert.isTrue(fixture.nativeLive());
        assert.equal(fixture.intelligenceCalls(), 0);
        yield* fixture.commitNativeIdentity("next-native-session");
        yield* app.setAgentIntelligence({
          threadId: "native",
          selection: { model: "default", effort: "default" },
        });
        assert.equal(fixture.bound.at(-1)?.expectedBackendSessionId, "next-native-session");
        yield* Effect.flip(
          fixture.hooks().onSessionIdentityChanged!({
            previousSessionId: durableId,
            sessionId: "stale-native-session",
            reason,
          }),
        );
        assert.equal(fixture.identity(), "next-native-session");
      }
    }),
  ),
);

const makeForkFixture = (projectless = false) =>
  Effect.gen(function* () {
    const projectId = projectless ? null : "project";
    const source = {
      threadId: "source",
      projectId,
      backendBinding: binding,
      cwd: "/managed/work",
      managedWorktreePath: projectless ? null : "/managed/work",
      projectlessOutputDirectory: projectless ? "/managed/work/outputs" : null,
      projectlessWorkspaceBrowserRoot: projectless ? "/managed/work/work" : null,
      archived: false,
      executionHostId: "local",
      threadName: "Source",
    };
    const threads = new Map([["source", source]]);
    const roots = new Map([["source", ["/managed/work", "/extra", "/repo/.git"]]]);
    const identities = new Map([["source", "source-native"]]);
    const nativeHomes = new Map([["source", "/native-home"]]);
    const handles = new Map<string, AgentSessionHandle>();
    const published: ProjectSessionThreadLinkInput[] = [];
    const forkBindings: { threadId: string; backendSessionId: string; nativeHome?: string }[] = [];
    const opened: string[] = [];
    let createdSessions = 0;
    let currentNativeHome = "/native-home";
    let changeProfileDuringAdmission = false;
    let onFork: Effect.Effect<void> = Effect.void;
    const newHandle = (threadId: string, sessionId: string) =>
      Effect.gen(function* () {
        const snapshot = yield* SubscriptionRef.make(
          emptyAgentConversationSnapshot({ backend: "claude", threadId, sessionId }),
        );
        const handle: AgentSessionHandle = {
          threadId,
          sessionId,
          snapshot,
          capabilities: {} as never,
          modes: null,
          configOptions: [],
          setPermissionPolicy: () => Effect.void,
          prompt: () => Effect.die("No native prompt"),
          cancel: Effect.void,
          setMode: () => Effect.void,
          setConfigOption: () => Effect.succeed([]),
          forkAt: () => onFork.pipe(Effect.as({ sessionId: "fork-native", messageIdMap: {} })),
        };
        handles.set(threadId, handle);
        return handle;
      });
    const app = yield* makeApplication.pipe(
      Effect.provideService(CodexGitProbe, {
        readPath: () => Effect.succeed("/tmp/nodex-missing-worktree-environment.json"),
        isNonGitWorkspace: () => Effect.succeed(false),
        isNonGitWorkspaceOnHost: () => Effect.succeed(false),
      }),
      Effect.provideService(ClaudeSessionManager, {
        nativeHome: () => Effect.sync(() => currentNativeHome),
        nativeCatalog: () => Effect.die("No catalog request"),
        nativeSessionInfo: () => Effect.die("No metadata request"),
        get: (threadId) => Effect.succeed(handles.get(threadId) ?? null),
        open: (input) =>
          Effect.gen(function* () {
            const existing = handles.get(input.threadId);
            if (existing) return existing;
            opened.push(input.threadId);
            return yield* newHandle(input.threadId, input.sessionId!);
          }),
        close: (threadId) =>
          Effect.sync(() => {
            handles.delete(threadId);
          }),
        observe: () => Effect.void,
        unobserve: () => Effect.void,
        changes: Stream.empty,
        models: () => Effect.die("No model request"),
        discover: () => Effect.die("No discovery"),
      }),
      Effect.provideService(AcpBackendSessionManager, {
        get: () => Effect.succeed(null),
        open: () => Effect.die("No ACP"),
        close: () => Effect.void,
        observe: () => Effect.void,
        unobserve: () => Effect.void,
        changes: Stream.empty,
      } as never),
      Effect.provideService(AgentBackendRegistry, {
        resolve: (selected) =>
          Effect.succeed({
            kind: "claude",
            binding: selected as typeof binding,
            displayName: "Claude",
            instance: {} as never,
          }),
        resolveAcpInstance: () => Effect.die("No ACP"),
      }),
      Effect.provideService(ProjectWorkspace, {
        getThread: (threadId: string) => Effect.succeed(threads.get(threadId) ?? null),
        getProject: () =>
          Effect.succeed({ id: "project", lifecycle: "active", primaryWorkspaceRoot: "/repo" }),
        readProjectPermissionMode: () => Effect.succeed("auto"),
        readProjectlessPermissionMode: Effect.succeed("auto"),
        readThreadExecutionContext: (threadId: string) =>
          Effect.sync(() => ({
            threadId,
            projectId,
            permissionMode: "auto",
            dynamicToolCatalogs: [],
            writableRoots: roots.get(threadId) ?? [],
            workspaceState: {
              revision: "1",
              pending: null,
              applied: {
                cwd: threads.get(threadId)?.cwd,
                projectSources: [],
                runtimeWorkspaceRoots: roots.get(threadId) ?? [],
              },
            },
          })),
        readThreadBackendSession: (threadId: string) =>
          Effect.sync(() =>
            identities.has(threadId)
              ? {
                  threadId,
                  backendBinding: binding,
                  backendSessionId: identities.get(threadId),
                  nativeHome: nativeHomes.get(threadId),
                  nativeState: null,
                  updatedAt: 1,
                }
              : null,
          ),
        createProjectSession: () =>
          Effect.sync(() => {
            createdSessions += 1;
            if (changeProfileDuringAdmission) currentNativeHome = "/changed-native-home";
            return {};
          }),
        upsertProjectSessionThreadLink: (input: ProjectSessionThreadLinkInput) =>
          Effect.sync(() => {
            published.push(input);
            const thread = {
              ...source,
              ...input,
              cwd: input.cwd!,
              backendBinding: binding,
              threadName: input.threadName ?? source.threadName,
              managedWorktreePath: input.managedWorktreePath ?? null,
              projectlessOutputDirectory: input.projectlessOutputDirectory ?? null,
              projectlessWorkspaceBrowserRoot: input.projectlessWorkspaceBrowserRoot ?? null,
            };
            threads.set(input.threadId, thread);
            roots.set(input.threadId, [...(input.runtimeWorkspaceRoots ?? [])]);
            return thread;
          }),
        updateThread: () => Effect.succeed({}),
        bindThreadBackendSession: (input: {
          threadId: string;
          backendSessionId: string;
          nativeHome?: string;
        }) =>
          Effect.sync(() => {
            identities.set(input.threadId, input.backendSessionId);
            if (input.nativeHome) nativeHomes.set(input.threadId, input.nativeHome);
            if (input.threadId !== "source") forkBindings.push(input);
          }),
      } as never),
    );
    yield* app.openAgentSession({ threadId: "source" });
    return {
      app,
      published,
      forkBindings,
      opened,
      createdSessions: () => createdSessions,
      changeProfileDuringAdmission: () => {
        changeProfileDuringAdmission = true;
      },
      driftAfterFork: (kind: "identity" | "roots") => {
        onFork = Effect.sync(() => {
          if (kind === "identity") identities.set("source", "rebound-native");
          else roots.set("source", ["/changed"]);
        });
      },
    };
  });

it.effect(
  "native forks retain worktree consumers, additional roots, and projectless directories",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const projectless of [false, true]) {
          const fixture = yield* makeForkFixture(projectless);
          yield* fixture.app.forkAgentSession({
            threadId: "source",
            nativeMessageId: "native-message",
          });
          assert.lengthOf(fixture.published, 1);
          assert.deepInclude(fixture.published[0]!, {
            cwd: "/managed/work",
            executionHostId: "local",
            managedWorktreePath: projectless ? null : "/managed/work",
            projectlessOutputDirectory: projectless ? "/managed/work/outputs" : null,
            projectlessWorkspaceBrowserRoot: projectless ? "/managed/work/work" : null,
          });
          assert.deepEqual(fixture.published[0]!.runtimeWorkspaceRoots, [
            "/managed/work",
            "/extra",
            "/repo/.git",
          ]);
        }
      }),
    ),
);

it.effect("native forks preserve their source home when the profile changes during admission", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeForkFixture();
      fixture.changeProfileDuringAdmission();
      const error = yield* Effect.flip(
        fixture.app.forkAgentSession({ threadId: "source", nativeMessageId: "native-message" }),
      );
      assert.equal(error.operation, "session.profile");
      assert.lengthOf(fixture.forkBindings, 1);
      assert.deepInclude(fixture.forkBindings[0]!, {
        backendSessionId: "fork-native",
        nativeHome: "/native-home",
      });
      assert.deepEqual(fixture.opened, ["source"]);
    }),
  ),
);

it.effect(
  "native forks reject identity or execution drift after the native asynchronous fork",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const drift of ["identity", "roots"] as const) {
          const fixture = yield* makeForkFixture();
          fixture.driftAfterFork(drift);
          yield* Effect.flip(
            fixture.app.forkAgentSession({ threadId: "source", nativeMessageId: "native-message" }),
          );
          assert.equal(fixture.createdSessions(), 0, drift);
          assert.lengthOf(fixture.published, 0, drift);
        }
      }),
    ),
);

it.effect("native Default persists requested intent independently of effective routing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const app = yield* fixture.application;
      yield* app.openAgentSession({ threadId: "native" });
      yield* app.setAgentIntelligence({
        threadId: "native",
        selection: { model: "default", effort: "default", fast: false },
      });
      assert.deepEqual(fixture.bound.at(-1)?.nativeState?.preferences, {
        model: "default",
        effort: "default",
        interaction_mode: "default",
        fast: false,
      });
      yield* app.setAgentIntelligence({
        threadId: "native",
        selection: { model: "default", effort: "default" },
      });
      assert.notProperty(fixture.bound.at(-1)!.nativeState!.preferences, "fast");
    }),
  ),
);

it.effect("a rejected native busy prompt cannot clear durable active status", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const app = yield* fixture.application;
      yield* app.openAgentSession({ threadId: "native" });
      yield* fixture.hooks().onTurnAdmitted!({
        sequence: 1,
        clientUserMessageId: "accepted",
        text: "running",
      });
      yield* SubscriptionRef.update(fixture.snapshot, (current) => ({
        ...current,
        status: "running" as const,
      }));
      yield* Effect.flip(app.promptAgentSession({ threadId: "native", prompt: "duplicate" }));
      assert.deepEqual(fixture.statuses, ["active"]);
      assert.isNotNull(fixture.claim());
    }),
  ),
);

it.effect(
  "Application suspends every native app claim while trusted background tasks are live",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const app = yield* fixture.application;
        yield* app.openAgentSession({ threadId: "native" });
        yield* fixture.hooks().onTurnAdmitted!({
          sequence: 1,
          clientUserMessageId: "accepted",
          text: "Run",
        });
        const issued = fixture.claim();
        assert.isTrue(issued?.isActive());
        yield* fixture.hooks().onBackgroundTasksChanged!(["ambient-watcher"]);
        assert.isFalse(issued?.isActive());
        assert.isNull(fixture.claim());
        yield* fixture.hooks().onBackgroundTasksChanged!([]);
        assert.isFalse(issued?.isActive());
        assert.isNotNull(fixture.claim());
        yield* app.closeAgentSession("native");
        assert.isNull(fixture.claim());
      }),
    ),
);

it.effect(
  "native settlement and scope closure revoke app claims before later durable failures",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const app = yield* fixture.application;
        yield* app.openAgentSession({ threadId: "native" });
        assert.isNull(fixture.claim());
        yield* fixture.hooks().onTurnAdmitted!({
          sequence: 1,
          clientUserMessageId: "accepted",
          text: "running",
        });
        const claim = fixture.claim();
        assert.isTrue(claim?.isActive());
        fixture.setFailBinding(true);
        yield* Effect.flip(
          fixture.hooks().onTurnSettled!({
            sequence: 1,
            clientUserMessageIds: ["accepted"],
            stopReason: "end_turn",
            status: "completed",
            nativeSessionId: durableId,
            everSaved: true,
          }),
        );
        assert.isFalse(claim?.isActive());
        assert.isNull(fixture.claim());
        yield* app.closeAgentSession("native");
        assert.isNull(fixture.claim());
      }),
    ),
);

it.effect("failed Core admission leaves no usable native app claim", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const app = yield* fixture.application;
      yield* app.openAgentSession({ threadId: "native" });
      fixture.setFailStatus(true);
      yield* Effect.flip(
        fixture.hooks().onTurnAdmitted!({
          sequence: 1,
          clientUserMessageId: "rejected",
          text: "blocked",
        }),
      );
      assert.isNull(fixture.claim());
    }),
  ),
);

it.effect("native reset persists with exact prior identity and refuses stale callbacks", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const app = yield* fixture.application;
      yield* app.openAgentSession({ threadId: "native" });
      yield* fixture.hooks().onSessionIdentityChanged!({
        previousSessionId: durableId,
        sessionId: "reset-session",
        reason: "reset",
      });
      assert.deepInclude(fixture.bound.at(-1), {
        backendSessionId: "reset-session",
        expectedBackendSessionId: durableId,
      });
      yield* Effect.flip(
        fixture.hooks().onSessionIdentityChanged!({
          previousSessionId: durableId,
          sessionId: "stale-session",
          reason: "reset",
        }),
      );
      assert.equal(fixture.identity(), "reset-session");
    }),
  ),
);

it.effect("closing a live native session revokes its accepted turn lease", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const app = yield* fixture.application;
      yield* app.openAgentSession({ threadId: "native" });
      yield* fixture.hooks().onTurnAdmitted!({
        sequence: 1,
        clientUserMessageId: "accepted",
        text: "running",
      });
      const claim = fixture.claim();
      assert.isTrue(claim?.isActive());
      yield* app.closeAgentSession("native");
      assert.isFalse(claim?.isActive());
      assert.isNull(fixture.claim());
    }),
  ),
);

it.effect("a rebound Core thread cannot use its former native handle", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const app = yield* fixture.application;
      yield* app.openAgentSession({ threadId: "native" });
      fixture.changeBinding();
      yield* Effect.flip(app.cancelAgentSession("native"));
    }),
  ),
);

it.effect(
  "native semantic submission is idempotent and unattended policy follows its exact accepted turn",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture;
        const app = yield* fixture.application;
        const input = {
          threadId: "native",
          operationId: "message:once",
          prompt: "Run",
          unattended: true,
        };
        const first = yield* app.nativeConversations.submit(input).pipe(Effect.forkChild);
        const duplicate = yield* app.nativeConversations.submit(input).pipe(Effect.forkChild);
        yield* fixture.promptStarted;
        const accepted = yield* Fiber.join(first);
        assert.deepEqual(yield* Fiber.join(duplicate), accepted);
        assert.equal(fixture.promptCalls(), 1);
        assert.isTrue(yield* fixture.hooks().isUnattended!);
        yield* SubscriptionRef.update(fixture.snapshot, (current) => ({
          ...current,
          turns: current.turns.map((turn) => ({
            ...turn,
            clientUserMessageId: "unrelated-user-turn",
          })),
        }));
        assert.isFalse(yield* fixture.hooks().isUnattended!);
        yield* SubscriptionRef.update(fixture.snapshot, (current) => ({
          ...current,
          turns: current.turns.map((turn) => ({ ...turn, clientUserMessageId: accepted.turnId })),
        }));
        yield* Effect.flip(app.nativeConversations.submit({ ...input, prompt: "Changed" }));
        yield* fixture.finishPrompt;
        assert.equal(
          (yield* app.nativeConversations.wait("native", accepted.turnId)).outcome,
          "completed",
        );
        assert.deepEqual(yield* app.nativeConversations.submit(input), accepted);
        assert.equal(fixture.promptCalls(), 1);
        assert.isFalse(yield* fixture.hooks().isUnattended!);
      }),
    ),
);

it.effect("native submission retains its model choice until its exact turn is admitted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const app = yield* fixture.application;
      yield* app.openAgentSession({ threadId: "native" });
      fixture.pauseAdmissionAfterSelection("model-a");
      const submitting = yield* app.nativeConversations
        .submit({
          threadId: "native",
          operationId: "atomic-choice",
          prompt: "Run",
          model: "model-a",
        })
        .pipe(Effect.forkChild);
      yield* fixture.authorityReadBlocked;
      const changing = yield* app
        .setAgentIntelligence({
          threadId: "native",
          selection: { model: "model-b", effort: "default" },
        })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Effect.yieldNow;
      assert.equal(
        (yield* SubscriptionRef.get(fixture.snapshot)).metadata?.requestedSelection?.model,
        "model-a",
      );
      yield* fixture.releaseAuthorityRead;
      yield* Fiber.join(submitting);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(changing)));
      assert.equal(
        (yield* SubscriptionRef.get(fixture.snapshot)).metadata?.requestedSelection?.model,
        "model-a",
      );
      yield* fixture.finishPrompt;
    }),
  ),
);

it.effect("Application binds the deferred production extension after complete construction", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const context = yield* Layer.build(bindingLayer);
      const extension = Context.get(context, NativeConversationExtension);
      const bindingOwner = Context.get(context, NativeConversationBinding);
      const pending = yield* extension.read("native").pipe(Effect.forkChild);
      yield* fixture.application.pipe(Effect.provide(context));
      assert.equal((yield* Fiber.join(pending))?.backendBinding.kind, "claude");
      const repeat = yield* Effect.flip(bindingOwner.bind({} as never));
      assert.equal(repeat.reason, "already_bound");
    }),
  ),
);
