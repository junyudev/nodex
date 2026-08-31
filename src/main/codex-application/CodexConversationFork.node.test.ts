import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type {
  CodexCanonicalConversationState,
  CodexConversationSnapshot,
} from "../../shared/types";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { CoreModules, type CoreModuleClients } from "../core-runtime/CoreModules";
import { CodexConversationProjection } from "./CodexConversationProjection";
import { make } from "./CodexConversationFork";
import { CodexForkSidePanelTransfer } from "./CodexForkSidePanelTransferRuntime";
import { CodexForkTitlePolicy } from "./CodexForkTitlePolicy";
import { CodexOwnerNotificationDrainRuntime } from "./CodexOwnerNotificationDrainRuntime";
import { CodexRendererConversationCoordinator } from "./CodexRendererConversationCoordinator";
import { CodexThreadCatalog } from "./CodexThreadCatalog";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { ThreadCreationRuntime } from "./ThreadCreationRuntime";
import { transparentThreadCreationRuntime } from "./ThreadCreationRuntime.test-support";
import { CodexThreadTitlePersistence } from "./CodexThreadTitlePersistence";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

const sourceThreadId = "thread-source";
const childThreadId = "thread-child";
const ownerClientId = "renderer-owner";

const canonical = (threadId: string): CodexCanonicalConversationState =>
  ({
    turns: [
      {
        protocol: { id: "turn-a", status: "completed" },
        items: [],
        sidecar: { params: undefined, hookRuns: [] },
      },
    ],
    protocol: { id: threadId },
  }) as unknown as CodexCanonicalConversationState;

const snapshot = (threadId: string): CodexConversationSnapshot =>
  ({
    threadId,
    threadName: "Source title",
    turns: [{ threadId, turnId: "turn-a", status: "completed", itemIds: [] }],
    turnPagination: {
      olderCursor: null,
      backwardsCursor: null,
      oldestLoadedTurnId: "turn-a",
      isLoadingOlder: false,
      hasLoadedOldest: true,
      loadedTurnCount: 1,
      itemsView: "full",
    },
  }) as unknown as CodexConversationSnapshot;

interface HarnessOptions {
  readonly appServerVersion?: string;
  readonly capabilityIsCurrent?: boolean;
  readonly gatewayFailure?: ReturnType<typeof codexRuntimeError>;
  readonly responseTurns?: readonly { readonly id: string; readonly status: "completed" }[];
  readonly sourceCanonicalLoaded?: boolean;
}

