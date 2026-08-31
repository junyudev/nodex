import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { CodexCanonicalConversationState } from "../../shared/types";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CoreModules, type CoreModuleClients } from "../core-runtime/CoreModules";
import { CodexConversationFork, type CodexConversationForkInput } from "./CodexConversationFork";
import { CodexConversationProjection } from "./CodexConversationProjection";
import { CodexForkSidePanelTransfer } from "./CodexForkSidePanelTransferRuntime";
import { CodexForkTitlePolicy } from "./CodexForkTitlePolicy";
import { CodexOwnerNotificationDrainRuntime } from "./CodexOwnerNotificationDrainRuntime";
import { CodexPendingWorktreeRuntime } from "./CodexPendingWorktreeRuntime";
import { make } from "./CodexProjectSessionFork";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { CodexThreadSettingsRuntime } from "./CodexThreadSettingsRuntime";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

const sessionId = "session-source";
const sourceThreadId = "thread-source";
const childThreadId = "thread-child";

const canonical = {
  turns: [
    {
      protocol: { id: "turn-a", status: "completed" },
      items: [],
      sidecar: { params: undefined, hookRuns: [] },
    },
  ],
  protocol: { id: sourceThreadId },
} as unknown as CodexCanonicalConversationState;

const makeHarness = () => {
  const order: string[] = [];
  const directForks: CodexConversationForkInput[] = [];
  const pendingRequests: unknown[] = [];
  const settings: unknown[] = [];
  const scene = {
    browserViewScopeId: "browser-scope",
    scene: { owner: { kind: "session", sessionId } },
  } as never;
  const core = CoreModules.of({
    workspace: {
      read: (input: Parameters<CoreModuleClients["workspace"]["read"]>[0]) => {
        if (input.kind === "session") {
          return Effect.succeed({
            value: {
              kind: "session",
              session: {
                id: sessionId,
                project_id: "project-a",
                thread_id: sourceThreadId,
              },
            },
          } as unknown as ProjectWorkspaceReadSnapshot);
        }
        if (input.kind === "project") {
          return Effect.succeed({
            value: {
              kind: "project",
              project: {
                lifecycle: "active",
                sources: [{ root: "/workspace" }, { root: "/shared" }],
              },
            },
          } as unknown as ProjectWorkspaceReadSnapshot);
        }
        return Effect.die("unexpected Core read");
      },
    },
  } as unknown as CoreModuleClients);
  const sourceSnapshot = {
    threadId: sourceThreadId,
    latestCollaborationMode: {
      mode: "default",
      settings: {
        model: "gpt-test",
        reasoning_effort: "high",
        developer_instructions: null,
      },
    },
  } as const;
  const directoryEntry = {
    fidelity: "materialized",
    durable: {
      threadId: sourceThreadId,
      sessionId,
      projectId: "project-a",
      executionHostId: "local",
      cwd: "/workspace",
      executionProfile: {
        providerId: "openai",
        modelId: "gpt-test",
        harnessId: null,
        reasoningEffort: "high",
        serviceTier: null,
      },
    },
    summary: {
      threadId: sourceThreadId,
      projectId: "project-a",
      forkedFromId: null,
      threadName: "Source title",
    },
    canonical,
    snapshot: sourceSnapshot,
  } as never;
  const capability = make.pipe(
    Effect.provideService(CoreModules, core),
    Effect.provideService(
      CodexGateway,
      CodexGateway.of({ localHostId: "local", events: Stream.empty } as never),
    ),
    Effect.provideService(
      CodexConversationFork,
      CodexConversationFork.of({
        fork: (input) =>
          Effect.sync(() => {
            order.push("direct:fork");
            directForks.push(input);
            return {
              threadId: childThreadId,
              session: { id: "session-child", thread: { threadId: childThreadId } },
              conversation: { threadId: childThreadId },
              composerIntent: { prompt: "", focusNonce: 1 },
            } as never;
          }),
      }),
    ),
    Effect.provideService(
      CodexConversationProjection,
      CodexConversationProjection.of({
        read: () => Effect.succeed({ canonical, snapshot: sourceSnapshot }) as never,
      } as never),
    ),
    Effect.provideService(
      CodexForkSidePanelTransfer,
      CodexForkSidePanelTransfer.of({
        capturePending: () =>
          Effect.sync(() => {
            order.push("side-panel:capture");
          }),
        discardPending: () => Effect.void,
      } as never),
    ),
    Effect.provideService(
      CodexForkTitlePolicy,
      CodexForkTitlePolicy.of({
        derive: () =>
          Effect.succeed({ sourceTitle: "Source title", childTitle: "Source title (2)" }),
      }),
    ),
    Effect.provideService(
      CodexOwnerNotificationDrainRuntime,
      CodexOwnerNotificationDrainRuntime.of({ awaitCurrent: () => Effect.void } as never),
    ),
    Effect.provideService(
      CodexPendingWorktreeRuntime,
      CodexPendingWorktreeRuntime.of({
        list: () => [],
        create: (request: Parameters<CodexPendingWorktreeRuntime["Service"]["create"]>[0]) =>
          Effect.sync(() => {
            order.push("pending:create");
            pendingRequests.push(request);
          }),
      } as never),
    ),
    Effect.provideService(
      CodexThreadDirectory,
      CodexThreadDirectory.of({
        resolve: () => Effect.succeed(directoryEntry),
      } as never),
    ),
    Effect.provideService(
      CodexThreadSettingsRuntime,
      CodexThreadSettingsRuntime.of({
        update: (input: Parameters<CodexThreadSettingsRuntime["Service"]["update"]>[0]) =>
          Effect.sync(() => {
            order.push("settings:update");
            settings.push(input);
            return {} as never;
          }),
      } as never),
    ),
    Effect.provideService(
      ConversationEntityMap,
      ConversationEntityMap.of({
        runCommand: <A, E, R>(_threadId: string, operation: Effect.Effect<A, E, R>) => operation,
      } as never),
    ),
  );
  return { capability, directForks, order, pendingRequests, scene, settings };
};

