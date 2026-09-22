import { live as inactiveThreadArchiveLive } from "../platform/node/CodexInactiveThreadArchive";
import { randomUUID } from "node:crypto";
import {
  CodexRendererSessionLaunch,
  make as makeRendererSessionLaunch,
} from "../codex-application/CodexRendererSessionLaunch";
import {
  CodexNativeThreadLookup,
  make as makeNativeThreadLookup,
} from "../codex-application/CodexNativeThreadLookup";
import {
  CodexMainConversationResume,
  make as makeMainConversationResume,
} from "../codex-application/CodexMainConversationResume";
import { layer as resumeIngressLayer } from "../codex-application/CodexResumeIngress";
import {
  CodexDelegatedMessages,
  make as makeDelegatedMessages,
} from "../codex-application/CodexDelegatedMessages";
import { install as installBrowserSessionActivity } from "../codex-application/CodexBrowserSessionActivity";
import { CodexWaitThreads, make as makeWaitThreads } from "../codex-application/CodexWaitThreads";
import {
  CodexMainConversationEdit,
  make as makeMainConversationEdit,
} from "../codex-application/CodexMainConversationEdit";
import {
  CodexMainConversationInterrupt,
  make as makeMainConversationInterrupt,
} from "../codex-application/CodexMainConversationInterrupt";
import {
  CodexNodeReplRuntime,
  make as makeNodeReplRuntime,
} from "../codex-application/CodexNodeReplRuntime";
import {
  CodexMainConversationSettings,
  make as makeMainConversationSettings,
} from "../codex-application/CodexMainConversationSettings";
import {
  CodexMainConversationHistory,
  make as makeMainConversationHistory,
} from "../codex-application/CodexMainConversationHistory";
import { install as installMainConversationActions } from "../codex-application/CodexMainConversationActions";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  CodexConversationContext,
  make as makeCodexConversationContext,
} from "../codex-application/CodexConversationContext";
import {
  CodexConversationProjection,
  make as makeCodexConversationProjection,
} from "../codex-application/CodexConversationProjection";
import {
  CodexConversationRelationships,
  make as makeCodexConversationRelationships,
} from "../codex-application/CodexConversationRelationships";
import {
  CodexExternalAgentImportRuntime,
  make as makeCodexExternalAgentImportRuntime,
} from "../codex-application/CodexExternalAgentImportRuntime";
import { CodexGitProbe, make as makeCodexGitProbe } from "../codex-application/CodexGitProbe";
import { ExecutionHostRuntime } from "../codex-application/ExecutionHostRuntime";
import {
  CodexHeartbeatTurnCompletion,
  CodexHeartbeatTurnCompletionError,
  make as makeCodexHeartbeatTurnCompletion,
} from "../codex-application/CodexHeartbeatTurnCompletion";
import {
  CodexInternalThreadRegistry,
  make as makeCodexInternalThreadRegistry,
} from "../codex-application/CodexInternalThreadRegistry";
import {
  CodexSidebarSyncRuntime,
  make as makeCodexSidebarSyncRuntime,
} from "../codex-application/CodexSidebarSyncRuntime";
import {
  CodexSidebarSectionSync,
  make as makeCodexSidebarSectionSync,
} from "../codex-application/CodexSidebarSectionSync";
import {
  CodexStructuredThreadTitle,
  CodexStructuredThreadTitleError,
  make as makeCodexStructuredThreadTitle,
} from "../codex-application/CodexStructuredThreadTitle";
import {
  CodexThreadDirectory,
  make as makeCodexThreadDirectory,
} from "../codex-application/CodexThreadDirectory";
import { live as codexThreadGoalRuntimeLive } from "../codex-application/CodexThreadGoalRuntime";
import {
  CodexThreadTitlePersistence,
  make as makeCodexThreadTitlePersistence,
} from "../codex-application/CodexThreadTitlePersistence";
import {
  CodexThreadDescriptionPersistence,
  make as makeCodexThreadDescriptionPersistence,
} from "../codex-application/CodexThreadDescriptionPersistence";
import {
  CodexAutoThreadTitle,
  make as makeCodexAutoThreadTitle,
} from "../codex-application/CodexAutoThreadTitle";
import {
  CodexThreadTitleAppTools,
  make as makeCodexThreadTitleAppTools,
} from "../codex-application/CodexThreadTitleAppTools";
import {
  CodexThreadTitleReconsideration,
  make as makeCodexThreadTitleReconsideration,
} from "../codex-application/CodexThreadTitleReconsideration";

