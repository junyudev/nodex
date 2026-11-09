import { ApplicationSettings } from "../settings/ApplicationSettings";
import { CodexThreadReadState } from "../codex-application/CodexThreadReadState";
import { CodexMainConversationInterrupt } from "../codex-application/CodexMainConversationInterrupt";
import { CodexQueuedFollowUps } from "../codex-application/CodexQueuedFollowUps";
import { CodexNativeThreadLookup } from "../codex-application/CodexNativeThreadLookup";
import { TemporaryAssets } from "../local-store/TemporaryAssets";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexThreadDirectory } from "../codex-application/CodexThreadDirectory";
import { CodexMainConversationResume } from "../codex-application/CodexMainConversationResume";
import { CodexAttachments } from "../codex-application/CodexAttachments";
import { ExecutionHostRuntime } from "../codex-application/ExecutionHostRuntime";
import { CodexDelegatedMessages } from "../codex-application/CodexDelegatedMessages";
import { FileExportRuntime } from "../library-application/FileExportRuntime";
import { PluginNativeOperations } from "../codex-application/PluginNativeOperations";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { CodexThreadHandoffRuntime } from "../codex-application/CodexThreadHandoffRuntime";
import { ProjectSessionCommands } from "../project-application/ProjectSessionCommands";
import * as FileSystem from "effect/FileSystem";
import { CoreSessionAccess } from "../core-runtime/CoreAuthority";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import * as Effect from "effect/Effect";
import { GitWorkerRuntime } from "../host-runtime/GitWorkerRuntime";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { NodexAgentApplication } from "../nodex-agent-application/NodexAgentApplication";
import { TerminalSessions } from "../terminal-runtime/TerminalSessions";
import { CodexAccount } from "../codex-application/CodexAccount";
import { WorkspaceDependencyRuntime } from "../host-runtime/WorkspaceDependencyRuntime";
import { ComposerCatalog } from "../codex-application/ComposerCatalog";
import { NodexAppToolAuthority } from "./NodexAppToolAuthority";
import { WorkbenchAgentBridge } from "./WorkbenchAgentBridge";
import { WorkbenchObservation } from "./WorkbenchObservation";
import { WorkbenchContentRouting } from "./WorkbenchContentRouting";
import { nativeQuestionTestLayers } from "./native-question-test-layers";

import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { AgentRuntimeSupervisor } from "../agent-runtime/AgentRuntimeSupervisor";
/** Constructs real Host executors; unused infrastructure fails if a test crosses its boundary. */
export const hostToolTestServices = Layer.mergeAll(
  nativeQuestionTestLayers,
  FileSystem.layerNoop({}),
  Layer.mock(CodexThreadReadState, {}),
  Layer.mock(CodexMainConversationInterrupt, {}),
  Layer.mock(CodexQueuedFollowUps, {} as never),
  Layer.mock(NodexAgentApplication, {}),
  Layer.mock(TerminalSessions, {}),
  Layer.mock(CodexAccount, {} as never),
  Layer.mock(WorkspaceDependencyRuntime, { read: Effect.succeed({ available: false } as never) }),
  Layer.mock(ComposerCatalog, {}),
  Layer.mock(PluginNativeOperations, {}),
  Layer.mock(CodexThreadDirectory, {}),
  Layer.mock(CodexMainConversationResume, {}),
  Layer.mock(CodexAttachments, {}),
  Layer.mock(ExecutionHostRuntime, {} as never),
  Layer.mock(CodexDelegatedMessages, {}),
  Layer.mock(FileExportRuntime, {}),
  Layer.mock(CodexGateway, {} as never),
  Layer.mock(CodexNativeThreadLookup, {}),
  Layer.mock(TemporaryAssets, {} as never),
  Layer.mock(WorkApplication, {}),
  Layer.mock(CodexTurnPresentation, {} as never),
  Layer.mock(NodexAppToolAuthority, {}),
  Layer.mock(WorkbenchAgentBridge, {} as never),
  Layer.mock(WorkbenchObservation, {}),
  Layer.mock(WorkbenchContentRouting, {}),
  Layer.mock(CoreAuthority, {} as never),
  Layer.mock(CodexThreadHandoffRuntime, {}),
  Layer.mock(ProjectSessionCommands, {}),
  Layer.mock(AgentRuntimeApplication, {} as never),
  Layer.mock(InboxApplication, {}),
  Layer.mock(NodexEntryNotifications, {}),
  Layer.mock(ApplicationSettings, {}),
  Layer.mock(CoreModules, {} as never),
  Layer.mock(AutomationApplication, {} as never),
  Layer.mock(CodexTurnAuthority, {} as never),
  Layer.mock(GitHubSourceAdapter, {}),
  Layer.mock(CoreSessionAccess, {}),
  Layer.mock(CoordinatorSession, { isCoordinator: () => Effect.succeed(true) }),
  Layer.mock(ProjectWorkspace, {
    listProjects: Effect.succeed([]),
    listSidebarSections: () =>
      Effect.succeed({ items: [], nextCursor: null, hasMore: false, projectionRevision: 1 }),
    listSidebarSectionItems: () =>
      Effect.succeed({ items: [], nextCursor: null, hasMore: false, projectionRevision: 1 }),
  }),
  Layer.mock(GitWorkerRuntime, {}),
  Layer.mock(DatabaseNotifierRuntime, { projectSessionInvalidations: Stream.empty }),
  Layer.mock(CodexApplicationEventHub, { events: Stream.empty, publish: () => {} }),
  Layer.mock(AgentRuntimeSupervisor, {}),
);
