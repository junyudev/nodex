import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { CodexExecutionProfile } from "../../shared/codex-execution-profile";
import type { CodexTurnStartOptions } from "../../shared/types";
import type {
  CodexPendingStartConversationParamsInput,
  CodexPendingWorktreeEntry,
} from "../../shared/codex-pending-worktree";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { BrowserUseRuntime } from "../host-runtime/BrowserUseRuntime";
import { DesktopToolRuntime } from "../host-runtime/DesktopToolRuntime";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { CodexAttachments } from "./CodexAttachments";
import { CodexClientThreadIdentity } from "./CodexClientThreadIdentity";
import { make } from "./CodexConversationCreation";
import { CodexConversationFork } from "./CodexConversationFork";
import { CodexForkSidePanelTransfer } from "./CodexForkSidePanelTransferRuntime";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { CodexThreadGoalRuntime } from "./CodexThreadGoalRuntime";
import { CodexThreadLaunchCompletion } from "./CodexThreadLaunchCompletion";
import { ThreadCreationRuntime } from "./ThreadCreationRuntime";
import { transparentThreadCreationRuntime } from "./ThreadCreationRuntime.test-support";
import { CodexThreadTitlePersistence } from "./CodexThreadTitlePersistence";
import { CodexTurnCommands } from "./CodexTurnCommands";
import { ManagedWorktreeRuntime } from "./ManagedWorktreeRuntime";

const request = (): Extract<
  CodexPendingWorktreeEntry,
  { readonly launchMode: "start-conversation" }
> => ({
  id: "local:pending-1",
  hostId: "local",
  label: "Delegated task",
  sourceWorkspaceRoot: "/source",
  startingState: { type: "branch", branchName: "main" },
  localEnvironmentConfigPath: null,
  prompt: "Implement it",
  launchMode: "start-conversation",
  firstSubmission: {
    launchId: "01991e60-b800-7000-8000-000000000101",
    clientUserMessageId: "01991e60-b800-7000-8000-000000000102",
  },
  clientThreadId: "client-new-thread:local:pending-1",
  startConversationParamsInput: {
    input: [],
    commentAttachments: [],
    workspaceRoots: ["/source"],
    cwd: "/source",
    fileAttachments: [],
    addedFiles: [],
    agentMode: "auto",
    shouldSendPermissionOverrides: true,
    model: null,
    serviceTier: null,
    reasoningEffort: null,
    collaborationMode: null,
    config: {},
    threadSource: "subagent",
    workspaceKind: "project",
    projectAssignment: {
      projectKind: "local",
      projectId: "project-pending",
      pendingCoreUpdate: false,
    },
  },
  sourceConversationId: null,
  sourceCollaborationMode: null,
  createdAt: 1,
  attempt: 1,
  phase: "worktree-ready",
  labelEdited: true,
  worktreeOutputText: "",
  setupOutputText: "",
  errorMessage: null,
  worktreeWorkspaceRoot: "/worktree",
  worktreeGitRoot: "/worktree",
  needsAttention: false,
  isPinned: false,
  pinnedBeforeThreadId: null,
});

