import { appToolCatalog } from "../../shared/nodex-app-tools/catalog";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type {
  Thread,
  ThreadForkParams,
  ThreadForkResponse,
} from "@nodex/codex-app-server-protocol/v2";
import type {
  CodexCanonicalConversationState,
  CodexConversationSnapshot,
} from "../../shared/types";
import { createCodexCanonicalHydratedConversationState } from "../../shared/codex-conversation-state/codex-conversation-state";
import { CodexGateway, CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import {
  CodexEphemeralThreadRouting,
  live as codexEphemeralThreadRoutingLive,
} from "../codex-runtime/CodexEphemeralThreadRouting";
import { codexRuntimeError, type CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { DesktopToolRuntime } from "../host-runtime/DesktopToolRuntime";
import { CodexTurnCommands, type CodexTurnCommandsService } from "./CodexTurnCommands";
import { CodexConversationProjection } from "./CodexConversationProjection";
import { CodexExecutionAssignments } from "./CodexExecutionAssignments";
import { makeReadyCodexExecutionAssignments } from "./CodexExecutionAssignments.test-support";
import { CodexGitProbe } from "./CodexGitProbe";
import { makeTestCodexGitProbe } from "./CodexGitProbe.test-support";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { ThreadCreationRuntime } from "./ThreadCreationRuntime";
import { transparentThreadCreationRuntime } from "./ThreadCreationRuntime.test-support";
import {
  ConversationEntityMap,
  live as conversationRuntimeMapLive,
} from "./internal/ConversationEntityMap";
import { make as makeCommands } from "./CodexSideChatCommands";
import { SIDE_CHAT_BOUNDARY_TEXT, SIDE_CHAT_DEVELOPER_INSTRUCTIONS } from "./CodexSideChatPolicy";

const parentThreadId = "parent-a";
const sideThreadId = "side-a";
const remoteHostId = "remote-a";

const protocolThread = (threadId: string): Thread => ({
  model: null,
  reasoningEffort: null,
  id: threadId,
  extra: null,
  sessionId: `session-${threadId}`,
  forkedFromId: null,
  parentThreadId: null,
  preview: "",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: "paginated",
  modelProvider: "openai",
  createdAt: 100,
  updatedAt: 100,
  recencyAt: 100,
  status: { type: "idle" },
  path: null,
  cwd: "/workspace",
  cliVersion: "test",
  source: "appServer",
  canAcceptDirectInput: true,
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: null,
  turns: [],
});

const forkResponse = {
  thread: {
    ...protocolThread(sideThreadId),
    ephemeral: true,
    forkedFromId: parentThreadId,
  },
  cwd: "/workspace",
  model: "gpt-parent",
  reasoningEffort: "high",
  modelProvider: "openai",
  serviceTier: "priority",
  approvalPolicy: "never",
  approvalsReviewer: "user",
  sandbox: {
    type: "workspaceWrite",
    writableRoots: ["/workspace", "/shared"],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  },
  activePermissionProfile: null,
  runtimeWorkspaceRoots: ["/workspace", "/shared"],
} as unknown as ThreadForkResponse;

const requestFailure = (method: string): CodexRuntimeError =>
  codexRuntimeError({
    operation: "gateway.request",
    reason: "request",
    retryable: false,
    hostId: remoteHostId,
    method,
    cause: new Error(`${method} failed`),
  });

interface SideChatHarnessOptions {
  readonly localHostId?: string;
  readonly hostResolution?: Effect.Effect<string, CodexRuntimeError>;
  readonly inject?: Effect.Effect<unknown, CodexRuntimeError>;
  readonly initialTurn?: Effect.Effect<void, CodexRuntimeError>;
  readonly unsubscribe?: Effect.Effect<unknown, CodexRuntimeError>;
  readonly parentProjection?: "materialized" | "released" | "canonical";
  readonly parentCanonical?: Partial<CodexCanonicalConversationState>;
  readonly directoryRead?: Effect.Effect<void>;
  readonly parentBackend?: "codex" | "acp";
  readonly parentSideConversation?: boolean;
  readonly capabilityCurrent?: boolean;
  readonly capabilityVersion?: string;
  readonly forkResponse?: ThreadForkResponse;
  readonly forkResponseGate?: Effect.Effect<void>;
}

interface PhysicalRequest {
  readonly hostId: string;
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly scheduling?: unknown;
}

const PARENT_HISTORY_METHODS = new Set([
  "thread/read",
  "thread/resume",
  "thread/turns/list",
  "thread/items/list",
]);

const makeHarness = (scope: Scope.Scope, options: SideChatHarnessOptions = {}) =>
  Effect.gen(function* () {
    const conversationContext = yield* Layer.buildWithScope(conversationRuntimeMapLive, scope);
    const conversations = Context.get(conversationContext, ConversationEntityMap);
    const routingContext = yield* Layer.buildWithScope(codexEphemeralThreadRoutingLive, scope);
    const routing = Context.get(routingContext, CodexEphemeralThreadRouting);
    const events: string[] = [];
    const requests: PhysicalRequest[] = [];
    const directoryFidelities: string[] = [];
    const startedTurns: Array<Parameters<CodexTurnCommandsService["start"]>> = [];

    const gateway = CodexGateway.of({
      localHostId: options.localHostId ?? "local",
      requestRawOnHost: () => Effect.die(new Error("Unsupported raw host request")),
      requestOnHost: ((
        hostId: string,
        method: string,
        params: { threadId?: string },
        scheduling?: unknown,
      ) =>
        Effect.suspend(() => {
          requests.push({
            hostId,
            method,
            params: params as Readonly<Record<string, unknown>>,
            scheduling,
          });
          events.push(`request:${hostId}:${method}:${params.threadId ?? parentThreadId}`);
          if (method === "experimentalFeature/list") {
            return Effect.succeed({ data: [], nextCursor: null });
          }
          if (method === "thread/fork") {
            return (options.forkResponseGate ?? Effect.void).pipe(
              Effect.as(options.forkResponse ?? forkResponse),
            );
          }
          if (method === "thread/inject_items") {
            const boundaryText = (
              params as {
                items?: ReadonlyArray<{
                  content?: ReadonlyArray<{ text?: string }>;
                }>;
              }
            ).items?.[0]?.content?.[0]?.text;
            assert.strictEqual(boundaryText, SIDE_CHAT_BOUNDARY_TEXT);
            return options.inject ?? Effect.succeed({});
          }
          if (method === "thread/unsubscribe") {
            return options.unsubscribe ?? Effect.succeed({});
          }
          return Effect.die(`unexpected request: ${method}`);
        })) as CodexGateway["Service"]["requestOnHost"],
    } as unknown as CodexGateway["Service"]);
    const hostResolver = CodexThreadHostResolver.of({
      resolve: (threadId) =>
        Effect.sync(() => events.push(`resolve:${threadId}`)).pipe(
          Effect.andThen(options.hostResolution ?? Effect.succeed(remoteHostId)),
        ),
    });
    const turns = CodexTurnCommands.of({
      prepareNativeToolMessage: () => Effect.die("unused"),
      injectPreparedNativeStart: () => Effect.die("unused"),
      prepareNativeQueuedMessage: () => Effect.die("unused"),
      prepareNativeStart: () => Effect.die("unused"),
      inspectPreparedNativeStart: () => Effect.die("unused"),
      executePreparedNativeStart: () => Effect.die("unused"),
      releasePreparedNativeStart: () => {},
      prepareNativeSteer: () => Effect.die("unused"),
      inspectPreparedNativeSteer: () => Effect.die("unused"),
      executePreparedNativeSteer: () => Effect.die("unused"),
      releasePreparedNativeSteer: () => {},
      start: (threadId, prompt, overrides) =>
        Effect.gen(function* () {
          startedTurns.push([threadId, prompt, overrides]);
          const hostId = yield* routing.resolve(threadId);
          events.push(`turn:${threadId}:${hostId ?? "unrouted"}`);
          yield* options.initialTurn ?? Effect.void;
          return null;
        }),
      startAutomation: () => Effect.die("unused"),
      steer: () => Effect.die("unused"),
    } satisfies CodexTurnCommandsService);
    const parentSnapshot = {
      threadId: parentThreadId,
      projectId: "project-a",
      source: { parentThreadId: null },
      cwd: "/workspace",
      executionProfile: {
        modelId: "gpt-parent",
        reasoningEffort: "high",
        serviceTier: "priority",
      },
      queuedFollowUps: {
        status: "ready",
        ledgerRevision: 0,
        projectionRevision: 0,
        entries: [],
        inFlightFollowUpId: null,
        editingFollowUpId: null,
        error: null,
      },
    } as unknown as CodexConversationSnapshot;
    const parentCanonical = {
      ...createCodexCanonicalHydratedConversationState(protocolThread(parentThreadId), {
        hostId: "local",
        ...{
          model: "gpt-parent",
          reasoningEffort: "high",
          cwd: "/workspace",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: ["/workspace", "/shared"],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
          activePermissionProfile: { id: ":workspace", extends: null },
          runtimeWorkspaceRoots: ["/workspace", "/shared"],
        },
      }),
      ...options.parentCanonical,
    };
    const parentIsMaterialized =
      options.parentProjection === undefined || options.parentProjection === "materialized";
    if (options.parentProjection === "canonical") {
      conversations.entity(parentThreadId).installFollowerCanonicalState(parentCanonical);
    }
    if (options.parentSideConversation && parentIsMaterialized) {
      conversations.entity(parentThreadId).installSnapshot({
        ...parentSnapshot,
        source: { parentThreadId: "root-a", sideConversation: true },
      });
    }
    const durableSummary = options.parentSideConversation
      ? {
          ...parentSnapshot,
          source: { parentThreadId: "root-a", sideConversation: true },
        }
      : parentSnapshot;
    const directoryEntry = {
      fidelity: "durable",
      durable: {
        cwd: "/workspace",
        backendBinding:
          options.parentBackend === "acp"
            ? {
                kind: "acp",
                agentDefinitionId: "claude-agent-acp",
                instanceConfigId: "claude-local",
              }
            : { kind: "codex" },
        executionProfile: parentSnapshot.executionProfile,
        executionHostId: remoteHostId,
      },
      summary: durableSummary,
      canonical: options.parentProjection === "released" ? null : parentCanonical,
      snapshot: parentIsMaterialized ? parentSnapshot : null,
    } as never;
    const directory = CodexThreadDirectory.of({
      prepareResume: () => Effect.die("unused"),
      prepareHistoryHydration: () => Effect.die("unused"),
      acceptRendererResume: () => Effect.die("unused"),
      materializeInCurrentLane: () => Effect.die("unused"),
      refreshMetadataInCurrentLane: () => Effect.die("unused"),
      // The canonical directory serializes remote materialization in the Thread lane.
      // Side-chat admission must therefore never hold that same non-reentrant lane.
      resolve: (input) => {
        directoryFidelities.push(input.fidelity);
        return (options.directoryRead ?? Effect.void).pipe(
          Effect.andThen(conversations.runCommand(parentThreadId, Effect.succeed(directoryEntry))),
        );
      },
      acceptRollbackResult: () => Effect.die("unused"),
      acceptImportResult: () => Effect.die("unused"),
      acceptForkResult: () => Effect.die("unused"),
      observeMetadata: () => Effect.die("unused"),
      acceptStandaloneStart: () => Effect.die("unused"),
      acceptResumeResult: () => Effect.die("unused"),
      acceptSessionStart: () => Effect.die("unused"),
    });
    const projection = CodexConversationProjection.of({
      hydrate: (input: Parameters<CodexConversationProjection["Service"]["hydrate"]>[0]) =>
        Effect.sync(() => {
          events.push("commit");
          const snapshot = {
            ...input.summary,
            source: input.summary.source,
            resumeState: "resumed",
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
          } as unknown as CodexConversationSnapshot;
          const aggregate = conversations.entity(input.threadId);
          aggregate.acceptCanonicalState(input.canonical);
          aggregate.installSnapshot(snapshot);
          return snapshot;
        }),
    } as unknown as CodexConversationProjection["Service"]);
    const commands = yield* makeCommands.pipe(
      Effect.provideService(CodexConversationProjection, projection),
      Effect.provideService(
        CodexAppServerCapabilities,
        CodexAppServerCapabilities.of({
          forHost: () =>
            Effect.succeed(
              createCodexAppServerCapabilitySnapshot({
                hostId: remoteHostId,
                generation: 1,
                userAgent: options.capabilityVersion ?? "codex-app-server/0.147.0",
                nativeAppTools: (options.localHostId ?? "local") === remoteHostId,
              }),
            ),
          forThread: () => Effect.die("unused"),
          isCurrent: () => Effect.succeed(options.capabilityCurrent ?? true),
        }),
      ),
      Effect.provideService(CodexGateway, gateway),
      Effect.provideService(
        DesktopToolRuntime,
        DesktopToolRuntime.of({
          threadConfig: () =>
            Effect.succeed({ "mcp_servers.node_repl": { command: "/runtime/node" } }),
        } as unknown as DesktopToolRuntime["Service"]),
      ),
      Effect.provideService(CodexExecutionAssignments, makeReadyCodexExecutionAssignments()),
      Effect.provideService(CodexGitProbe, makeTestCodexGitProbe()),
      Effect.provideService(CodexThreadHostResolver, hostResolver),
      Effect.provideService(CodexEphemeralThreadRouting, routing),
      Effect.provideService(CodexThreadDirectory, directory),
      Effect.provideService(ThreadCreationRuntime, transparentThreadCreationRuntime),
      Effect.provideService(CodexTurnCommands, turns),
      Effect.provideService(ConversationEntityMap, conversations),
    );

    return {
      commands,
      conversations,
      directoryFidelities,
      events,
      parentCanonical,
      startedTurns,
      markExisting: () => {
        conversations.entity(sideThreadId).installSnapshot({
          ...parentSnapshot,
          threadId: sideThreadId,
          source: { parentThreadId, sideConversation: true },
        });
      },
      parentHistoryRequestCount: () =>
        requests.filter(
          (request) =>
            PARENT_HISTORY_METHODS.has(request.method) &&
            request.params.threadId === parentThreadId,
        ).length,
      requests,
      routing,
    };
  });

it.effect("cleans up a returned fork when its parent generation retired during dispatch", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const harness = yield* makeHarness(scope, {
      parentProjection: "canonical",
      forkResponseGate: Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      ),
    });
    const pending = yield* harness.commands.start({ parentThreadId }).pipe(Effect.forkIn(scope));
    yield* Deferred.await(entered);
    yield* harness.conversations.retire(parentThreadId);
    harness.conversations.entity(parentThreadId).installFollowerCanonicalState({
      ...harness.parentCanonical,
      cwd: "/workspace/successor",
    });
    yield* Deferred.succeed(release, undefined);

    const failure = yield* Fiber.join(pending).pipe(Effect.flip);
    assert.strictEqual(failure._tag, "CodexSideChatProjectionError");
    assert.deepEqual(
      harness.requests.map((request) => request.method),
      ["experimentalFeature/list", "thread/fork", "thread/unsubscribe"],
    );
    assert.deepEqual(harness.requests[2]?.scheduling, {
      expectedHostId: remoteHostId,
      expectedGeneration: 1,
    });
    assert.isNull(yield* harness.routing.resolve(sideThreadId));
    assert.isNull(harness.conversations.current(sideThreadId));
    assert.notInclude(harness.events, "commit");
    assert.strictEqual(
      harness.conversations.current(parentThreadId)?.readCanonicalState()?.cwd,
      "/workspace/successor",
    );
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect(
  "preserves the presentation claim and submitted message identity for the first Turn",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const harness = yield* makeHarness(scope);
      const presentationClaim = { ticketId: "side-ticket", submissionId: "side-submission" };
      yield* harness.commands.start(
        { parentThreadId, prompt: "question" },
        { presentationClaim, clientUserMessageId: "side-message" },
      );

      assert.lengthOf(harness.startedTurns, 1);
      const [threadId, prompt, overrides] = harness.startedTurns[0]!;
      assert.strictEqual(threadId, sideThreadId);
      assert.strictEqual(prompt, "question");
      assert.strictEqual(overrides?.presentationClaim, presentationClaim);
      assert.strictEqual(overrides?.clientUserMessageId, "side-message");
      yield* Scope.close(scope, Exit.void);
    }),
);

