import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { CodexPendingWorktreeEntry } from "../../shared/codex-pending-worktree";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { BrowserUseRuntime } from "../host-runtime/BrowserUseRuntime";
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

const request = (): CodexPendingWorktreeEntry => ({
  id: "local:pending-1",
  hostId: "local",
  label: "Delegated task",
  sourceWorkspaceRoot: "/source",
  startingState: { type: "branch", branchName: "main" },
  localEnvironmentConfigPath: null,
  prompt: "Implement it",
  launchMode: "start-conversation",
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
    const unsupported = () => Effect.die(new Error("unused"));
    const capability = createCodexAppServerCapabilitySnapshot({
      hostId: "local",
      generation: 17,
      userAgent: "codex-app-server/0.145.0-alpha.15",
    });
    const gateway = CodexGateway.of({
      localHostId: "local",
      events: Stream.empty,
      requestLocal: (method: string, _params: unknown, scheduling: unknown) =>
        Effect.sync(() => {
          requests.push({ method, scheduling });
          if (method === "thread/start") return { thread: { id: "thread-created" } };
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
          remember: () => Effect.void,
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
        CodexThreadDirectory,
        CodexThreadDirectory.of({
          acceptStandaloneStart: () =>
            Effect.succeed({ summary: { threadId: "thread-created" } } as never),
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
        CodexTurnCommands.of({ start: () => Effect.succeed({ id: "turn-1" } as never) } as never),
      ),
      Effect.provideService(
        BrowserUseRuntime,
        BrowserUseRuntime.of({ promoteRoute: unsupported } as never),
      ),
      Effect.provideService(ManagedWorktreeRuntime, ManagedWorktreeRuntime.of({} as never)),
      Effect.provideService(ProjectWorkspace, ProjectWorkspace.of({} as never)),
    );

    assert.deepEqual(yield* service.launchPending(request(), "/worktree", false), {
      threadId: "thread-created",
    });
    assert.deepEqual(requests, [
      {
        method: "thread/start",
        scheduling: { expectedHostId: "local", expectedGeneration: 17 },
      },
    ]);
  }),
);
