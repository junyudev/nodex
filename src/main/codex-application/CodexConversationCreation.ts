import type { ThreadStartParams, ThreadStartResponse } from "@nodex/codex-app-server-protocol/v2";
import type { ClientRequestParamsByMethod } from "@nodex/effect-codex-app-server/rpc";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  CodexPendingStartConversationRequest,
  CodexPendingWorktreeEntry,
} from "../../shared/codex-pending-worktree";
import {
  buildCodexPendingWorktreeInitItem,
  extractCodexUserRequestSection,
} from "../../shared/codex-pending-worktree";
import { createCodexTextUserInput } from "../../shared/codex-prompt-preparation";
import type { CodexCanonicalWorktreeInitItem, CodexPreparedPrompt } from "../../shared/types";
import { buildCodexThreadConfigOverrides } from "../codex/codex-thread-capabilities";
import { rewriteExecutionWorkspaceRoots } from "../codex/codex-execution-workspace-roots";
import { projectCodexPendingWorktreeLaunchLocation } from "../codex/codex-pending-worktree-request";
import {
  CodexAppServerCapabilities,
  type CodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway, codexGatewayGenerationFence } from "../codex-runtime/CodexGateway";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { CodexAttachments } from "./CodexAttachments";
import { CodexClientThreadIdentity } from "./CodexClientThreadIdentity";
import { CodexConversationFork } from "./CodexConversationFork";
import { CodexForkSidePanelTransfer } from "./CodexForkSidePanelTransferRuntime";
import { CodexThreadDirectory } from "./CodexThreadDirectory";
import { CodexThreadGoalRuntime } from "./CodexThreadGoalRuntime";
import { CodexThreadLaunchCompletion } from "./CodexThreadLaunchCompletion";
import { ThreadCreationRuntime } from "./ThreadCreationRuntime";
import { CodexThreadTitlePersistence } from "./CodexThreadTitlePersistence";
import { CodexTurnCommands } from "./CodexTurnCommands";
import { BrowserUseRuntime } from "../host-runtime/BrowserUseRuntime";
import { ManagedWorktreeRuntime } from "./ManagedWorktreeRuntime";

type GatewayThreadStartParams = ClientRequestParamsByMethod["thread/start"];