const makeHarness = (options: HarnessOptions = {}) => {
  const order: string[] = [];
  const requests: Array<{
    readonly hostId: string;
    readonly method: string;
    readonly params: unknown;
    readonly scheduling: unknown;
  }> = [];
  const resolutions: Array<{ readonly threadId: string; readonly fidelity: string }> = [];
  const sourceCanonical = canonical(sourceThreadId);
  const sourceSnapshot = snapshot(sourceThreadId);
  const childSnapshot = snapshot(childThreadId);
  let projectedChild: CodexCanonicalConversationState | null = null;
  let projectedChildSnapshot: CodexConversationSnapshot | null = null;

  const core = CoreModules.of({
    workspace: {
      read: (input: Parameters<CoreModuleClients["workspace"]["read"]>[0]) => {
        if (input.kind === "task_window") {
          return Effect.succeed({
            value: {
              kind: "task_window",
              tasks: {
                items: [
                  {
                    session: {},
                    thread: {
                      thread_id: sourceThreadId,
                      forked_from_id: null,
                      thread_name: "Source title",
                    },
                  },
                ],
                next_cursor: null,
                authority: { projection_revision: 1 },
              },
            },
          } as unknown as ProjectWorkspaceReadSnapshot);
        }
        if (input.kind === "execution_context") {
          return Effect.succeed({
            value: {
              kind: "execution_context",
              context: { thread: { writable_roots: ["/workspace", "/shared"] } },
            },
          } as unknown as ProjectWorkspaceReadSnapshot);
        }
        return Effect.die("unexpected Core read");
      },
    },
  } as unknown as CoreModuleClients);
  const gateway = CodexGateway.of({
    localHostId: "host-a",
    events: Stream.empty,
    requestOnHost: ((hostId: string, method: string, params: unknown, scheduling: unknown) =>
      Effect.gen(function* () {
        order.push("gateway:fork");
        requests.push({ hostId, method, params, scheduling });
        if (options.gatewayFailure) return yield* options.gatewayFailure;
        return {
          thread: {
            id: childThreadId,
            forkedFromId: sourceThreadId,
            turns: [...(options.responseTurns ?? [])],
          },
          model: "gpt-test",
          modelProvider: "openai",
          serviceTier: null,
          cwd: "/workspace",
          runtimeWorkspaceRoots: ["/workspace", "/shared"],
          instructionSources: [],
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandbox: { type: "workspaceWrite", writableRoots: ["/workspace", "/shared"] },
          activePermissionProfile: null,
          reasoningEffort: "high",
          multiAgentMode: "explicitRequestOnly",
        } as never;
      })) as CodexGateway["Service"]["requestOnHost"],
  } as unknown as CodexGateway["Service"]);
  const directory = CodexThreadDirectory.of({
    resolve: (input) =>
      Effect.sync(() => {
        resolutions.push({ threadId: input.threadId, fidelity: input.fidelity });
        return {
          fidelity: "durable",
          durable: {
            threadId: sourceThreadId,
            projectId: "project-a",
            executionHostId: "host-a",
            cwd: "/workspace",
            executionProfile: {
              providerId: "openai",
              modelId: "gpt-test",
              harnessId: null,
              reasoningEffort: "high",
              serviceTier: null,
            },
          },
          summary: { ...sourceSnapshot, forkedFromId: null },
          canonical: options.sourceCanonicalLoaded === false ? null : sourceCanonical,
          snapshot: options.sourceCanonicalLoaded === false ? null : sourceSnapshot,
        } as never;
      }),
    descendants: () => Effect.die("unused"),
    acceptRollbackResult: () => Effect.die("unused"),
    acceptImportResult: () => Effect.die("unused"),
    acceptForkResult: ({ sourceThreadId: acceptedSource, response }) =>
      Effect.sync(() => {
        order.push("directory:accept");
        assert.strictEqual(acceptedSource, sourceThreadId);
        assert.strictEqual(response.thread.id, childThreadId);
        assert.deepEqual(response.thread.turns, []);
        return {
          fidelity: "metadata",
          durable: { threadId: childThreadId },
          summary: { ...childSnapshot, threadId: childThreadId },
          canonical: null,
          snapshot: null,
        } as never;
      }),
    observeMetadata: () => Effect.die("unused"),
    acceptStandaloneStart: () => Effect.die("unused"),
    acceptResumeResult: () => Effect.die("unused"),
    acceptSessionStart: () => Effect.die("unused"),
  });
  const projection = CodexConversationProjection.of({
    read: (threadId: string) => {
      if (threadId === sourceThreadId) return Effect.die("source projection must not be read");
      if (!projectedChild || !projectedChildSnapshot) {
        return Effect.die("child projection was not hydrated");
      }
      return Effect.succeed({ canonical: projectedChild, snapshot: projectedChildSnapshot });
    },
    hydrate: (input: Parameters<CodexConversationProjection["Service"]["hydrate"]>[0]) =>
      Effect.sync(() => {
        order.push("projection:hydrate");
        projectedChild = input.canonical;
        projectedChildSnapshot = {
          ...childSnapshot,
          turnPagination: input.pagination,
        };
        return projectedChildSnapshot;
      }),
  } as never);
  const capabilitySnapshot = createCodexAppServerCapabilitySnapshot({
    hostId: "host-a",
    generation: 7,
    userAgent: `Codex Desktop/${options.appServerVersion ?? "0.147.0"}`,
  });
  const capability = make.pipe(
    Effect.provideService(CoreModules, core),
    Effect.provideService(
      CodexAppServerCapabilities,
      CodexAppServerCapabilities.of({
        forHost: () => Effect.succeed(capabilitySnapshot),
        forThread: () => Effect.succeed(capabilitySnapshot),
        isCurrent: () => Effect.succeed(options.capabilityIsCurrent ?? true),
      }),
    ),
    Effect.provideService(CodexGateway, gateway),
    Effect.provideService(CodexConversationProjection, projection),
    Effect.provideService(
      CodexForkTitlePolicy,
      CodexForkTitlePolicy.of({
        derive: () =>
          Effect.succeed({ sourceTitle: "Source title", childTitle: "Source title (3)" }),
      }),
    ),
    Effect.provideService(
      CodexOwnerNotificationDrainRuntime,
      CodexOwnerNotificationDrainRuntime.of({
        awaitCurrent: () => Effect.sync(() => order.push("owner:drain")).pipe(Effect.asVoid),
      } as never),
    ),
    Effect.provideService(
      CodexRendererConversationCoordinator,
      CodexRendererConversationCoordinator.of({
        adoptRendererOwner: (
          input: Parameters<
            CodexRendererConversationCoordinator["Service"]["adoptRendererOwner"]
          >[0],
        ) =>
          Effect.sync(() => {
            order.push("owner:adopt");
            return { checkpoint: null, ownerClientId: input.ownerClientId, revision: 1 };
          }),
      } as never),
    ),
    Effect.provideService(
      CodexForkSidePanelTransfer,
      CodexForkSidePanelTransfer.of({
        stageDirect: () => Effect.sync(() => order.push("side-panel:stage")).pipe(Effect.asVoid),
      } as never),
    ),
    Effect.provideService(
      CodexThreadCatalog,
      CodexThreadCatalog.of({
        ensureSession: () =>
          Effect.sync(() => {
            order.push("session:ensure");
            return {
              id: "session-child",
              thread: { threadId: childThreadId },
            } as never;
          }),
      } as never),
    ),
    Effect.provideService(CodexThreadDirectory, directory),
    Effect.provideService(ThreadCreationRuntime, transparentThreadCreationRuntime),
    Effect.provideService(
      CodexThreadTitlePersistence,
      CodexThreadTitlePersistence.of({
        set: (input) =>
          Effect.sync(() => {
            order.push(`title:set:${input.name}`);
            return true;
          }),
        setRequired: () => Effect.die("unused"),
      }),
    ),
    Effect.provideService(
      ConversationEntityMap,
      ConversationEntityMap.of({
        runCommand: <A, E, R>(_threadId: string, operation: Effect.Effect<A, E, R>) =>
          Effect.sync(() => order.push("lane:open")).pipe(Effect.andThen(operation)),
      } as never),
    ),
  );
  return { capability, order, projectedChild: () => projectedChild, requests, resolutions };
};