it.effect.each([true, false])(
  "forks from durable parent context without requesting history (native bridge: %s)",
  (nativeMcp) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const harness = yield* makeHarness(scope, {
        localHostId: nativeMcp ? remoteHostId : "local",
      });

      const result = yield* harness.commands.start({ parentThreadId });
      const fork = harness.requests.find((request) => request.method === "thread/fork");
      assert.isDefined(fork);
      const params = fork.params as unknown as ThreadForkParams;

      assert.strictEqual(result.threadId, sideThreadId);
      assert.deepEqual(harness.directoryFidelities, ["durable"]);
      assert.strictEqual(harness.parentHistoryRequestCount(), 0);
      assert.strictEqual(fork.hostId, remoteHostId);
      assert.strictEqual(params.threadId, parentThreadId);
      assert.strictEqual(params.cwd, "/workspace");
      assert.isUndefined(params.model);
      assert.isUndefined(params.modelProvider);
      assert.isUndefined(params.serviceTier);
      assert.strictEqual(params.ephemeral, true);
      assert.strictEqual(params.excludeTurns, true);
      assert.deepEqual(params.runtimeWorkspaceRoots, ["/workspace", "/shared"]);
      assert.isUndefined(params.approvalPolicy);
      assert.isUndefined(params.approvalsReviewer);
      assert.isUndefined(params.permissions);
      assert.isUndefined(params.sandbox);
      assert.include(params.developerInstructions ?? "", "<app-context>");
      assert.isTrue(
        (params.developerInstructions ?? "").endsWith(`\n\n${SIDE_CHAT_DEVELOPER_INSTRUCTIONS}`),
      );
      if (nativeMcp) {
        assert.deepEqual(params.config, {
          "mcp_servers.node_repl": { command: "/runtime/node" },
          "mcp_servers.nodex_app.enabled_tools": appToolCatalog.map((tool) => tool.name),
        });
      } else {
        assert.isUndefined(params.config);
      }
      assert.deepEqual(
        harness.requests.map((request) => request.method),
        ["experimentalFeature/list", "thread/fork", "thread/inject_items"],
      );
      assert.deepEqual(
        harness.requests.map((request) => request.scheduling),
        [
          { expectedHostId: remoteHostId, expectedGeneration: 1 },
          { expectedHostId: remoteHostId, expectedGeneration: 1 },
          { expectedHostId: remoteHostId, expectedGeneration: 1 },
        ],
      );
      yield* Scope.close(scope, Exit.void);
    }),
);