import {
  CodexThreadHistoryFeatures,
  make as makeCodexThreadHistoryFeatures,
} from "../codex-application/CodexThreadHistoryFeatures";
import {
  CodexConversationHistoryExport,
  make as makeCodexConversationHistoryExport,
} from "../codex-application/CodexConversationHistoryExport";
import {
  CodexHistoryPageAdapter,
  make as makeCodexHistoryPageAdapter,
} from "../codex-application/CodexHistoryPageAdapter";
import {
  CodexHistorySearchAdapter,
  make as makeCodexHistorySearchAdapter,
} from "../codex-application/CodexHistorySearchAdapter";
import {
  CodexReadThreadHistory,
  make as makeCodexReadThreadHistory,
} from "../codex-application/CodexReadThreadHistory";
import {
  CodexPersistedHistorySearchRuntime,
  make as makeCodexPersistedHistorySearchRuntime,
} from "../codex-application/CodexPersistedHistorySearchRuntime";
import {
  CodexSubagentDirectory,
  make as makeCodexSubagentDirectory,
} from "../codex-application/CodexSubagentDirectory";
import {
  CodexConversationMaterialization,
  make as makeCodexConversationMaterialization,
} from "../codex-application/CodexConversationMaterialization";
import {
  CodexAutomationRunAcceptance,
  make as makeCodexAutomationRunAcceptance,
} from "../codex-application/CodexAutomationRunAcceptance";
import {
  CodexTurnAuthority,
  make as makeCodexTurnAuthority,
} from "../codex-application/CodexTurnAuthority";
import {
  CodexNotificationAdmission,
  make as makeCodexNotificationAdmission,
} from "../codex-application/CodexNotificationAdmission";
import {
  CodexAgentConfigRuntime,
  make as makeCodexAgentConfigRuntime,
} from "../codex-application/CodexAgentConfigRuntime";
import {
  CodexTurnPreparation,
  make as makeCodexTurnPreparation,
} from "../codex-application/CodexTurnPreparation";
import {
  CodexQueuedFollowUps,
  make as makeCodexQueuedFollowUps,
} from "../codex-application/CodexQueuedFollowUps";
import { codexInputAssetsLive } from "../codex-application/CodexInputAssets";
import {
  CodexTurnCommands,
  make as makeCodexTurnCommands,
} from "../codex-application/CodexTurnCommands";
import {
  CodexThreadLaunchCompletion,
  make as makeCodexThreadLaunchCompletion,
} from "../codex-application/CodexThreadLaunchCompletion";
import {
  CodexFreshThreadLaunchRuntime,
  make as makeCodexFreshThreadLaunchRuntime,
} from "../codex-application/CodexFreshThreadLaunchRuntime";
import {
  CodexConversationArchive,
  make as makeCodexConversationArchive,
} from "../codex-application/CodexConversationArchive";
import { live as conversationCommandsLive } from "../codex-application/ConversationCommands";
import {
  CodexConversationDeltaBufferRuntime,
  make as makeCodexConversationDeltaBufferRuntime,
} from "../codex-application/CodexConversationDeltaBufferRuntime";