it.effect("commits an exact persistent fork through canonical Session ownership", () =>
  Effect.gen(function* () {
    const { capability, order, projectedChild, requests, resolutions } = makeHarness();
    const forks = yield* capability;
    const result = yield* forks.fork({
      sourceThreadId,
      lastTurnId: "turn-a",
      threadSource: "user",
      ownerClientId,
    });

    assert.strictEqual(result.threadId, childThreadId);
    assert.strictEqual(result.session.id, "session-child");
    assert.strictEqual(result.composerIntent.prompt, "");
    assert.deepEqual(requests, [
      {
        hostId: "host-a",
        method: "thread/fork",
        params: {
          threadId: sourceThreadId,
          lastTurnId: "turn-a",
          path: null,
          model: "gpt-test",
          modelProvider: "openai",
          serviceTier: null,
          cwd: "/workspace",
          runtimeWorkspaceRoots: ["/workspace", "/shared"],
          threadSource: "user",
          excludeTurns: true,
          config: {
            model_reasoning_effort: "high",
            "features.apply_patch_streaming_events": true,
            "features.concurrent_reasoning_summaries": true,
            "features.thread_tools": true,
          },
        },
        scheduling: {
          conversationId: sourceThreadId,
          priority: "interactive",
          source: "thread_fork",
        },
      },
    ]);
    assert.deepEqual(resolutions, [
      { threadId: sourceThreadId, fidelity: "durable" },
      { threadId: sourceThreadId, fidelity: "durable" },
    ]);
    assert.deepEqual(
      requests.map((request) => request.method),
      ["thread/fork"],
    );
    const projected = projectedChild();
    assert.ok(projected);
    assert.strictEqual(projected.turns.at(-1)?.items.at(-1)?.type, "forkedFromConversation");
    assert.deepEqual(result.conversation.turnPagination, {
      olderCursor: null,
      backwardsCursor: null,
      oldestLoadedTurnId: null,
      isLoadingOlder: false,
      hasLoadedOldest: false,
      loadedTurnCount: 0,
      itemsView: "notLoaded",
    });
    assert.deepEqual(order, [
      "lane:open",
      "owner:drain",
      "gateway:fork",
      "directory:accept",
      "projection:hydrate",
      "title:set:Source title (3)",
      "session:ensure",
      "owner:adopt",
      "side-panel:stage",
    ]);
  }),
);