it.effect("rejects an ACP parent before any Codex side-chat request", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const harness = yield* makeHarness(scope, { parentBackend: "acp" });

    yield* harness.commands.start({ parentThreadId }).pipe(Effect.flip);
    assert.deepEqual(harness.requests, []);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("uses durable execution metadata when the bounded parent projection was released", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const harness = yield* makeHarness(scope, { parentProjection: "released" });

    const result = yield* harness.commands.start({ parentThreadId });
    const fork = harness.requests.find((request) => request.method === "thread/fork");
    assert.isDefined(fork);
    const params = fork.params as unknown as ThreadForkParams;

    assert.strictEqual(result.threadId, sideThreadId);
    assert.strictEqual(harness.parentHistoryRequestCount(), 0);
    assert.strictEqual(params.cwd, "/workspace");
    assert.isUndefined(params.model);
    assert.deepEqual(params.runtimeWorkspaceRoots, ["/workspace"]);
    assert.isUndefined(params.permissions);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect(
  "forks from canonical-only workspace and settings while preserving explicit defaults",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const harness = yield* makeHarness(scope, {
        parentProjection: "canonical",
        parentCanonical: {
          cwd: "/workspace/live",
          workspaceKind: "projectless",
          latestThreadSettings: {
            model: "gpt-live",
            effort: null,
            serviceTier: null,
            collaborationMode: {
              mode: "default",
              settings: {
                model: "gpt-live",
                reasoning_effort: null,
                developer_instructions: null,
              },
            },
          },
        },
        forkResponse: {
          ...forkResponse,
          cwd: "/workspace/live",
          model: "gpt-live",
          reasoningEffort: null,
          serviceTier: null,
        },
      });

      const result = yield* harness.commands.start({ parentThreadId });
      const fork = harness.requests.find((request) => request.method === "thread/fork");
      assert.isDefined(fork);
      assert.strictEqual(fork.params.cwd, "/workspace/live");
      assert.isUndefined(fork.params.model);
      assert.isUndefined(fork.params.serviceTier);
      assert.isUndefined(fork.params.config);
      assert.strictEqual(harness.parentHistoryRequestCount(), 0);
      assert.isNull(harness.conversations.current(parentThreadId)?.readSnapshot());
      const side = harness.conversations.current(result.threadId)?.readCanonicalState();
      assert.isDefined(side);
      assert.strictEqual(side?.ephemeral, true);
      assert.strictEqual(side?.sideConversation, true);
      assert.strictEqual(side?.workspaceKind, "projectless");
      assert.strictEqual(side?.forkedFromId, parentThreadId);
      assert.strictEqual(side?.source, "appServer");
      assert.isNull(result.conversation.projectId);
      yield* Scope.close(scope, Exit.void);
    }),
);

