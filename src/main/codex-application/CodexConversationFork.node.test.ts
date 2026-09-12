import { produce } from "immer";
import { CodexMainConversationResume } from "./CodexMainConversationResume";
import type { CodexCanonicalTurnHeader } from "../../shared/types";
import { appToolCatalog } from "../../shared/nodex-app-tools/catalog";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
import { DesktopToolRuntime } from "../host-runtime/DesktopToolRuntime";
import { make } from "./CodexConversationFork";
import { CodexForkSidePanelTransfer } from "./CodexForkSidePanelTransferRuntime";
import { CodexForkTitlePolicy } from "./CodexForkTitlePolicy";
import { CodexThreadCatalog } from "./CodexThreadCatalog";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { ThreadCreationRuntime } from "./ThreadCreationRuntime";
import { transparentThreadCreationRuntime } from "./ThreadCreationRuntime.test-support";
import { CodexThreadTitlePersistence } from "./CodexThreadTitlePersistence";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

const sourceThreadId = "thread-source";
const childThreadId = "thread-child";

const canonical = (threadId: string): CodexCanonicalConversationState =>
  ({
    turns: [
      {
        ...({ turnId: "turn-a", status: "completed" } satisfies Pick<
          CodexCanonicalTurnHeader,
          "turnId" | "status"
        >),
        items: [],
        params: undefined,
        hookRuns: [],
      },
    ],
    ...{ id: threadId },
  }) as unknown as CodexCanonicalConversationState;

