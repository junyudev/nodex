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
  CodexConversationHistoryRuntime,
  make as makeCodexConversationHistoryRuntime,
} from "../codex-application/CodexConversationHistoryRuntime";
import {
  CodexPromptRailHistory,
  make as makeCodexPromptRailHistory,
} from "../codex-application/CodexPromptRailHistory";
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
  CodexTurnPreparation,
  make as makeCodexTurnPreparation,
} from "../codex-application/CodexTurnPreparation";
import {
  CodexQueuedFollowUps,
  make as makeCodexQueuedFollowUps,
} from "../codex-application/CodexQueuedFollowUps";
import { codexQueuedFollowUpPayloadStoreLive } from "../codex-application/CodexQueuedFollowUpPayloadStore";
import {
  CodexTurnCommands,
  make as makeCodexTurnCommands,
} from "../codex-application/CodexTurnCommands";
import {
  CodexActiveGoalContinuation,
  make as makeCodexActiveGoalContinuation,
} from "../codex-application/CodexActiveGoalContinuation";
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
import {
  CodexPostResumeGoalRuntime,
  make as makeCodexPostResumeGoalRuntime,
} from "../codex-application/CodexPostResumeGoalRuntime";
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
  CodexThreadRollbackCommands,
  make as makeCodexThreadRollbackCommands,
} from "../codex-application/CodexThreadRollbackCommands";
import {
  CodexProjectSessionFork,
  make as makeCodexProjectSessionFork,
} from "../codex-application/CodexProjectSessionFork";
import {
  CodexRendererOwnerCommands,
  make as makeCodexRendererOwnerCommands,
} from "../codex-application/CodexRendererOwnerCommands";
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
const threadDirectory = Layer.effect(CodexThreadDirectory, makeCodexThreadDirectory).pipe(
  Layer.provideMerge(Layer.merge(conversationProjection, historyPageAdapter)),
);
const readThreadHistory = Layer.effect(CodexReadThreadHistory, makeCodexReadThreadHistory).pipe(
  Layer.provideMerge(threadDirectory),
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

const gitProbe = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    return Layer.succeed(CodexGitProbe, makeCodexGitProbe({ environment: config.environment }));
  }),
);
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
        request: (hostId, params) =>
          gateway.requestOnHost(hostId, "turn/start", params).pipe(
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
    const fence = (generation: number) =>
      codexGatewayGenerationFence({ hostId: gateway.localHostId, generation });
    return Layer.effect(
      CodexStructuredThreadTitle,
      makeCodexStructuredThreadTitle({
        hostId: gateway.localHostId,
        generation: capabilities.forHost(gateway.localHostId).pipe(
          Effect.map((capability) => capability.generation),
          Effect.mapError((cause) =>
            requestError("Structured thread title generation capture failed", cause),
          ),
        ),
        events: gateway.events,
        startThread: (params, generation) =>
          gateway
            .requestLocal("thread/start", params, fence(generation))
            .pipe(
              Effect.mapError((cause) =>
                requestError("Structured thread title thread/start failed", cause),
              ),
            ),
        startTurn: (params, generation) =>
          gateway
            .requestLocal("turn/start", params, fence(generation))
            .pipe(
              Effect.mapError((cause) =>
                requestError("Structured thread title turn/start failed", cause, params.threadId),
              ),
            ),
        interruptTurn: (threadId, turnId, generation) =>
          gateway
            .requestLocal("turn/interrupt", { threadId, turnId }, fence(generation))
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
        unsubscribeThread: (threadId, generation) =>
          gateway
            .requestLocal("thread/unsubscribe", { threadId }, fence(generation))
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
  gitProbe,
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
const history = Layer.effect(
  CodexConversationHistoryRuntime,
  makeCodexConversationHistoryRuntime,
).pipe(Layer.provideMerge(titlePersistence));
const threadHistoryFeatures = Layer.effect(
  CodexThreadHistoryFeatures,
  makeCodexThreadHistoryFeatures,
).pipe(Layer.provideMerge(history));
const promptRailHistory = Layer.effect(CodexPromptRailHistory, makeCodexPromptRailHistory()).pipe(
  Layer.provideMerge(threadHistoryFeatures),
);
const historyExport = Layer.effect(
  CodexConversationHistoryExport,
  makeCodexConversationHistoryExport,
).pipe(Layer.provideMerge(promptRailHistory));
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
const turnPreparation = Layer.effect(CodexTurnPreparation, makeCodexTurnPreparation).pipe(
  Layer.provideMerge(notificationAdmission),
);
const turnCommands = Layer.effect(CodexTurnCommands, makeCodexTurnCommands).pipe(
  Layer.provideMerge(turnPreparation),
);
const queuedFollowUps = Layer.effect(CodexQueuedFollowUps, makeCodexQueuedFollowUps).pipe(
  Layer.provideMerge(Layer.mergeAll(turnCommands, codexQueuedFollowUpPayloadStoreLive)),
);
const activeGoalContinuation = Layer.effect(
  CodexActiveGoalContinuation,
  makeCodexActiveGoalContinuation,
).pipe(Layer.provideMerge(queuedFollowUps));
const launchCompletion = Layer.effect(
  CodexThreadLaunchCompletion,
  makeCodexThreadLaunchCompletion,
).pipe(Layer.provideMerge(activeGoalContinuation));
const freshThreadLaunch = Layer.effect(
  CodexFreshThreadLaunchRuntime,
  makeCodexFreshThreadLaunchRuntime,
).pipe(Layer.provideMerge(launchCompletion));
const conversationArchive = Layer.effect(
  CodexConversationArchive,
  makeCodexConversationArchive,
).pipe(Layer.provideMerge(freshThreadLaunch));
const commands = conversationCommandsLive.pipe(Layer.provideMerge(conversationArchive));
const deltaBuffer = Layer.effect(
  CodexConversationDeltaBufferRuntime,
  makeCodexConversationDeltaBufferRuntime(),
).pipe(Layer.provideMerge(commands));
const postResumeGoals = Layer.effect(
  CodexPostResumeGoalRuntime,
  makeCodexPostResumeGoalRuntime,
).pipe(Layer.provideMerge(deltaBuffer));
const threadExecution = codexThreadExecutionLive.pipe(Layer.provideMerge(postResumeGoals));

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
  Layer.provideMerge(forkTitlePolicy),
);
const conversationCreation = Layer.effect(
  CodexConversationCreation,
  makeCodexConversationCreation,
).pipe(Layer.provideMerge(conversationFork));
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
const manualCompaction = codexManualCompactionLive.pipe(Layer.provideMerge(agentImport));
const threadRollback = Layer.effect(
  CodexThreadRollbackCommands,
  makeCodexThreadRollbackCommands,
).pipe(Layer.provideMerge(manualCompaction));
const projectSessionFork = Layer.effect(CodexProjectSessionFork, makeCodexProjectSessionFork).pipe(
  Layer.provideMerge(threadRollback),
);
const rendererOwnerCommands = Layer.effect(
  CodexRendererOwnerCommands,
  makeCodexRendererOwnerCommands,
).pipe(Layer.provideMerge(projectSessionFork));
const sideChatCommands = Layer.effect(CodexSideChatCommands, makeCodexSideChatCommands).pipe(
  Layer.provideMerge(rendererOwnerCommands),
);
const sessionThreadLaunch = Layer.effect(
  CodexSessionThreadLaunch,
  makeCodexSessionThreadLaunch,
).pipe(Layer.provideMerge(sideChatCommands));
const protocolTools = Layer.effect(CodexAppProtocolTools, makeCodexAppProtocolTools).pipe(
  Layer.provideMerge(Layer.merge(sessionThreadLaunch, readThreadHistory)),
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
const conversationLifecycle = Layer.effect(
  CodexConversationLifecycle,
  makeCodexConversationLifecycle,
).pipe(Layer.provideMerge(automationTurnCompletion));
const durableProjection = codexThreadDurableProjectionLive.pipe(
  Layer.provideMerge(conversationLifecycle),
);
const notificationEffects = codexProtocolNotificationEffectsLive.pipe(
  Layer.provideMerge(durableProjection),
);
const nodexAgentProtocolTools = nodexAgentProtocolToolsLive.pipe(
  Layer.provideMerge(notificationEffects),
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