it.effect("rejects a canonical-only nested side chat before resolving the directory", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const harness = yield* makeHarness(scope, {
      parentProjection: "canonical",
      parentCanonical: { ephemeral: true, sideConversation: true, forkedFromId: "root-a" },
    });

    const result = yield* Effect.exit(harness.commands.start({ parentThreadId }));
    assert.isTrue(Exit.isFailure(result));
    assert.deepEqual(harness.directoryFidelities, []);
    assert.deepEqual(harness.requests, []);
    assert.isNull(harness.conversations.current(parentThreadId)?.readSnapshot());
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("rechecks the current canonical side-chat marker after the directory read", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const harness = yield* makeHarness(scope, {
      parentProjection: "canonical",
      directoryRead: Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      ),
    });
    const pending = yield* harness.commands.start({ parentThreadId }).pipe(Effect.forkIn(scope));
    yield* Deferred.await(entered);
    harness.conversations.entity(parentThreadId).installFollowerCanonicalState({
      ...harness.parentCanonical,
      ephemeral: true,
      sideConversation: true,
      forkedFromId: "root-a",
    });
    yield* Deferred.succeed(release, undefined);

    assert.isTrue(Exit.isFailure(yield* Fiber.await(pending)));
    assert.deepEqual(harness.requests, []);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("rejects a parent generation retired while resolving side-chat context", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const harness = yield* makeHarness(scope, {
      parentProjection: "canonical",
      directoryRead: Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      ),
    });
    const pending = yield* harness.commands.start({ parentThreadId }).pipe(Effect.forkIn(scope));
    yield* Deferred.await(entered);
    yield* harness.conversations.retire(parentThreadId);
    harness.conversations.entity(parentThreadId).installFollowerCanonicalState({
      ...harness.parentCanonical,
      cwd: "/workspace/successor",
    });
    yield* Deferred.succeed(release, undefined);

    assert.isTrue(Exit.isFailure(yield* Fiber.await(pending)));
    assert.deepEqual(harness.requests, []);
    assert.strictEqual(
      harness.conversations.current(parentThreadId)?.readCanonicalState()?.cwd,
      "/workspace/successor",
    );
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect.each([true, false])(
  "discards only a canonical side conversation, not an ordinary fork (side: %s)",
  (sideConversation) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const harness = yield* makeHarness(scope);
      harness.conversations.entity(sideThreadId).installFollowerCanonicalState({
        ...harness.parentCanonical,
        id: sideThreadId,
        ephemeral: true,
        sideConversation,
        forkedFromId: parentThreadId,
      });
      yield* harness.routing.register(sideThreadId, remoteHostId);

      assert.strictEqual(yield* harness.commands.discard(sideThreadId), sideConversation);
      if (sideConversation) {
        assert.isNull(harness.conversations.current(sideThreadId));
        assert.isNull(yield* harness.routing.resolve(sideThreadId));
        assert.deepEqual(
          harness.requests.map((request) => request.method),
          ["thread/unsubscribe"],
        );
      } else {
        assert.isNotNull(harness.conversations.current(sideThreadId)?.readCanonicalState());
        assert.isNull(harness.conversations.current(sideThreadId)?.readSnapshot());
        assert.deepEqual(harness.requests, []);
      }
      yield* Scope.close(scope, Exit.void);
    }),
);