it.effect("keeps an accepted first Turn when later launch metadata fails", () =>
  Effect.gen(function* () {
    const requests: Array<{ readonly method: string; readonly scheduling: unknown }> = [];
    const threadStartParams: Record<string, unknown>[] = [];
    const acceptedCapabilities: CodexAppServerCapabilitySnapshot[] = [];
    const firstTurnOverrides: Record<string, unknown>[] = [];
    const launchEvents: string[] = [];
    const unsupported = () => Effect.die(new Error("unused"));
    const capability = createCodexAppServerCapabilitySnapshot({
      hostId: "local",
      generation: 17,
      userAgent: "codex-app-server/0.145.0-alpha.15",
    });
    const gateway = CodexGateway.of({
      localHostId: "local",
      events: Stream.empty,
      requestLocal: (method: string, params: unknown, scheduling: unknown) =>
        Effect.sync(() => {
          requests.push({ method, scheduling });
          if (method === "thread/start") {
            const requestParams = params as Record<string, unknown>;
            threadStartParams.push(requestParams);
            return {
              thread: { id: "thread-created", historyMode: "paginated", turns: [] },
              model: requestParams.model,
              modelProvider: requestParams.modelProvider,
              reasoningEffort: (requestParams.config as Record<string, unknown> | undefined)
                ?.model_reasoning_effort,
              serviceTier:
                requestParams.serviceTier === null ? "default" : requestParams.serviceTier,
            };
          }
          return {};
        }) as never,
      requestRawOnHost: unsupported,
      requestRawForThread: unsupported,
      requestOnHost: unsupported,
      requestForThread: unsupported,
      notifyLocal: unsupported,
      connection: unsupported,
      connectionChanges: () => Stream.empty,
      awaitReady: () => Effect.void,
      reconcileHost: unsupported,
      removeHost: unsupported,
      restartHost: unsupported,
    });
    const service = yield* make.pipe(
      Effect.provideService(
        CodexAppServerCapabilities,
        CodexAppServerCapabilities.of({
          forHost: () => Effect.succeed(capability),
          forThread: () => Effect.succeed(capability),
          isCurrent: () => Effect.succeed(true),
        }),
      ),
      Effect.provideService(
        CodexAttachments,
        CodexAttachments.of({
          materializeGoal: unsupported,
          cleanupGoalSources: () => Effect.void,
          cleanupMaterializedGoal: () => Effect.void,
        } as unknown as CodexAttachments["Service"]),
      ),
      Effect.provideService(
        CodexClientThreadIdentity,
        CodexClientThreadIdentity.of({
          remember: () => Effect.sync(() => launchEvents.push("identity:remembered")),
          forget: () => Effect.void,
        } as unknown as CodexClientThreadIdentity["Service"]),
      ),
      Effect.provideService(
        CodexConversationFork,
        CodexConversationFork.of({ fork: unsupported } as never),
      ),
      Effect.provideService(
        CodexForkSidePanelTransfer,
        CodexForkSidePanelTransfer.of({ promotePending: unsupported } as never),
      ),
      Effect.provideService(CodexGateway, gateway),
      Effect.provideService(
        DesktopToolRuntime,
        DesktopToolRuntime.of({
          threadConfig: Effect.succeed({
            "features.js_repl": false,
            "mcp_servers.node_repl": { command: "/runtime/node" },
          }),
        } as unknown as DesktopToolRuntime["Service"]),
      ),
      Effect.provideService(
        CodexThreadDirectory,
        CodexThreadDirectory.of({
          acceptStandaloneStart: (
            input: Parameters<CodexThreadDirectory["Service"]["acceptStandaloneStart"]>[0],
          ) =>
            Effect.sync(() => {
              acceptedCapabilities.push(input.capability);
              return { summary: { threadId: "thread-created" } } as never;
            }),
        } as never),
      ),
      Effect.provideService(
        CodexThreadGoalRuntime,
        CodexThreadGoalRuntime.of({ set: unsupported } as never),
      ),
      Effect.provideService(
        CodexThreadLaunchCompletion,
        CodexThreadLaunchCompletion.of({ accepted: unsupported } as never),
      ),
      Effect.provideService(ThreadCreationRuntime, transparentThreadCreationRuntime),
      Effect.provideService(
        CodexThreadTitlePersistence,
        CodexThreadTitlePersistence.of({ set: unsupported } as never),
      ),
      Effect.provideService(
        CodexTurnCommands,
        CodexTurnCommands.of({
          start: (_threadId: string, _prompt: string, overrides?: CodexTurnStartOptions) =>
            Effect.sync(() => {
              launchEvents.push("turn:accepted");
              firstTurnOverrides.push((overrides ?? {}) as Record<string, unknown>);
              return { id: "turn-1" } as never;
            }),
        } as never),
      ),
      Effect.provideService(
        BrowserUseRuntime,
        BrowserUseRuntime.of({ promoteRoute: unsupported } as never),
      ),
      Effect.provideService(ManagedWorktreeRuntime, ManagedWorktreeRuntime.of({} as never)),
      Effect.provideService(ProjectWorkspace, ProjectWorkspace.of({} as never)),
    );

    const pending = request();
    const executionProfile: CodexExecutionProfile = {
      modelId: "gpt-5.6-luna",
      reasoningEffort: "max",
      serviceTier: null,
    };
    const startConversationParamsInput: CodexPendingStartConversationParamsInput = {
      ...pending.startConversationParamsInput,
      executionProfile,
      serviceTier: "fast",
    };
    assert.deepEqual(
      yield* service.launchPending(
        {
          ...pending,
          startConversationParamsInput,
        },
        "/worktree",
        false,
      ),
      {
        threadId: "thread-created",
      },
    );
    assert.deepEqual(requests, [
      {
        method: "thread/start",
        scheduling: { expectedHostId: "local", expectedGeneration: 17 },
      },
    ]);
    assert.strictEqual(threadStartParams[0]?.serviceTier, null);
    assert.strictEqual(threadStartParams[0]?.historyMode, "paginated");
    assert.isUndefined(threadStartParams[0]?.allowProviderModelFallback);
    assert.deepEqual(threadStartParams[0]?.config, {
      "features.js_repl": false,
      "mcp_servers.node_repl": { command: "/runtime/node" },
      "features.apply_patch_streaming_events": true,
      "features.concurrent_reasoning_summaries": true,
      "features.thread_tools": true,
      model_reasoning_effort: "max",
    });
    assert.strictEqual(firstTurnOverrides[0]?.serviceTier, null);
    assert.deepEqual(acceptedCapabilities, [capability]);
    assert.deepEqual(launchEvents, ["turn:accepted", "identity:remembered"]);
  }),
);