import { live as codexThreadExecutionLive } from "../codex-application/CodexThreadExecution";
import {
  CodexThreadCatalog,
  make as makeCodexThreadCatalog,
} from "../codex-application/CodexThreadCatalog";
import {
  CodexClientThreadIdentity,
  make as makeCodexClientThreadIdentity,
} from "../codex-application/CodexClientThreadIdentity";
import {
  CodexForkSidePanelTransfer,
  make as makeCodexForkSidePanelTransfer,
} from "../codex-application/CodexForkSidePanelTransferRuntime";
import {
  CodexForkTitlePolicy,
  make as makeCodexForkTitlePolicy,
} from "../codex-application/CodexForkTitlePolicy";
import {
  CodexConversationFork,
  make as makeCodexConversationFork,
} from "../codex-application/CodexConversationFork";
import {
  CodexConversationCreation,
  make as makeCodexConversationCreation,
} from "../codex-application/CodexConversationCreation";
import {
  CodexPendingWorktreeRuntime,
  make as makeCodexPendingWorktreeRuntime,
} from "../codex-application/CodexPendingWorktreeRuntime";
import { live as managedWorktreeRetentionLive } from "../codex-application/ManagedWorktreeRetentionRuntime";
import { live as crossHostThreadHandoffLive } from "../codex-application/CrossHostThreadHandoff";
import { live as managedWorktreeHandoffLive } from "../codex-application/ManagedWorktreeHandoff";
import {
  CodexThreadHandoffRuntime,
  make as makeCodexThreadHandoffRuntime,
} from "../codex-application/CodexThreadHandoffRuntime";
import {
  AgentImportRuntime,
  make as makeAgentImportRuntime,
} from "../codex-application/AgentImportRuntime";
import { live as codexManualCompactionLive } from "../codex-application/CodexManualCompactionRuntime";
import {
  CodexProjectSessionFork,
  make as makeCodexProjectSessionFork,
} from "../codex-application/CodexProjectSessionFork";
import {
  CodexSideChatCommands,
  make as makeCodexSideChatCommands,
} from "../codex-application/CodexSideChatCommands";
import {
  CodexSessionThreadLaunch,
  make as makeCodexSessionThreadLaunch,
} from "../codex-application/CodexSessionThreadLaunch";
import {
  CodexAppProtocolTools,
  make as makeCodexAppProtocolTools,
} from "../codex-application/CodexAppProtocolTools";
import { live as codexAutomationInboxLive } from "../codex-application/CodexAutomationInbox";
import { live as codexOneShotServerRequestsLive } from "../codex-application/CodexOneShotServerRequests";
import { live as codexProtocolNotificationProjectionLive } from "../codex-application/CodexProtocolNotificationProjection";
import { live as codexAutomationTurnCompletionLive } from "../codex-application/CodexAutomationTurnCompletion";
import {
  CodexConversationLifecycle,
  make as makeCodexConversationLifecycle,
} from "../codex-application/CodexConversationLifecycle";
import { live as codexThreadDurableProjectionLive } from "../codex-application/CodexThreadDurableProjection";
import { live as codexProtocolNotificationEffectsLive } from "../codex-application/CodexProtocolNotificationEffects";
import { live as nodexAgentProtocolToolsLive } from "../nodex-agent-application/NodexAgentProtocolTools";
import { live as codexApplicationProtocolLive } from "../codex-application/CodexApplicationProtocol";
import { live as codexProtocolIngressLive } from "../codex-application/CodexProtocolIngress";
import {
  CodexConnectionLifecycle,
  make as makeCodexConnectionLifecycle,
} from "../codex-application/CodexConnectionLifecycle";
import {
  CodexConversationResumeRuntime,
  make as makeCodexConversationResumeRuntime,
} from "../codex-application/CodexConversationResumeRuntime";
import {
  CodexThreadSettingsRuntime,
  make as makeCodexThreadSettingsRuntime,
} from "../codex-application/CodexThreadSettingsRuntime";
import {
  ThreadCreationRuntime,
  make as makeThreadCreationRuntime,
} from "../codex-application/ThreadCreationRuntime";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
import {
  CodexGateway,
  CodexThreadHostResolver,
  codexGatewayGenerationFence,
} from "../codex-runtime/CodexGateway";
import { makePersistedAtomStore } from "../local-store/persisted-atoms";
import { resolveCodexThreadHandoffJournalPath } from "../codex/codex-thread-handoff-journal";
import { makeCodexThreadHandoffJournalStorage } from "../platform/CodexThreadHandoffJournalStorage";
import { CodexPlatform } from "./CodexApplicationLive";
import { live as appToolAuthorityLive } from "../app-tools/NodexAppToolAuthority";
import { MainConfig } from "./MainConfig";
import { CODEX_INTEGRATION_CAPABILITIES } from "../../shared/codex-integration-capabilities";