export class CodexConversationCreationError extends Schema.TaggedError<CodexConversationCreationError>()(
  "CodexConversationCreationError",
  {
    operation: Schema.String,
    pendingWorktreeId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class CodexConversationCreation extends Context.Service<
  CodexConversationCreation,
  {
    /** Materializes the Thread identity and first Turn selected by one pending worktree. */
    readonly launchPending: (
      entry: CodexPendingWorktreeEntry,
      workspaceRoot: string,
      includeWorktreeInit: boolean,
    ) => Effect.Effect<{ readonly threadId: string }, CodexConversationCreationError>;
  }
>()("nodex/main/codex-application/CodexConversationCreation") {}

const permissionMode = (
  mode: CodexPendingStartConversationRequest["startConversationParamsInput"]["agentMode"],
) => (mode === "read-only" || mode === "granular" ? "custom" : mode);

const collaborationMode = (
  value: CodexPendingStartConversationRequest["startConversationParamsInput"]["collaborationMode"],
) => (value?.mode === "default" || value?.mode === "plan" ? value.mode : undefined);

const preparedPrompt = (
  entry: CodexPendingStartConversationRequest,
  prompt: string,
): CodexPreparedPrompt => {
  const inputItems = [...entry.startConversationParamsInput.input];
  const firstTextIndex = inputItems.findIndex((item) => item.type === "text");
  if (firstTextIndex < 0) inputItems.unshift(createCodexTextUserInput(prompt));
  else inputItems[firstTextIndex] = createCodexTextUserInput(prompt);
  return {
    promptText: prompt,
    inputItems,
    pendingInputItems: [],
    fileAttachments: [...entry.startConversationParamsInput.fileAttachments],
    addedFiles: [...entry.startConversationParamsInput.addedFiles],
    pastedTextAttachments: [],
    commentAttachments: [...entry.startConversationParamsInput.commentAttachments],
    agentConfigs: [],
  };
};

export const make: Effect.Effect<
  CodexConversationCreation["Service"],
  never,
  | CodexAttachments
  | CodexClientThreadIdentity
  | CodexConversationFork
  | CodexForkSidePanelTransfer
  | CodexAppServerCapabilities
  | CodexGateway
  | CodexThreadDirectory
  | CodexThreadGoalRuntime
  | CodexThreadLaunchCompletion
  | ThreadCreationRuntime
  | CodexThreadTitlePersistence
  | CodexTurnCommands
  | BrowserUseRuntime
  | ManagedWorktreeRuntime
  | ProjectWorkspace
> = Effect.gen(function* () {
  const attachments = yield* CodexAttachments;
  const clientIdentity = yield* CodexClientThreadIdentity;
  const conversationFork = yield* CodexConversationFork;
  const forkTransfers = yield* CodexForkSidePanelTransfer;
  const capabilities = yield* CodexAppServerCapabilities;
  const gateway = yield* CodexGateway;
  const directory = yield* CodexThreadDirectory;
  const goals = yield* CodexThreadGoalRuntime;
  const completion = yield* CodexThreadLaunchCompletion;
  const threadStarts = yield* ThreadCreationRuntime;
  const titles = yield* CodexThreadTitlePersistence;
  const turns = yield* CodexTurnCommands;
  const browserUse = yield* BrowserUseRuntime;
  const managedWorktrees = yield* ManagedWorktreeRuntime;
  const workspace = yield* ProjectWorkspace;

  const fail = (operation: string, entry: CodexPendingWorktreeEntry, cause: unknown) =>
    new CodexConversationCreationError({ operation, pendingWorktreeId: entry.id, cause });

  const finishWorktree = Effect.fn("CodexConversationCreation.finishWorktree")(function* (
    entry: CodexPendingWorktreeEntry,
    threadId: string,
    workspaceRoot: string,
    includeWorktreeInit: boolean,
    promoteTransfer: boolean,
  ) {
    const warn = (operation: string) => (cause: unknown) =>
      Effect.logWarning("Pending worktree metadata projection failed").pipe(
        Effect.annotateLogs({ operation, pendingWorktreeId: entry.id, threadId, cause }),
      );
    if (promoteTransfer) {
      yield* forkTransfers
        .promotePending({
          pendingWorktreeId: entry.id,
          targetConversationId: threadId,
          targetWorkspaceRoot: workspaceRoot,
        })
        .pipe(Effect.catchCause(warn("promote-side-panel")));
    }
    if (entry.isPinned) {
      yield* workspace
        .setThreadPinned(threadId, true, entry.pinnedBeforeThreadId)
        .pipe(Effect.catchCause(warn("pin-thread")));
    }
    if (!includeWorktreeInit || !entry.worktreeGitRoot) return;
    yield* managedWorktrees
      .setOwner({
        hostId: entry.hostId,
        worktreeGitRoot: entry.worktreeGitRoot,
        ownerThreadId: threadId,
      })
      .pipe(
        Effect.ensuring(
          managedWorktrees
            .releaseNewborn({
              hostId: entry.hostId,
              worktreeGitRoot: entry.worktreeGitRoot,
            })
            .pipe(Effect.catchCause(warn("release-newborn-worktree"))),
        ),
        Effect.catchCause(warn("set-worktree-owner")),
      );
  });

  const launchFork = Effect.fn("CodexConversationCreation.launchFork")(function* (
    entry: Extract<CodexPendingWorktreeEntry, { readonly launchMode: "fork-conversation" }>,
    workspaceRoot: string,
    worktreeInit: CodexCanonicalWorktreeInitItem | undefined,
    includeWorktreeInit: boolean,
  ) {
    const source = yield* directory
      .resolve({ threadId: entry.sourceConversationId, fidelity: "durable" })
      .pipe(Effect.mapError((cause) => fail("resolve-fork-source", entry, cause)));
    if (!source) {
      return yield* fail(
        "resolve-fork-source",
        entry,
        new Error(`Fork source '${entry.sourceConversationId}' was not found`),
      );
    }
    const roots = rewriteExecutionWorkspaceRoots({
      sourcePrimary: entry.sourceWorkspaceRoot,
      targetPrimary: workspaceRoot,
      workspaceRoots: entry.sourceWorkspaceRoots,
    });
    const forked = yield* conversationFork
      .fork({
        sourceThreadId: entry.sourceConversationId,
        lastTurnId: entry.targetTurnId ?? null,
        threadSource: entry.threadSource ?? "user",
        target: {
          projectId: entry.projectAssignment?.projectId ?? source.durable.projectId,
          cwd: workspaceRoot,
          managedWorktreePath: includeWorktreeInit ? entry.worktreeGitRoot : null,
          runtimeWorkspaceRoots: roots,
        },
        pendingWorktreeId: entry.id,
        ...(worktreeInit ? { worktreeInit } : {}),
        titleOverride: {
          childTitle: (entry.labelEdited ? entry.label : entry.initialThreadTitle)?.trim() || null,
        },
      })
      .pipe(Effect.mapError((cause) => fail("fork", entry, cause)));
    if (entry.clientThreadId) {
      yield* clientIdentity
        .remember(forked.threadId, entry.clientThreadId)
        .pipe(Effect.mapError((cause) => fail("remember-client-thread", entry, cause)));
    }
    yield* finishWorktree(entry, forked.threadId, workspaceRoot, includeWorktreeInit, false);
    return { threadId: forked.threadId };
  });

  const launchStartPhysical = Effect.fn("CodexConversationCreation.launchStart")(function* (
    entry: Extract<CodexPendingWorktreeEntry, { readonly launchMode: "start-conversation" }>,
    workspaceRoot: string,
    worktreeInit: CodexCanonicalWorktreeInitItem | undefined,
    includeWorktreeInit: boolean,
    capability: CodexAppServerCapabilitySnapshot,
  ) {
    const params = entry.startConversationParamsInput;
    const location = projectCodexPendingWorktreeLaunchLocation({
      params,
      sourceWorkspaceRoot: entry.sourceWorkspaceRoot,
      worktreeWorkspaceRoot: workspaceRoot,
    });
    const executionProfile = params.executionProfile ?? null;
    const request: ThreadStartParams = {
      cwd: location.cwd,
      runtimeWorkspaceRoots: [...location.workspaceRoots],
      model: executionProfile?.modelId ?? params.collaborationMode?.settings.model ?? null,
      modelProvider: executionProfile?.providerId ?? null,
      serviceTier: executionProfile?.serviceTier ?? params.serviceTier,
      baseInstructions: params.baseInstructions ?? null,
      developerInstructions: params.additionalDeveloperInstructions ?? null,
      threadSource: params.threadSource,
      config: {
        ...buildCodexThreadConfigOverrides(),
        ...(params.configOverrides ?? {}),
        ...(executionProfile?.harnessId ? { harness: executionProfile.harnessId } : {}),
        ...((executionProfile?.reasoningEffort ?? params.reasoningEffort)
          ? {
              model_reasoning_effort: executionProfile?.reasoningEffort ?? params.reasoningEffort,
            }
          : {}),
      },
    };
    let startedThreadId: string | null = null;
    let committed = false;
    let materializedGoalDirectory: string | null = null;
    return yield* Effect.gen(function* () {
      const response = (yield* gateway.requestLocal(
        "thread/start",
        request as GatewayThreadStartParams,
        codexGatewayGenerationFence(capability),
      )) as unknown as ThreadStartResponse;
      startedThreadId = response.thread.id;
      const projectId = location.projectAssignment?.projectId ?? null;
      const accepted = entry.projectSessionId
        ? yield* directory.acceptSessionStart({
            response,
            sessionId: entry.projectSessionId,
            projectId,
            executionProfile,
            runtimeWorkspaceRoots: location.workspaceRoots,
            fallbackCwd: location.cwd,
          })
        : yield* directory.acceptStandaloneStart({
            response,
            projectId,
            executionProfile,
            runtimeWorkspaceRoots: location.workspaceRoots,
            fallbackCwd: location.cwd,
            managedWorktreePath: includeWorktreeInit ? entry.worktreeGitRoot : null,
          });
      const threadId = accepted.summary.threadId;
      const initialTitle = (
        entry.labelEdited ? entry.label : (entry.initialThreadTitle ?? "")
      ).trim();
      if (entry.clientThreadId) {
        yield* clientIdentity
          .remember(threadId, entry.clientThreadId)
          .pipe(Effect.mapError((cause) => fail("remember-client-thread", entry, cause)));
      }
      const materializedGoal =
        includeWorktreeInit && entry.threadGoalDraft
          ? yield* attachments.materializeGoal(entry.threadGoalDraft)
          : null;
      materializedGoalDirectory = materializedGoal?.attachmentDirectory ?? null;
      const prompt = materializedGoal
        ? `/goal ${materializedGoal.objective}`
        : extractCodexUserRequestSection(entry.prompt);
      const turn = yield* turns.start(threadId, prompt, {
        preparedPrompt: preparedPrompt(entry, prompt),
        model: executionProfile?.modelId ?? params.collaborationMode?.settings.model ?? undefined,
        serviceTier: params.serviceTier,
        reasoningEffort: executionProfile?.reasoningEffort ?? params.reasoningEffort ?? undefined,
        collaborationMode: collaborationMode(params.collaborationMode),
        permissionMode: permissionMode(params.agentMode),
        ...(worktreeInit ? { worktreeInit } : {}),
      });
      if (!turn) {
        return yield* fail("first-turn", entry, new Error("Pending Thread has no first Turn"));
      }
      committed = true;
      const bestEffort = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Started pending worktree Thread with incomplete metadata").pipe(
              Effect.annotateLogs({ operation, pendingWorktreeId: entry.id, threadId, cause }),
            ),
          ),
        );
      if (initialTitle) {
        yield* bestEffort(
          "set-title",
          titles.set({ threadId, name: initialTitle, normalization: "manual" }),
        );
      }
      if (entry.browserUsePresentationOrigin) {
        yield* bestEffort(
          "promote-browser-route",
          browserUse.promoteRoute({
            ...entry.browserUsePresentationOrigin,
            codexSessionId: threadId,
            projectId,
          }),
        );
      }
      if (materializedGoal) {
        yield* bestEffort(
          "set-goal",
          goals.set({
            threadId,
            objective: materializedGoal.objective,
            status: "active",
            appendTranscriptItem: false,
          }),
        );
      }
      if (entry.projectSessionId) {
        const observedAt = yield* Clock.currentTimeMillis;
        yield* bestEffort(
          "complete-launch",
          completion.accepted({
            projectId,
            sessionId: entry.projectSessionId,
            threadId,
            runInTarget: "newWorktree",
            startedAt: observedAt,
            goalObjective: "",
            rawGoalDraft: null,
            heartbeatAutomation: entry.heartbeatAutomation ?? null,
          }),
        );
      }
      yield* bestEffort(
        "cleanup-goal-sources",
        attachments.cleanupGoalSources(
          entry.threadGoalDraft,
          entry.threadStartHostId ?? entry.hostId,
        ),
      );
      yield* bestEffort(
        "finish-worktree",
        finishWorktree(entry, threadId, workspaceRoot, includeWorktreeInit, true),
      );
      return { threadId };
    }).pipe(
      Effect.onExit(() =>
        committed
          ? Effect.void
          : Effect.all(
              [
                materializedGoalDirectory
                  ? attachments
                      .cleanupMaterializedGoal(materializedGoalDirectory)
                      .pipe(Effect.ignore)
                  : Effect.void,
                startedThreadId
                  ? gateway
                      .requestLocal(
                        "thread/delete",
                        { threadId: startedThreadId },
                        codexGatewayGenerationFence(capability),
                      )
                      .pipe(Effect.ignore)
                  : Effect.void,
                startedThreadId && entry.clientThreadId
                  ? clientIdentity.forget(startedThreadId).pipe(Effect.ignore)
                  : Effect.void,
              ],
              { discard: true },
            ),
      ),
      Effect.mapError((cause) =>
        cause instanceof CodexConversationCreationError ? cause : fail("start", entry, cause),
      ),
    );
  });

  const launchStart = (
    entry: Extract<CodexPendingWorktreeEntry, { readonly launchMode: "start-conversation" }>,
    workspaceRoot: string,
    worktreeInit: CodexCanonicalWorktreeInitItem | undefined,
    includeWorktreeInit: boolean,
  ) =>
    Effect.gen(function* () {
      const capability = yield* capabilities
        .forHost(gateway.localHostId)
        .pipe(Effect.mapError((cause) => fail("start", entry, cause)));
      return yield* threadStarts.materialize(
        capability.hostId,
        capability.generation,
        launchStartPhysical(entry, workspaceRoot, worktreeInit, includeWorktreeInit, capability),
        (result) => result.threadId,
      );
    });

  return CodexConversationCreation.of({
    launchPending: (entry, workspaceRoot, includeWorktreeInit) => {
      if (entry.launchMode === "create-stable-worktree") {
        return Effect.fail(
          fail("launch", entry, new Error("Stable pending worktrees do not launch Threads")),
        );
      }
      const worktreeInit = includeWorktreeInit
        ? (buildCodexPendingWorktreeInitItem(entry) ?? undefined)
        : undefined;
      if (includeWorktreeInit && !worktreeInit) {
        return Effect.fail(
          fail("launch", entry, new Error("Pending worktree is not ready to launch")),
        );
      }
      return entry.launchMode === "fork-conversation"
        ? launchFork(entry, workspaceRoot, worktreeInit, includeWorktreeInit)
        : launchStart(entry, workspaceRoot, worktreeInit, includeWorktreeInit);
    },
  });
});
