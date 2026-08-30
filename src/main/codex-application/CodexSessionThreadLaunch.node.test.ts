import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import type {
  CodexConversationSnapshot,
  CodexThreadStartForSessionInput,
} from "../../shared/types";
import type { CodexExecutionProfile } from "../../shared/codex-execution-profile";
import type { CodexPendingWorktreeRequest } from "../../shared/codex-pending-worktree";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CoreModules } from "../core-runtime/CoreModules";
import { DesktopToolRuntime } from "../host-runtime/DesktopToolRuntime";
import { BrowserUseRuntime } from "../host-runtime/BrowserUseRuntime";
import { ProjectRuntimeLifecycleRuntime } from "../host-runtime/ProjectRuntimeLifecycleRuntime";
import { CodexAttachments } from "./CodexAttachments";
import { CodexAgentConfigRuntime } from "./CodexAgentConfigRuntime";
import { CodexFreshThreadLaunchRuntime } from "./CodexFreshThreadLaunchRuntime";
import { CodexPendingWorktreeRuntime } from "./CodexPendingWorktreeRuntime";
import { make, type CodexSessionThreadLaunchContext } from "./CodexSessionThreadLaunch";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { CodexThreadLaunchCompletion } from "./CodexThreadLaunchCompletion";
import { ThreadCreationRuntime } from "./ThreadCreationRuntime";
import { transparentThreadCreationRuntime } from "./ThreadCreationRuntime.test-support";
import { CodexTurnCommands, type CodexTurnStartOverrides } from "./CodexTurnCommands";
import { CodexTurnPreparation } from "./CodexTurnPreparation";

const context: CodexSessionThreadLaunchContext = {
  browserViewScopeId: "window-a",
  ownerClientId: null,
};

const firstSubmission = {
  launchId: "01991e60-b800-7000-8000-000000000001",
  clientUserMessageId: "01991e60-b800-7000-8000-000000000002",
} as const;

const input = (sessionId = "session-a"): CodexThreadStartForSessionInput => ({
  projectId: "project-a",
  sessionId,
  prompt: "Ship it",
  firstSubmission,
});

const snapshot = (threadId: string) =>
  ({
    threadId,
    projectId: "project-a",
    turns: [],
    requests: [],
    queuedFollowUps: {
      status: "ready",
      ledgerRevision: 0,
      projectionRevision: 0,
      entries: [],
      inFlightFollowUpId: null,
      editingFollowUpId: null,
      error: null,
    },
  }) as unknown as CodexConversationSnapshot;