const conversationContext = Layer.effect(CodexConversationContext, makeCodexConversationContext);
const conversationProjection = Layer.effect(
  CodexConversationProjection,
  makeCodexConversationProjection,
);
const internalThreadRegistry = Layer.effect(
  CodexInternalThreadRegistry,
  makeCodexInternalThreadRegistry,
);
const threadStartNotifications = Layer.effect(ThreadCreationRuntime, makeThreadCreationRuntime);

const historyPageAdapter = Layer.effect(CodexHistoryPageAdapter, makeCodexHistoryPageAdapter);
const historySearchAdapter = Layer.effect(
  CodexHistorySearchAdapter,
  makeCodexHistorySearchAdapter(),
);
const gitProbe = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const executionHosts = yield* ExecutionHostRuntime;
    return Layer.succeed(
      CodexGitProbe,
      makeCodexGitProbe({
        environment: config.environment,
        remoteIsNonGitWorkspace: (hostId, cwd) =>
          executionHosts.resolve(hostId, "git-root").pipe(
            Effect.flatMap((host) =>
              host.request({
                operation: "git-root",
                input: { requestId: randomUUID(), hostId, cwd },
              }),
            ),
            Effect.map((result) => result.root === null),
            Effect.orElseSucceed(() => false),
          ),
      }),
    );
  }),
);
const threadDirectory = Layer.effect(CodexThreadDirectory, makeCodexThreadDirectory).pipe(
  Layer.provideMerge(Layer.mergeAll(conversationProjection, historyPageAdapter, gitProbe)),
);
const mainConversationHistory = Layer.effect(
  CodexMainConversationHistory,
  makeMainConversationHistory,
);
const mainConversationResume = Layer.effect(
  CodexMainConversationResume,
  makeMainConversationResume,
).pipe(
  Layer.provideMerge(Layer.mergeAll(threadDirectory, resumeIngressLayer, mainConversationHistory)),
);
const nativeThreadLookup = Layer.effect(CodexNativeThreadLookup, makeNativeThreadLookup);
const readThreadHistory = Layer.effect(CodexReadThreadHistory, makeCodexReadThreadHistory).pipe(
  Layer.provideMerge(Layer.merge(threadDirectory, nativeThreadLookup)),
);
const conversationRelationships = Layer.effect(
  CodexConversationRelationships,
  makeCodexConversationRelationships,
).pipe(Layer.provideMerge(threadDirectory));

const sidebarSync = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    return Layer.effect(
      CodexSidebarSyncRuntime,
      makeCodexSidebarSyncRuntime({ foldPathCase: config.platform === "win32" }),
    );
  }),
).pipe(Layer.provideMerge(Layer.mergeAll(threadDirectory, internalThreadRegistry)));

const externalAgentImport = Layer.effect(
  CodexExternalAgentImportRuntime,
  makeCodexExternalAgentImportRuntime(),
);
const heartbeatTurnCompletion = Layer.unwrap(
  Effect.gen(function* () {
    const gateway = yield* CodexGateway;
    const hostResolver = yield* CodexThreadHostResolver;
    return Layer.effect(
      CodexHeartbeatTurnCompletion,
      makeCodexHeartbeatTurnCompletion({
        events: gateway.events,
        resolveHost: (threadId) =>
          hostResolver.resolve(threadId).pipe(
            Effect.mapError(
              (cause) =>
                new CodexHeartbeatTurnCompletionError({
                  reason: "request-failed",
                  message: `Could not resolve the execution host for heartbeat thread ${threadId}`,
                  cause,
                  threadId,
                }),
            ),
          ),
        request: (hostId, params, fence) =>
          gateway.requestOnHost(hostId, "turn/start", params, fence).pipe(
            Effect.mapError(
              (cause) =>
                new CodexHeartbeatTurnCompletionError({
                  reason: "request-failed",
                  message: `Could not start the heartbeat turn on host ${hostId}`,
                  cause,
                  threadId: params.threadId,
                }),
            ),
          ),
      }),
    );
  }),
);