it.effect("forks through an unloaded stable Turn identity without reading source history", () =>
  Effect.gen(function* () {
    const { capability, order, requests, resolutions } = makeHarness({
      sourceCanonicalLoaded: false,
    });
    const forks = yield* capability;
    const result = yield* forks.fork({
      sourceThreadId,
      lastTurnId: "turn-not-resident",
      threadSource: "user",
    });

    assert.strictEqual(result.threadId, childThreadId);
    assert.strictEqual(
      (requests[0]?.params as { readonly lastTurnId?: string }).lastTurnId,
      "turn-not-resident",
    );
    assert.deepEqual(
      requests.map((request) => request.method),
      ["thread/fork"],
    );
    assert.deepEqual(resolutions, [
      { threadId: sourceThreadId, fidelity: "durable" },
      { threadId: sourceThreadId, fidelity: "durable" },
    ]);
    assert.ok(!order.some((entry) => entry.startsWith("title:set:")));
  }),
);

it.effect("discards noncompliant inline history while preserving the accepted child identity", () =>
  Effect.gen(function* () {
    const { capability, order, projectedChild, requests } = makeHarness({
      responseTurns: [{ id: "turn-inline", status: "completed" }],
    });
    const forks = yield* capability;
    const result = yield* forks.fork({
      sourceThreadId,
      lastTurnId: "turn-a",
      threadSource: "user",
    });

    assert.strictEqual(result.threadId, childThreadId);
    assert.deepEqual(
      requests.map((request) => request.method),
      ["thread/fork"],
    );
    const projected = projectedChild();
    assert.ok(projected);
    assert.ok(projected.turns.every((turn) => turn.protocol.id !== "turn-inline"));
    assert.strictEqual(projected.turns.at(-1)?.items.at(-1)?.type, "forkedFromConversation");
    assert.deepEqual(order, [
      "lane:open",
      "owner:drain",
      "gateway:fork",
      "directory:accept",
      "projection:hydrate",
      "title:set:Source title (3)",
      "session:ensure",
      "side-panel:stage",
    ]);
  }),
);

it.effect("fails closed before dispatch when bounded fork capabilities are unavailable", () =>
  Effect.gen(function* () {
    const { capability, order, requests, resolutions } = makeHarness({
      appServerVersion: "0.143.0-alpha.32",
    });
    const forks = yield* capability;
    const exit = yield* Effect.exit(
      forks.fork({
        sourceThreadId,
        lastTurnId: "turn-a",
        threadSource: "user",
      }),
    );

    assert.strictEqual(exit._tag, "Failure");
    assert.deepEqual(requests, []);
    assert.deepEqual(resolutions, [
      { threadId: sourceThreadId, fidelity: "durable" },
      { threadId: sourceThreadId, fidelity: "durable" },
    ]);
    assert.deepEqual(order, ["lane:open", "owner:drain"]);
  }),
);

it.effect("fences a stale app-server generation before the fork mutation", () =>
  Effect.gen(function* () {
    const { capability, order, requests } = makeHarness({ capabilityIsCurrent: false });
    const forks = yield* capability;
    const exit = yield* Effect.exit(
      forks.fork({ sourceThreadId, lastTurnId: "turn-a", threadSource: "user" }),
    );

    assert.strictEqual(exit._tag, "Failure");
    assert.deepEqual(requests, []);
    assert.deepEqual(order, ["lane:open", "owner:drain"]);
  }),
);

it.effect("preserves mutation outcome-unknown failures without retrying the fork", () =>
  Effect.gen(function* () {
    const unknown = codexRuntimeError({
      operation: "scheduler.execution",
      reason: "outcome-unknown",
      retryable: false,
      hostId: "host-a",
      generation: 7,
      method: "thread/fork",
    });
    const { capability, requests } = makeHarness({ gatewayFailure: unknown });
    const forks = yield* capability;
    const failure = yield* Effect.flip(
      forks.fork({ sourceThreadId, lastTurnId: "turn-a", threadSource: "user" }),
    );

    assert.strictEqual(requests.length, 1);
    assert.strictEqual(failure.operation, "fork");
    assert.strictEqual(failure.cause, unknown);
  }),
);

it.effect("rejects an explicitly blank stable Turn identity instead of widening the fork", () =>
  Effect.gen(function* () {
    const { capability, requests } = makeHarness();
    const forks = yield* capability;
    const exit = yield* Effect.exit(
      forks.fork({ sourceThreadId, lastTurnId: "   ", threadSource: "user" }),
    );

    assert.strictEqual(exit._tag, "Failure");
    assert.deepEqual(requests, []);
  }),
);