it.effect("fails closed before forking when the host cannot prove bounded side-chat support", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const harness = yield* makeHarness(scope, { capabilityVersion: "codex-app-server/0.144.0" });

    const exit = yield* Effect.exit(harness.commands.start({ parentThreadId }));

    assert.isTrue(Exit.isFailure(exit));
    assert.deepEqual(harness.requests, []);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("rejects stale generations and fork responses containing inline history", () =>
  Effect.gen(function* () {
    const staleScope = yield* Scope.make();
    const stale = yield* makeHarness(staleScope, { capabilityCurrent: false });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(stale.commands.start({ parentThreadId }))));
    assert.deepEqual(stale.requests, []);
    yield* Scope.close(staleScope, Exit.void);

    const inlineScope = yield* Scope.make();
    const inline = yield* makeHarness(inlineScope, {
      forkResponse: {
        ...forkResponse,
        thread: {
          ...forkResponse.thread,
          turns: [
            {
              id: "turn-inline",
              items: [],
              itemsView: "full",
              status: "completed",
              error: null,
              startedAt: null,
              completedAt: null,
              durationMs: null,
            },
          ],
        },
      },
    });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(inline.commands.start({ parentThreadId }))));
    assert.deepEqual(
      inline.requests.map((request) => request.method),
      ["experimentalFeature/list", "thread/fork", "thread/unsubscribe"],
    );
    assert.isNull(yield* inline.routing.resolve(sideThreadId));
    yield* Scope.close(inlineScope, Exit.void);
  }),
);