const structuredThreadTitle = Layer.unwrap(
  Effect.gen(function* () {
    const gateway = yield* CodexGateway;
    const capabilities = yield* CodexAppServerCapabilities;
    const requestError = (message: string, cause: unknown, threadId?: string, turnId?: string) =>
      new CodexStructuredThreadTitleError({
        reason: "request-failed",
        message,
        cause,
        ...(threadId === undefined ? {} : { threadId }),
        ...(turnId === undefined ? {} : { turnId }),
      });
    const fence = (hostId: string, generation: number) =>
      codexGatewayGenerationFence({ hostId, generation });
    return Layer.effect(
      CodexStructuredThreadTitle,
      makeCodexStructuredThreadTitle({
        generation: (hostId) =>
          capabilities.forHost(hostId).pipe(
            Effect.map((capability) => capability.generation),
            Effect.mapError((cause) =>
              requestError("Structured thread title generation capture failed", cause),
            ),
          ),
        events: gateway.events,
        startThread: (hostId, params, generation) =>
          gateway
            .requestOnHost(hostId, "thread/start", params, fence(hostId, generation))
            .pipe(
              Effect.mapError((cause) =>
                requestError("Structured thread title thread/start failed", cause),
              ),
            ),
        forkThread: (hostId, params, generation) =>
          gateway
            .requestOnHost(hostId, "thread/fork", params, fence(hostId, generation))
            .pipe(
              Effect.mapError((cause) =>
                requestError("Structured thread title thread/fork failed", cause, params.threadId),
              ),
            ),
        startTurn: (hostId, params, generation) =>
          gateway
            .requestOnHost(hostId, "turn/start", params, fence(hostId, generation))
            .pipe(
              Effect.mapError((cause) =>
                requestError("Structured thread title turn/start failed", cause, params.threadId),
              ),
            ),
        interruptTurn: (hostId, threadId, turnId, generation) =>
          gateway
            .requestOnHost(
              hostId,
              "turn/interrupt",
              { threadId, turnId },
              fence(hostId, generation),
            )
            .pipe(
              Effect.mapError((cause) =>
                requestError(
                  "Structured thread title turn/interrupt failed",
                  cause,
                  threadId,
                  turnId,
                ),
              ),
            ),
        unsubscribeThread: (hostId, threadId, generation) =>
          gateway
            .requestOnHost(hostId, "thread/unsubscribe", { threadId }, fence(hostId, generation))
            .pipe(
              Effect.mapError((cause) =>
                requestError("Structured thread title thread/unsubscribe failed", cause, threadId),
              ),
            ),
      }),
    );
  }),
).pipe(Layer.provideMerge(Layer.merge(internalThreadRegistry, threadStartNotifications)));

const threadSettings = Layer.effect(
  CodexThreadSettingsRuntime,
  makeCodexThreadSettingsRuntime,
).pipe(Layer.provideMerge(Layer.merge(conversationProjection, sidebarSync)));
const threadGoals = codexThreadGoalRuntimeLive.pipe(
  Layer.provideMerge(Layer.merge(conversationProjection, threadSettings)),
);

const foundations = Layer.mergeAll(
  conversationContext,
  conversationRelationships,
  externalAgentImport,
  heartbeatTurnCompletion,
  historySearchAdapter,
  sidebarSync,
  structuredThreadTitle,
  threadGoals,
  threadStartNotifications,
);