const harness = (
  scope: Scope.Scope,
  options: {
    readonly start?: Effect.Effect<unknown>;
    readonly commitFails?: boolean;
    readonly desktopToolConfig?: Record<string, unknown> | null;
    readonly preparedClientUserMessageId?: string;
    readonly promoteFails?: boolean;
    readonly responseOverrides?: Readonly<Record<string, unknown>>;
    readonly prepareAgentConfig?: CodexAgentConfigRuntime["Service"]["prepare"];
  } = {},
) => {
  const events: string[] = [];
  const threadStartParams: Array<Record<string, unknown>> = [];
  const firstTurnOverrides: CodexTurnStartOverrides[] = [];
  const preparationInputs: Parameters<CodexTurnPreparation["Service"]["start"]>[0][] = [];
  const freshLaunches: Parameters<CodexFreshThreadLaunchRuntime["Service"]["register"]>[0][] = [];
  const pendingWorktreeRequests: CodexPendingWorktreeRequest[] = [];
  const requestScheduling: unknown[] = [];
  const browserPromotions: unknown[] = [];
  const acceptedCapabilities: unknown[] = [];
  let attempt = 0;
  const capability = createCodexAppServerCapabilitySnapshot({
    hostId: "local",
    generation: 19,
    userAgent: "codex-app-server/0.145.0-alpha.15",
  });
  const gateway = CodexGateway.of({
    localHostId: "local",
    requestLocal: ((method: string, params: Record<string, unknown>, scheduling: unknown) => {
      requestScheduling.push(scheduling);
      if (method === "thread/delete") {
        events.push(`delete:${params.threadId}`);
        return Effect.succeed({});
      }
      attempt += 1;
      threadStartParams.push(params);
      events.push(`start:${attempt}`);
      return (options.start ?? Effect.void).pipe(
        Effect.as({
          thread: { id: `thread-${attempt}`, historyMode: "paginated", turns: [] },
          model: params.model,
          modelProvider: params.modelProvider,
          reasoningEffort:
            typeof params.config === "object" && params.config !== null
              ? (params.config as Record<string, unknown>).model_reasoning_effort
              : null,
          serviceTier: params.serviceTier,
          ...options.responseOverrides,
        }),
      );
    }) as CodexGateway["Service"]["requestLocal"],
  } as unknown as CodexGateway["Service"]);
  const core = CoreModules.of({
    workspace: {
      read: (request: { readonly kind: string }) =>
        request.kind === "session"
          ? Effect.succeed({
              value: {
                kind: "session",
                session: { project_id: "project-a", thread_id: null },
              },
            } as never)
          : Effect.succeed({
              value: {
                kind: "project",
                project: { lifecycle: "active", sources: [{ root: "/workspace" }] },
              },
            } as never),
    },
  } as unknown as CoreModules["Service"]);
  const directory = CodexThreadDirectory.of({
    acceptForkResult: () => Effect.die("unused"),
    observeMetadata: () => Effect.die("unused"),
    acceptStandaloneStart: () => Effect.die("unused"),
    acceptResumeResult: () => Effect.die("unused"),
    acceptSessionStart: (
      request: Parameters<CodexThreadDirectory["Service"]["acceptSessionStart"]>[0],
    ) =>
      options.commitFails
        ? Effect.fail({ _tag: "commit-failed" } as never)
        : Effect.sync(() => {
            acceptedCapabilities.push(request.capability);
            events.push(`commit:${request.response.thread.id}`);
            const conversation = snapshot(request.response.thread.id);
            return {
              summary: conversation,
              snapshot: conversation,
            } as never;
          }),
  } as unknown as CodexThreadDirectory["Service"]);
  const turns = CodexTurnCommands.of({
    start: (threadId: string, _prompt: string, overrides?: CodexTurnStartOverrides) =>
      Effect.sync(() => {
        events.push(`turn:${threadId}`);
        firstTurnOverrides.push(overrides ?? {});
        return { threadId, turnId: "turn-a", status: "inProgress", itemIds: [] } as const;
      }),
  } as unknown as CodexTurnCommands["Service"]);
  const preparation = CodexTurnPreparation.of({
    start: (preparationInput: Parameters<CodexTurnPreparation["Service"]["start"]>[0]) =>
      Effect.sync(() => {
        preparationInputs.push(preparationInput);
        return {
          canonicalParams: {},
          request: {},
          clientUserMessageId:
            options.preparedClientUserMessageId ??
            preparationInput.overrides?.clientUserMessageId ??
            "unexpected-generated-message-id",
          verifiedBuiltinFullAccess: false,
        } as never;
      }),
  } as unknown as CodexTurnPreparation["Service"]);
  const completion = CodexThreadLaunchCompletion.of({
    accepted: ({ threadId }) => Effect.sync(() => events.push(`complete:${threadId}`)),
    failed: () => undefined,
  });
  return {
    capability,
    events,
    acceptedCapabilities,
    firstTurnOverrides,
    preparationInputs,
    freshLaunches,
    pendingWorktreeRequests,
    requestScheduling,
    browserPromotions,
    threadStartParams,
    effect: make.pipe(
      Effect.provideService(
        CodexAppServerCapabilities,
        CodexAppServerCapabilities.of({
          forHost: () => Effect.succeed(capability),
          forThread: () => Effect.succeed(capability),
          isCurrent: () => Effect.succeed(true),
        }),
      ),
      Effect.provideService(
        CodexAgentConfigRuntime,
        CodexAgentConfigRuntime.of({
          prepare: options.prepareAgentConfig ?? (() => Effect.succeed({ hasConfig: false })),
        }),
      ),
      Effect.provideService(
        CodexAttachments,
        CodexAttachments.of({
          materializePastedText: () =>
            Effect.succeed({ attachments: [], createdAttachmentPaths: [] }),
          removePastedText: () => Effect.void,
        } as unknown as CodexAttachments["Service"]),
      ),
      Effect.provideService(CodexGateway, gateway),
      Effect.provideService(CoreModules, core),
      Effect.provideService(
        BrowserUseRuntime,
        BrowserUseRuntime.of({
          promoteRoute: (promotion: Parameters<BrowserUseRuntime["Service"]["promoteRoute"]>[0]) =>
            options.promoteFails
              ? Effect.fail({
                  operation: "promote-route",
                  cause: new Error("route expired"),
                } as never)
              : Effect.sync(() => {
                  browserPromotions.push(promotion);
                  events.push(`promote:${promotion.codexSessionId}`);
                }),
        } as unknown as BrowserUseRuntime["Service"]),
      ),
      Effect.provideService(
        DesktopToolRuntime,
        DesktopToolRuntime.of({
          threadConfig: Effect.succeed(options.desktopToolConfig ?? null),
        } as unknown as DesktopToolRuntime["Service"]),
      ),
      Effect.provideService(CodexThreadDirectory, directory),
      Effect.provideService(CodexTurnCommands, turns),
      Effect.provideService(CodexThreadLaunchCompletion, completion),
      Effect.provideService(ThreadCreationRuntime, transparentThreadCreationRuntime),
      Effect.provideService(
        ProjectRuntimeLifecycleRuntime,
        ProjectRuntimeLifecycleRuntime.of({ runExclusive: (_projectId, operation) => operation }),
      ),
      Effect.provideService(
        CodexPendingWorktreeRuntime,
        CodexPendingWorktreeRuntime.of({
          create: (request) =>
            Effect.sync(() => {
              pendingWorktreeRequests.push(request);
            }),
        } as CodexPendingWorktreeRuntime["Service"]),
      ),
      Effect.provideService(
        CodexFreshThreadLaunchRuntime,
        CodexFreshThreadLaunchRuntime.of({
          register: (
            launch: Parameters<CodexFreshThreadLaunchRuntime["Service"]["register"]>[0],
          ) => {
            freshLaunches.push(launch);
          },
        } as unknown as CodexFreshThreadLaunchRuntime["Service"]),
      ),
      Effect.provideService(CodexTurnPreparation, preparation),
      Effect.provideService(Scope.Scope, scope),
    ),
  };
};