it.effect("accepts the runtime profile selected by the fork response", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const harness = yield* makeHarness(scope, {
      forkResponse: { ...forkResponse, model: "gpt-substituted" },
    });

    const result = yield* harness.commands.start({ parentThreadId });

    assert.strictEqual(result.threadId, sideThreadId);
    assert.strictEqual(yield* harness.routing.resolve(sideThreadId), remoteHostId);
    assert.strictEqual(
      harness.conversations.current(sideThreadId)?.readCanonicalState()?.hydrationContext
        ?.latestModel,
      "gpt-substituted",
    );
    assert.deepEqual(
      harness.requests.map((request) => request.method),
      ["experimentalFeature/list", "thread/fork", "thread/inject_items"],
    );
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("rejects a nested side chat before resolving or loading its parent", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const harness = yield* makeHarness(scope, { parentSideConversation: true });

    const exit = yield* Effect.exit(harness.commands.start({ parentThreadId }));

    assert.isTrue(Exit.isFailure(exit));
    assert.deepEqual(harness.directoryFidelities, []);
    assert.strictEqual(harness.parentHistoryRequestCount(), 0);
    assert.deepEqual(harness.requests, []);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("rejects a durable nested side chat after its bounded projection was released", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const harness = yield* makeHarness(scope, {
      parentProjection: "released",
      parentSideConversation: true,
    });

    const exit = yield* Effect.exit(harness.commands.start({ parentThreadId }));

    assert.isTrue(Exit.isFailure(exit));
    assert.deepEqual(harness.directoryFidelities, ["durable"]);
    assert.strictEqual(harness.parentHistoryRequestCount(), 0);
    assert.deepEqual(harness.requests, []);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("keeps a remote side chat on its parent's host through the initial Turn", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const harness = yield* makeHarness(scope);

    const result = yield* harness.commands.start({ parentThreadId, prompt: "question" });

    assert.strictEqual(result.threadId, sideThreadId);
    assert.strictEqual(yield* harness.routing.resolve(sideThreadId), remoteHostId);
    assert.deepEqual(harness.events, [
      `resolve:${parentThreadId}`,
      `request:${remoteHostId}:experimentalFeature/list:${parentThreadId}`,
      `request:${remoteHostId}:thread/fork:${parentThreadId}`,
      `request:${remoteHostId}:thread/inject_items:${sideThreadId}`,
      "commit",
      `turn:${sideThreadId}:${remoteHostId}`,
    ]);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("compensates the fork when the initial Turn is rejected", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const harness = yield* makeHarness(scope, {
      initialTurn: Effect.fail(requestFailure("turn/start")),
    });

    const exit = yield* Effect.exit(harness.commands.start({ parentThreadId, prompt: "question" }));

    assert.isTrue(Exit.isFailure(exit));
    assert.isNull(yield* harness.routing.resolve(sideThreadId));
    assert.deepEqual(harness.events.slice(-2), [
      `turn:${sideThreadId}:${remoteHostId}`,
      `request:${remoteHostId}:thread/unsubscribe:${sideThreadId}`,
    ]);
    assert.deepEqual(harness.requests.at(-1)?.scheduling, {
      expectedHostId: remoteHostId,
      expectedGeneration: 1,
    });
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("discards local ownership even when the remote unsubscribe fails", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const harness = yield* makeHarness(scope, {
      unsubscribe: Effect.fail(requestFailure("thread/unsubscribe")),
    });
    harness.markExisting();
    yield* harness.routing.register(sideThreadId, remoteHostId);
    const beforeGeneration = harness.conversations.current(sideThreadId)?.generation;

    assert.isTrue(yield* harness.commands.discard(sideThreadId));

    assert.isNull(harness.conversations.current(sideThreadId));
    const afterGeneration = harness.conversations.entity(sideThreadId).generation;
    assert.notStrictEqual(afterGeneration, beforeGeneration);
    assert.isNull(yield* harness.routing.resolve(sideThreadId));
    assert.deepEqual(harness.events, [
      `request:${remoteHostId}:thread/unsubscribe:${sideThreadId}`,
    ]);
    assert.deepEqual(harness.requests[0]?.scheduling, {
      expectedHostId: remoteHostId,
      expectedGeneration: 1,
    });
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("discards local ownership when the parent host is unavailable", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const harness = yield* makeHarness(scope, {
      hostResolution: Effect.fail(requestFailure("resolve-host")),
    });
    harness.markExisting();
    const beforeGeneration = harness.conversations.current(sideThreadId)?.generation;

    assert.isTrue(yield* harness.commands.discard(sideThreadId));

    assert.isNull(harness.conversations.current(sideThreadId));
    const afterGeneration = harness.conversations.entity(sideThreadId).generation;
    assert.notStrictEqual(afterGeneration, beforeGeneration);
    assert.deepEqual(harness.events, [`resolve:${parentThreadId}`]);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("rolls back an in-flight fork when the Main Scope closes", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const injectStarted = yield* Deferred.make<void>();
    const harness = yield* makeHarness(scope, {
      inject: Deferred.succeed(injectStarted, undefined).pipe(Effect.andThen(Effect.never)),
    });
    const command = yield* harness.commands.start({ parentThreadId }).pipe(Effect.forkIn(scope));
    yield* Deferred.await(injectStarted);

    yield* Scope.close(scope, Exit.void);
    const exit = yield* Fiber.await(command);

    assert.isTrue(Exit.isFailure(exit));
    assert.isNull(yield* harness.routing.resolve(sideThreadId));
    assert.deepEqual(harness.events.slice(-1), [
      `request:${remoteHostId}:thread/unsubscribe:${sideThreadId}`,
    ]);
  }),
);