const titlePersistence = Layer.effect(
  CodexThreadTitlePersistence,
  makeCodexThreadTitlePersistence,
).pipe(Layer.provideMerge(foundations));
const threadDescriptions = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    return Layer.succeed(
      CodexThreadDescriptionPersistence,
      makeCodexThreadDescriptionPersistence(makePersistedAtomStore(config.nodexHome)),
    );
  }),
);
const threadTitleAppTools = Layer.effect(CodexThreadTitleAppTools, makeCodexThreadTitleAppTools);
const autoThreadTitle = Layer.effect(CodexAutoThreadTitle, makeCodexAutoThreadTitle).pipe(
  Layer.provideMerge(Layer.mergeAll(titlePersistence, threadDescriptions, threadTitleAppTools)),
);
const threadHistoryFeatures = Layer.effect(
  CodexThreadHistoryFeatures,
  makeCodexThreadHistoryFeatures,
).pipe(Layer.provideMerge(titlePersistence));
const historyExport = Layer.effect(
  CodexConversationHistoryExport,
  makeCodexConversationHistoryExport,
).pipe(Layer.provideMerge(threadHistoryFeatures));
const persistedHistorySearch = Layer.effect(
  CodexPersistedHistorySearchRuntime,
  makeCodexPersistedHistorySearchRuntime,
).pipe(Layer.provideMerge(historyExport));
const subagents = Layer.effect(CodexSubagentDirectory, makeCodexSubagentDirectory).pipe(
  Layer.provideMerge(persistedHistorySearch),
);
const materialization = Layer.effect(
  CodexConversationMaterialization,
  makeCodexConversationMaterialization,
).pipe(Layer.provideMerge(subagents));
const automationAcceptance = Layer.effect(
  CodexAutomationRunAcceptance,
  makeCodexAutomationRunAcceptance,
).pipe(Layer.provideMerge(materialization));
const turnAuthority = Layer.effect(CodexTurnAuthority, makeCodexTurnAuthority).pipe(
  Layer.provideMerge(automationAcceptance),
);
const notificationAdmission = Layer.effect(
  CodexNotificationAdmission,
  makeCodexNotificationAdmission,
).pipe(Layer.provideMerge(turnAuthority));
const agentConfig = Layer.effect(CodexAgentConfigRuntime, makeCodexAgentConfigRuntime).pipe(
  Layer.provideMerge(notificationAdmission),
);
const inputAssets = codexInputAssetsLive;
const turnPreparation = Layer.effect(CodexTurnPreparation, makeCodexTurnPreparation).pipe(
  Layer.provideMerge(Layer.mergeAll(agentConfig, inputAssets)),
);
const mainConversationSettings = Layer.effect(
  CodexMainConversationSettings,
  makeMainConversationSettings,
).pipe(Layer.provideMerge(mainConversationResume));
const deltaBuffer = Layer.effect(
  CodexConversationDeltaBufferRuntime,
  makeCodexConversationDeltaBufferRuntime(),
).pipe(Layer.provideMerge(mainConversationSettings));
const manualCompaction = codexManualCompactionLive.pipe(
  Layer.provideMerge(mainConversationSettings),
);
const conversationLifecycle = Layer.effect(
  CodexConversationLifecycle,
  makeCodexConversationLifecycle,
).pipe(Layer.provideMerge(Layer.merge(deltaBuffer, manualCompaction)));
const turnCommands = Layer.effect(CodexTurnCommands, makeCodexTurnCommands).pipe(
  Layer.provideMerge(Layer.mergeAll(turnPreparation, autoThreadTitle, mainConversationSettings)),
);
const queuedFollowUps = Layer.effect(CodexQueuedFollowUps, makeCodexQueuedFollowUps).pipe(
  Layer.provideMerge(turnCommands),
);
const launchCompletion = Layer.effect(
  CodexThreadLaunchCompletion,
  makeCodexThreadLaunchCompletion,
).pipe(Layer.provideMerge(queuedFollowUps));
const freshThreadLaunch = Layer.effect(
  CodexFreshThreadLaunchRuntime,
  makeCodexFreshThreadLaunchRuntime,
).pipe(Layer.provideMerge(launchCompletion));
const conversationArchive = Layer.effect(
  CodexConversationArchive,
  makeCodexConversationArchive,
).pipe(
  Layer.provide(inactiveThreadArchiveLive),
  Layer.provideMerge(Layer.merge(freshThreadLaunch, conversationLifecycle)),
);
const commands = conversationCommandsLive.pipe(Layer.provideMerge(conversationArchive));
const threadExecution = codexThreadExecutionLive.pipe(Layer.provideMerge(commands));