const snapshot = (threadId: string): CodexConversationSnapshot =>
  ({
    threadId,
    threadName: "Source title",
    turns: [
      {
        threadId,
        ...({ turnId: "turn-a", status: "completed" } satisfies Pick<
          CodexCanonicalTurnHeader,
          "turnId" | "status"
        >),
        itemIds: [],
      },
    ],
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
  readonly localHostId?: string;
  readonly responseTurns?: readonly {
    readonly id: string;
    readonly status: "completed";
  }[];
  readonly sourceCanonicalLoaded?: boolean;
  readonly sourceHistoryMode?: "legacy" | "paginated";
  readonly currentExecutionHostId?: string;
}

const makeHarness = (options: HarnessOptions = {}) => {
  const order: string[] = [];
  const requests: Array<{
    readonly hostId: string;
    readonly method: string;
    readonly params: unknown;
    readonly scheduling: unknown;
  }> = [];
  const resolutions: Array<{
    readonly threadId: string;
    readonly fidelity: string;
  }> = [];
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
        if (input.kind === "thread") {
          return Effect.succeed({
            value: {
              kind: "thread",
              thread: {
                thread_id: sourceThreadId,
                execution_host_id: options.currentExecutionHostId ?? "host-a",
              },
            },
          } as unknown as ProjectWorkspaceReadSnapshot);
        }
        return Effect.die("unexpected Core read");
      },
    },
  } as unknown as CoreModuleClients);
  const gateway = CodexGateway.of({
    localHostId: options.localHostId ?? "host-a",
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
            historyMode: "paginated",
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
    prepareResume: () => Effect.die("unused"),
    prepareHistoryHydration: () => Effect.die("unused"),
    acceptRendererResume: () => Effect.die("unused"),
    materializeInCurrentLane: () => Effect.die("unused"),
    refreshMetadataInCurrentLane: () => Effect.die("unused"),
    resolve: (input) =>
      Effect.sync(() => {
        resolutions.push({ threadId: input.threadId, fidelity: input.fidelity });
        return {
          fidelity: "durable",
          historyMode: options.sourceHistoryMode ?? "paginated",
          durable: {
            threadId: sourceThreadId,
            projectId: "project-a",
            executionHostId: "host-a",
            cwd: "/workspace",
            executionProfile: {
              modelId: "gpt-test",
              reasoningEffort: "high",
              serviceTier: null,
            },
          },
          summary: { ...sourceSnapshot, forkedFromId: null },
          canonical: options.sourceCanonicalLoaded === false ? null : sourceCanonical,
          snapshot: options.sourceCanonicalLoaded === false ? null : sourceSnapshot,
        } as never;
      }),
    acceptRollbackResult: () => Effect.die("unused"),
    acceptImportResult: () => Effect.die("unused"),
    acceptForkResult: ({ sourceThreadId: acceptedSource, response }) =>
      Effect.sync(() => {
        order.push("directory:accept");
        assert.strictEqual(acceptedSource, sourceThreadId);
        assert.strictEqual(response.thread.id, childThreadId);
        return {
          fidelity: "metadata",
          historyMode: "paginated",
          durable: { threadId: childThreadId },
          summary: { ...childSnapshot, threadId: childThreadId },
          canonical: canonical(childThreadId),
          snapshot: childSnapshot,
        } as never;
      }),
    observeMetadata: () => Effect.die("unused"),
    acceptStandaloneStart: () => Effect.die("unused"),
    acceptResumeResult: () => Effect.die("unused"),
    acceptSessionStart: () => Effect.die("unused"),
  });
  const capabilitySnapshot = createCodexAppServerCapabilitySnapshot({
    hostId: "host-a",
    generation: 7,
    userAgent: `Codex Desktop/${options.appServerVersion ?? "0.147.0"}`,
    nativeAppTools: (options.localHostId ?? "host-a") === "host-a",
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
    Effect.provideService(
      DesktopToolRuntime,
      DesktopToolRuntime.of({
        threadConfig: () =>
          Effect.succeed({ "mcp_servers.node_repl": { command: "/runtime/node" } }),
      } as unknown as DesktopToolRuntime["Service"]),
    ),
    Effect.provideService(
      CodexMainConversationResume,
      CodexMainConversationResume.of({
        resume: () =>
          Effect.sync(() => {
            order.push("manager:resume");
            projectedChild = canonical(childThreadId);
            projectedChildSnapshot = childSnapshot;
            return { status: "ready", snapshot: childSnapshot } as const;
          }),
      }),
    ),
    Effect.provideService(
      CodexForkTitlePolicy,
      CodexForkTitlePolicy.of({
        derive: () =>
          Effect.succeed({ sourceTitle: "Source title", childTitle: "Source title (3)" }),
      }),
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
            if (!projectedChild) throw new Error("Fork title cannot project before child resume");
            order.push(`title:set:${input.name}`);
            return true;
          }),
        setRequired: () => Effect.die("unused"),
        syncCommittedTitle: () => Effect.die("unused"),
      }),
    ),
    Effect.provideService(
      ConversationEntityMap,
      ConversationEntityMap.of({
        entity: () => ({
          mutateCanonicalState: (
            recipe: (draft: import("immer").Draft<CodexCanonicalConversationState>) => void,
          ) => {
            if (!projectedChild) throw new Error("Main conversation has not resumed");
            projectedChild = produce(projectedChild, recipe);
            return true;
          },
          readSnapshot: () => projectedChildSnapshot,
        }),
        registerThreadMetadata: () => {},
        readThreadMetadata: () => null,
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
          cwd: "/workspace",
          runtimeWorkspaceRoots: ["/workspace", "/shared"],
          threadSource: "user",
          excludeTurns: true,
          config: {
            "mcp_servers.node_repl": { command: "/runtime/node" },
            "mcp_servers.nodex_app.enabled_tools": appToolCatalog.map((tool) => tool.name),
          },
        },
        scheduling: {
          conversationId: sourceThreadId,
          priority: "interactive",
          source: "thread_fork",
          expectedHostId: "host-a",
          expectedGeneration: 7,
        },
      },
    ]);
    assert.deepEqual(resolutions, [{ threadId: sourceThreadId, fidelity: "metadata" }]);
    assert.deepEqual(
      requests.map((request) => request.method),
      ["thread/fork"],
    );
    const projected = projectedChild();
    assert.ok(projected);
    assert.strictEqual(projected.turns.at(-1)?.items.at(-1)?.type, "forkedFromConversation");
    assert.deepEqual(result.conversation.turnPagination, snapshot(childThreadId).turnPagination);
    assert.deepEqual(order, [
      "lane:open",
      "gateway:fork",
      "directory:accept",
      "session:ensure",
      "manager:resume",
      "title:set:Source title (3)",
      "side-panel:stage",
    ]);
  }),
);