it.effect("forks a local Project Session through the canonical direct capability", () =>
  Effect.gen(function* () {
    const { capability, directForks, order, scene, settings } = makeHarness();
    const forks = yield* capability;
    const result = yield* forks.fork({
      sessionId,
      input: { target: "local", turnId: "turn-a", collaborationMode: "plan" },
      sourceSceneContext: scene,
    });

    assert.isTrue("session" in result);
    if (!("session" in result)) return;
    assert.strictEqual(result.session.id, "session-child");
    assert.strictEqual(result.session.thread?.threadId, childThreadId);
    assert.strictEqual(result.threadId, childThreadId);
    assert.deepEqual(result.composerIntent, { prompt: "", focusNonce: 1 });
    assert.deepEqual(directForks, [
      {
        sourceThreadId,
        lastTurnId: "turn-a",
        threadSource: "user",
        sourceSceneContext: scene,
      },
    ]);
    assert.deepEqual(settings, [
      {
        threadId: childThreadId,
        patch: { collaborationMode: "plan" },
      },
    ]);
    assert.deepEqual(order, ["direct:fork", "settings:update"]);
  }),
);

it.effect("captures browser state before publishing a pending worktree fork", () =>
  Effect.gen(function* () {
    const { capability, order, pendingRequests, scene } = makeHarness();
    const forks = yield* capability;
    const result = yield* forks.fork({
      sessionId,
      input: {
        target: "newWorktree",
        localEnvironmentConfigPath: ".codex/environments/dev.toml",
        turnId: "turn-a",
        collaborationMode: "plan",
      },
      threadSource: "subagent",
      sourceSceneContext: scene,
    });

    assert.deepEqual(order, ["side-panel:capture", "pending:create"]);
    assert.strictEqual(pendingRequests.length, 1);
    assert.isTrue("pendingWorktreeId" in result);
    if (!("pendingWorktreeId" in result)) return;
    const request = pendingRequests[0] as Record<string, unknown>;
    assert.strictEqual(result.pendingWorktreeId, request.id);
    assert.strictEqual(result.clientThreadId, request.clientThreadId);
    assert.deepEqual(request, {
      id: result.pendingWorktreeId,
      clientThreadId: result.clientThreadId,
      hostId: "local",
      label: "Source title (2)",
      initialThreadTitle: "Source title (2)",
      sourceWorkspaceRoot: "/workspace",
      sourceWorkspaceRoots: ["/workspace", "/shared"],
      startingState: { type: "working-tree" },
      localEnvironmentConfigPath: ".codex/environments/dev.toml",
      launchMode: "fork-conversation",
      projectAssignment: {
        projectKind: "local",
        projectId: "project-a",
        path: "/workspace",
        pendingCoreUpdate: false,
      },
      prompt: "Continue this task in a new worktree",
      startConversationParamsInput: null,
      sourceConversationId: sourceThreadId,
      sourceCollaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-test",
          reasoning_effort: "high",
          developer_instructions: null,
        },
      },
      targetTurnId: "turn-a",
      threadSource: "subagent",
    });
  }),
);