it.effect("commits the Session link before admitting its first Turn", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const test = harness(scope);
    const service = yield* test.effect;

    const result = yield* service.start(input(), context);

    assert.strictEqual(result.kind, "started");
    assert.deepEqual(test.events, [
      "start:1",
      "commit:thread-1",
      "turn:thread-1",
      "complete:thread-1",
    ]);
    assert.deepEqual(test.requestScheduling, [{ expectedHostId: "local", expectedGeneration: 19 }]);
    assert.strictEqual(test.threadStartParams[0]?.historyMode, "paginated");
    assert.strictEqual(test.acceptedCapabilities[0], test.capability);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("promotes the Session Browser route before the first Turn starts", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const test = harness(scope);
    const service = yield* test.effect;

    const result = yield* service.start(
      {
        ...input(),
        browserUsePresentationOrigin: {
          browserConversationId: "session-a",
          browserViewScopeId: "window-a",
        },
      },
      context,
    );

    assert.strictEqual(result.kind, "started");
    assert.deepEqual(test.browserPromotions, [
      {
        browserConversationId: "session-a",
        browserViewScopeId: "window-a",
        codexSessionId: "thread-1",
        projectId: "project-a",
      },
    ]);
    assert.deepEqual(test.events, [
      "start:1",
      "commit:thread-1",
      "promote:thread-1",
      "turn:thread-1",
      "complete:thread-1",
    ]);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("starts the first Turn when the optional Browser route can no longer be promoted", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const test = harness(scope, { promoteFails: true });
    const service = yield* test.effect;

    const result = yield* service.start(
      {
        ...input(),
        browserUsePresentationOrigin: {
          browserConversationId: "session-a",
          browserViewScopeId: "window-a",
        },
      },
      context,
    );

    assert.strictEqual(result.kind, "started");
    assert.deepEqual(test.events, [
      "start:1",
      "commit:thread-1",
      "turn:thread-1",
      "complete:thread-1",
    ]);
    yield* Scope.close(scope, Exit.void);
  }),
);

const lunaMaxProfile: CodexExecutionProfile = {
  modelId: "gpt-5.6-luna",
  reasoningEffort: "max",
  serviceTier: null,
};

const conflictingLaunchInput = (): CodexThreadStartForSessionInput => ({
  ...input(),
  executionProfile: lunaMaxProfile,
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  serviceTier: "fast",
});