const threadCatalog = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    return Layer.effect(
      CodexThreadCatalog,
      makeCodexThreadCatalog({ foldPathCase: config.platform === "win32" }),
    );
  }),
).pipe(Layer.provideMerge(threadExecution));
const sidebarSectionSync = Layer.effect(CodexSidebarSectionSync, makeCodexSidebarSectionSync).pipe(
  Layer.provideMerge(threadCatalog),
);
const clientThreadIdentity = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    return Layer.effect(
      CodexClientThreadIdentity,
      makeCodexClientThreadIdentity(makePersistedAtomStore(config.nodexHome)),
    );
  }),
).pipe(Layer.provideMerge(sidebarSectionSync));
const forkSidePanelTransfer = Layer.effect(
  CodexForkSidePanelTransfer,
  makeCodexForkSidePanelTransfer,
).pipe(Layer.provideMerge(clientThreadIdentity));
const forkTitlePolicy = Layer.effect(CodexForkTitlePolicy, makeCodexForkTitlePolicy).pipe(
  Layer.provideMerge(forkSidePanelTransfer),
);
const conversationFork = Layer.effect(CodexConversationFork, makeCodexConversationFork).pipe(
  Layer.provideMerge(Layer.merge(forkTitlePolicy, mainConversationResume)),
);
const conversationCreation = Layer.effect(
  CodexConversationCreation,
  makeCodexConversationCreation,
).pipe(Layer.provideMerge(Layer.merge(conversationFork, autoThreadTitle)));
const pendingWorktrees = Layer.effect(
  CodexPendingWorktreeRuntime,
  makeCodexPendingWorktreeRuntime,
).pipe(Layer.provideMerge(conversationCreation));
const managedWorktreeRetention = managedWorktreeRetentionLive({}).pipe(
  Layer.provideMerge(pendingWorktrees),
);
const crossHostThreadHandoff = Layer.unwrap(
  Effect.gen(function* () {
    const platform = yield* CodexPlatform;
    return crossHostThreadHandoffLive({ relayBaseRoot: `${platform.runtimeStateHome}/handoffs` });
  }),
).pipe(Layer.provideMerge(managedWorktreeRetention));
const managedWorktreeHandoff = managedWorktreeHandoffLive.pipe(
  Layer.provideMerge(crossHostThreadHandoff),
);
const threadHandoff = Layer.unwrap(
  Effect.gen(function* () {
    const platform = yield* CodexPlatform;
    return Layer.effect(
      CodexThreadHandoffRuntime,
      makeCodexThreadHandoffRuntime({
        storage: makeCodexThreadHandoffJournalStorage(
          resolveCodexThreadHandoffJournalPath(platform.runtimeStateHome),
        ),
      }),
    );
  }),
).pipe(Layer.provideMerge(managedWorktreeHandoff));
const agentImport = Layer.unwrap(
  Effect.gen(function* () {
    const platform = yield* CodexPlatform;
    return Layer.effect(
      AgentImportRuntime,
      makeAgentImportRuntime({ runtimeStateHome: platform.runtimeStateHome }),
    );
  }),
).pipe(Layer.provideMerge(threadHandoff));
const projectSessionFork = Layer.effect(CodexProjectSessionFork, makeCodexProjectSessionFork).pipe(
  Layer.provideMerge(Layer.merge(agentImport, manualCompaction)),
);
const nodeReplRuntime = Layer.effect(CodexNodeReplRuntime, makeNodeReplRuntime).pipe(
  Layer.provideMerge(Layer.merge(projectSessionFork, mainConversationHistory)),
);
const mainConversationInterrupt = Layer.effect(
  CodexMainConversationInterrupt,
  makeMainConversationInterrupt,
).pipe(Layer.provideMerge(nodeReplRuntime));
const mainConversationEdit = Layer.effect(CodexMainConversationEdit, makeMainConversationEdit).pipe(
  Layer.provideMerge(mainConversationInterrupt),
);
const mainConversationActions = Layer.merge(
  Layer.effectDiscard(installMainConversationActions),
  Layer.effectDiscard(installBrowserSessionActivity),
).pipe(Layer.provideMerge(mainConversationEdit));
const sideChatCommands = Layer.effect(CodexSideChatCommands, makeCodexSideChatCommands).pipe(
  Layer.provideMerge(mainConversationActions),
);
const sessionThreadLaunch = Layer.effect(
  CodexSessionThreadLaunch,
  makeCodexSessionThreadLaunch,
).pipe(Layer.provideMerge(Layer.merge(sideChatCommands, autoThreadTitle)));
const rendererSessionLaunch = Layer.effect(
  CodexRendererSessionLaunch,
  makeRendererSessionLaunch,
).pipe(Layer.provideMerge(sessionThreadLaunch));
const waitThreads = Layer.effect(CodexWaitThreads, makeWaitThreads).pipe(
  Layer.provideMerge(Layer.mergeAll(rendererSessionLaunch, threadDescriptions, nativeThreadLookup)),
);
const delegatedMessages = Layer.effect(CodexDelegatedMessages, makeDelegatedMessages).pipe(
  Layer.provideMerge(Layer.merge(waitThreads, mainConversationResume)),
);
const protocolTools = Layer.effect(CodexAppProtocolTools, makeCodexAppProtocolTools).pipe(
  Layer.provideMerge(Layer.merge(delegatedMessages, readThreadHistory)),
);
const automationInbox = codexAutomationInboxLive.pipe(Layer.provideMerge(protocolTools));
const oneShotServerRequests = codexOneShotServerRequestsLive.pipe(
  Layer.provideMerge(automationInbox),
);
const protocolProjection = codexProtocolNotificationProjectionLive({
  supportsChatGptApps: CODEX_INTEGRATION_CAPABILITIES.chatGptApps,
}).pipe(Layer.provideMerge(oneShotServerRequests));
const automationTurnCompletion = codexAutomationTurnCompletionLive.pipe(
  Layer.provideMerge(protocolProjection),
);
const durableProjection = codexThreadDurableProjectionLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(conversationLifecycle, automationTurnCompletion, autoThreadTitle),
  ),
);
const threadTitleReconsideration = Layer.effect(
  CodexThreadTitleReconsideration,
  makeCodexThreadTitleReconsideration,
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      structuredThreadTitle,
      titlePersistence,
      threadDescriptions,
      conversationProjection,
    ),
  ),
);
const notificationEffects = codexProtocolNotificationEffectsLive.pipe(
  Layer.provideMerge(Layer.merge(durableProjection, threadTitleReconsideration)),
);
const appToolAuthority = appToolAuthorityLive.pipe(Layer.provideMerge(notificationEffects));
const nodexAgentProtocolTools = nodexAgentProtocolToolsLive.pipe(
  Layer.provideMerge(appToolAuthority),
);
const applicationProtocol = codexApplicationProtocolLive.pipe(
  Layer.provideMerge(nodexAgentProtocolTools),
);
const protocolIngress = codexProtocolIngressLive.pipe(Layer.provideMerge(applicationProtocol));
const connectionLifecycle = Layer.effect(
  CodexConnectionLifecycle,
  makeCodexConnectionLifecycle,
).pipe(Layer.provideMerge(protocolIngress));
const conversationResume = Layer.effect(
  CodexConversationResumeRuntime,
  makeCodexConversationResumeRuntime,
).pipe(Layer.provideMerge(connectionLifecycle));

/** Canonical Conversation projections and semantic command capabilities. */
export const live = conversationResume;