it.effect("does not attach local desktop runtime config to a remote persistent fork", () =>
  Effect.gen(function* () {
    const { capability, requests } = makeHarness({ localHostId: "local" });
    const forks = yield* capability;
    const result = yield* forks.fork({
      sourceThreadId,
      lastTurnId: "turn-a",
      threadSource: "user",
    });

    assert.strictEqual(result.threadId, childThreadId);
    assert.lengthOf(requests, 1);
    assert.strictEqual(requests[0]?.method, "thread/fork");
    assert.notProperty(requests[0]?.params as Record<string, unknown>, "config");
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
      (
        requests[0]?.params as {
          readonly lastTurnId?: string;
        }
      ).lastTurnId,
      "turn-not-resident",
    );
    assert.deepEqual(
      requests.map((request) => request.method),
      ["thread/fork"],
    );
    assert.deepEqual(resolutions, [{ threadId: sourceThreadId, fidelity: "metadata" }]);
    assert.ok(!order.some((entry) => entry.startsWith("title:set:")));
  }),
);

it.effect("accepts returned inline history and resumes the child at the ordinary manager", () =>
  Effect.gen(function* () {
    const { capability, order, projectedChild, requests } = makeHarness({
      responseTurns: [{ id: "turn-inline", status: "completed" }],
    });
    const forks = yield* capability;
    const result = yield* Effect.exit(
      forks.fork({
        sourceThreadId,
        lastTurnId: "turn-a",
        threadSource: "user",
      }),
    );

    assert.isTrue(Exit.isSuccess(result));
    assert.deepEqual(
      requests.map((request) => request.method),
      ["thread/fork"],
    );
    assert.ok(projectedChild());
    assert.ok(order.includes("manager:resume"));
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
    assert.deepEqual(resolutions, [{ threadId: sourceThreadId, fidelity: "metadata" }]);
    assert.deepEqual(order, ["lane:open"]);
  }),
);

it.effect("forks a legacy Thread on an older host using the native identity", () =>
  Effect.gen(function* () {
    const { capability, order, requests, resolutions } = makeHarness({
      sourceHistoryMode: "legacy",
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

    assert.strictEqual(exit._tag, "Success");
    assert.strictEqual(requests[0]?.method, "thread/fork");
    assert.deepEqual(resolutions, [{ threadId: sourceThreadId, fidelity: "metadata" }]);
    assert.ok(order.includes("manager:resume"));
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
    assert.deepEqual(order, ["lane:open"]);
  }),
);

it.effect("fails closed when handoff changes the durable host before fork dispatch", () =>
  Effect.gen(function* () {
    const { capability, order, requests } = makeHarness({
      currentExecutionHostId: "host-b",
    });
    const forks = yield* capability;

    const exit = yield* Effect.exit(
      forks.fork({ sourceThreadId, lastTurnId: "turn-a", threadSource: "user" }),
    );

    assert.strictEqual(exit._tag, "Failure");
    assert.deepEqual(requests, []);
    assert.deepEqual(order, ["lane:open"]);
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

it.effect(
  "renderer fork admission returns raw response and accepts durable identity without a Main document",
  () =>
    Effect.gen(function* () {
      const { capability, order, requests } = makeHarness();
      const forks = yield* capability;
      const prepared = yield* forks.prepareRenderer({
        sourceThreadId,
        lastTurnId: "turn-a",
        threadSource: "user",
      });
      assert.strictEqual(requests.length, 0);
      const response = yield* forks.executeRenderer(prepared.receiptId);
      assert.strictEqual(response.thread.id, childThreadId);
      assert.strictEqual(order.includes("manager:resume"), false);
      const accepted = yield* forks.acceptRenderer(prepared.receiptId);
      assert.strictEqual(accepted.threadId, childThreadId);
      assert.strictEqual(order.includes("manager:resume"), false);
      assert.strictEqual(
        order.some((entry) => entry.startsWith("projection:")),
        false,
      );
      const duplicate = yield* forks.executeRenderer(prepared.receiptId).pipe(Effect.exit);
      assert.strictEqual(duplicate._tag, "Failure");
      yield* forks.releaseRenderer(prepared.receiptId);
      const late = yield* forks.acceptRenderer(prepared.receiptId).pipe(Effect.exit);
      assert.strictEqual(late._tag, "Failure");
    }),
);