it.effect("uses one execution profile for renderer-owned Thread and first-Turn planning", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const test = harness(scope, {
      desktopToolConfig: {
        "features.js_repl": false,
        "mcp_servers.node_repl": { command: "/runtime/node" },
      },
    });
    const service = yield* test.effect;

    const result = yield* service.start(conflictingLaunchInput(), {
      ...context,
      ownerClientId: "renderer-a",
    });

    assert.strictEqual(result.kind, "started");
    assert.deepEqual(test.threadStartParams[0], {
      cwd: "/workspace",
      runtimeWorkspaceRoots: ["/workspace"],
      model: "gpt-5.6-luna",
      serviceTier: null,
      baseInstructions: null,
      developerInstructions: null,
      threadSource: "user",
      historyMode: "paginated",
      config: {
        "features.js_repl": false,
        "mcp_servers.node_repl": { command: "/runtime/node" },
        "features.apply_patch_streaming_events": true,
        "features.concurrent_reasoning_summaries": true,
        "features.thread_tools": true,
        model_reasoning_effort: "max",
      },
    });
    assert.deepEqual(test.preparationInputs[0]?.overrides, {
      clientUserMessageId: firstSubmission.clientUserMessageId,
      promptInput: undefined,
      model: "gpt-5.6-luna",
      serviceTier: null,
      permissionMode: undefined,
      reasoningEffort: "max",
      collaborationMode: undefined,
    });
    assert.strictEqual(test.freshLaunches[0]?.launchId, firstSubmission.launchId);
    assert.strictEqual(
      test.freshLaunches[0]?.clientUserMessageId,
      firstSubmission.clientUserMessageId,
    );
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("uses the same execution profile for a Main-owned first Turn", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const test = harness(scope);
    const service = yield* test.effect;

    yield* service.start(conflictingLaunchInput(), context);

    assert.deepEqual(test.firstTurnOverrides[0], {
      clientUserMessageId: firstSubmission.clientUserMessageId,
      promptInput: undefined,
      model: "gpt-5.6-luna",
      serviceTier: null,
      permissionMode: undefined,
      reasoningEffort: "max",
      collaborationMode: undefined,
    });
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("rejects a renderer-owned first Turn that changes its admitted message identity", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const test = harness(scope, { preparedClientUserMessageId: "substituted-message-id" });
    const service = yield* test.effect;

    const result = yield* Effect.exit(
      service.start(input(), { ...context, ownerClientId: "renderer-a" }),
    );

    assert.isTrue(Exit.isFailure(result));
    assert.deepEqual(test.freshLaunches, []);
    assert.deepEqual(test.events, ["start:1", "commit:thread-1"]);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("deletes a provider-substituted Thread before admitting its first Turn", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const test = harness(scope, { responseOverrides: { model: "gpt-5.6-sol" } });
    const service = yield* test.effect;

    const result = yield* Effect.exit(service.start(conflictingLaunchInput(), context));

    assert.isTrue(Exit.isFailure(result));
    assert.deepEqual(test.events, ["start:1", "delete:thread-1"]);
    assert.deepEqual(test.firstTurnOverrides, []);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("accepts the app-server Standard sentinel without weakening profile checks", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const test = harness(scope, { responseOverrides: { serviceTier: "default" } });
    const service = yield* test.effect;

    const result = yield* service.start(conflictingLaunchInput(), context);

    assert.strictEqual(result.kind, "started");
    assert.deepEqual(test.events, [
      "start:1",
      "commit:thread-1",
      "turn:thread-1",
      "complete:thread-1",
    ]);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("preserves the semantic source of protocol-created child Threads", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const test = harness(scope);
    const service = yield* test.effect;

    yield* service.start({ ...input(), threadSource: "subagent" }, context);

    assert.strictEqual(test.threadStartParams[0]?.threadSource, "subagent");
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("preserves first-submission identity while consuming Agent config for either owner", () =>
  Effect.gen(function* () {
    const profile: CodexExecutionProfile = {
      modelId: "gpt-5.6-luna",
      reasoningEffort: "max",
      serviceTier: "fast",
    };
    for (const ownerClientId of [null, "renderer-a"]) {
      const scope = yield* Scope.make();
      const test = harness(scope, {
        prepareAgentConfig: () =>
          Effect.succeed({
            hasConfig: true,
            executionProfile: profile,
            collaborationMode: "plan",
            permissionMode: "auto",
          }),
      });
      const service = yield* test.effect;

      yield* service.start(
        {
          ...input(),
          promptInput: {
            text: "Ship it",
            agentConfigs: [{ provider: "openai", model: "gpt-5.6-luna" }],
          },
        },
        { ...context, ownerClientId },
      );

      assert.strictEqual(test.threadStartParams[0]?.model, "gpt-5.6-luna");
      assert.strictEqual(test.threadStartParams[0]?.serviceTier, "fast");
      assert.strictEqual(test.threadStartParams[0]?.historyMode, "paginated");
      assert.strictEqual(test.acceptedCapabilities[0], test.capability);
      const overrides = ownerClientId
        ? test.preparationInputs[0]?.overrides
        : test.firstTurnOverrides[0];
      assert.deepInclude(overrides, {
        clientUserMessageId: firstSubmission.clientUserMessageId,
        model: "gpt-5.6-luna",
        serviceTier: "fast",
        reasoningEffort: "max",
        collaborationMode: "plan",
        permissionMode: "auto",
        agentConfigPermissionMode: true,
        promptInput: { text: "Ship it", agentConfigs: [] },
      });
      if (ownerClientId) assert.deepInclude(test.freshLaunches[0], firstSubmission);
      yield* Scope.close(scope, Exit.void);
    }
  }),
);

it.effect("freezes resolved Agent config into a pending worktree request", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const profile: CodexExecutionProfile = {
      modelId: "gpt-5.6-luna",
      reasoningEffort: "max",
      serviceTier: "fast",
    };
    const test = harness(scope, {
      prepareAgentConfig: () =>
        Effect.succeed({
          hasConfig: true,
          executionProfile: profile,
          collaborationMode: "plan",
          permissionMode: "auto",
        }),
    });
    const service = yield* test.effect;

    const result = yield* service.start(
      {
        ...input(),
        prompt: '<agent-config model="gpt-5.6-luna" />\nShip it',
        runInTarget: "newWorktree",
      },
      context,
    );

    assert.strictEqual(result.kind, "pending");
    const request = test.pendingWorktreeRequests[0];
    assert.strictEqual(request?.launchMode, "start-conversation");
    if (request?.launchMode !== "start-conversation") return;
    assert.strictEqual(request.prompt, "Ship it");
    assert.deepStrictEqual(request.firstSubmission, firstSubmission);
    assert.deepStrictEqual(request.startConversationParamsInput.executionProfile, profile);
    assert.strictEqual(request.startConversationParamsInput.agentMode, "auto");
    assert.strictEqual(request.startConversationParamsInput.agentConfigPermissionMode, true);
    assert.strictEqual(request.startConversationParamsInput.collaborationMode?.mode, "plan");
    assert.deepEqual(request.startConversationParamsInput.projectAssignment, {
      projectKind: "local",
      projectId: "project-a",
      pendingCoreUpdate: false,
    });
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("freezes Project authority into managed-worktree launches", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const test = harness(scope);
    const service = yield* test.effect;

    const result = yield* service.start(
      {
        ...input(),
        runInTarget: "newWorktree",
        permissionMode: "guardian-approvals",
      },
      context,
    );

    assert.strictEqual(result.kind, "pending");
    const request = test.pendingWorktreeRequests[0];
    assert.strictEqual(request?.launchMode, "start-conversation");
    if (request?.launchMode !== "start-conversation") return;
    assert.deepEqual(request.startConversationParamsInput.projectAssignment, {
      projectKind: "local",
      projectId: "project-a",
      pendingCoreUpdate: false,
    });
    assert.strictEqual(request.startConversationParamsInput.agentMode, "guardian-approvals");
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("serializes a Session and compensates a Thread rejected before linking", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const test = harness(scope, {
      start: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      commitFails: true,
    });
    const service = yield* test.effect;
    const first = yield* service.start(input(), context).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const second = yield* service.start(input(), context).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    assert.deepEqual(test.events, ["start:1"]);
    yield* Deferred.succeed(release, undefined);
    assert.isTrue(Exit.isFailure(yield* Fiber.await(first)));
    assert.isTrue(Exit.isFailure(yield* Fiber.await(second)));
    assert.deepEqual(test.events, ["start:1", "delete:thread-1", "start:2", "delete:thread-2"]);
    yield* Scope.close(scope, Exit.void);
  }),
);
