import * as PluginManagerIpc from "../ipc/handlers/PluginManagerIpc";
import * as McpAppDataIpc from "../ipc/handlers/McpAppDataIpc";
import * as AcpAgentsIpc from "../ipc/handlers/AcpAgentsIpc";
import * as AcpAgents from "../acp-agents/AcpAgents";
import * as CodexFilesystemAssetRuntime from "../host-runtime/CodexFilesystemAssetRuntime";
import * as FileSearchIpc from "../ipc/handlers/FileSearchIpc";
import * as WorkspaceTextSearchIpc from "../ipc/handlers/WorkspaceTextSearchIpc";
import * as WorkspaceTextSearch from "../codex-application/WorkspaceTextSearch";
import * as WorkspaceTextSearchPlatform from "../platform/node/WorkspaceTextSearchPlatform";
import * as CodexThreadHandoffIpc from "../ipc/handlers/CodexThreadHandoffIpc";
import * as Layer from "effect/Layer";
import * as WorkbenchAgentIpc from "../ipc/handlers/WorkbenchAgentIpc";
import * as AppUpdateIpc from "../ipc/handlers/AppUpdateIpc";
import * as OpenCodeSetupIpc from "../ipc/handlers/OpenCodeSetupIpc";
import * as NodexAccountIpc from "../ipc/handlers/NodexAccountIpc";
import * as NodexAccountLive from "./NodexAccountLive";
import * as OpenCodeSetup from "../host-runtime/OpenCodeSetup";
import * as OpenCodeInstallPlatform from "../platform/node/OpenCodeInstallPlatform";
import * as ApplicationLifecycleIpc from "../ipc/handlers/ApplicationLifecycleIpc";
import * as ApplicationSyncIpc from "../ipc/handlers/ApplicationSyncIpc";
import * as ApplicationWindowIpc from "../ipc/handlers/ApplicationWindowIpc";
import * as BrowserProfileIpc from "../ipc/handlers/BrowserProfileIpc";
import * as BrowserSidebarIpc from "../ipc/handlers/BrowserSidebarIpc";
import * as ComposerAppshotIpc from "../ipc/handlers/ComposerAppshotIpc";
import * as CodexApplicationIpc from "../ipc/handlers/CodexApplicationIpc";
import * as CodexRendererIpc from "../ipc/handlers/CodexRendererIpc";
import * as CodexVisualizationIpc from "../ipc/handlers/CodexVisualizationIpc";
import * as CodexVisualizationStateIpc from "../ipc/handlers/CodexVisualizationStateIpc";
import * as CodexConversationServiceIpc from "../ipc/handlers/CodexConversationServiceIpc";
import * as ChromeControlSettingsIpc from "../ipc/handlers/ChromeControlSettingsIpc";
import * as ComputerUseSettingsIpc from "../ipc/handlers/ComputerUseSettingsIpc";
import * as CoreAuthorityIpc from "../ipc/handlers/CoreAuthorityIpc";
import * as ApplicationLocalStateIpc from "../ipc/handlers/ApplicationLocalStateIpc";
import * as ApplicationSettingsIpc from "../ipc/handlers/ApplicationSettingsIpc";
import * as AgentBackendIpc from "../ipc/handlers/AgentBackendIpc";
import * as AgentRuntimeIpc from "../ipc/handlers/AgentRuntimeIpc";
import * as ClaudeUsageIpc from "../ipc/handlers/ClaudeUsageIpc";
import * as NativeSessionCatalogIpc from "../ipc/handlers/NativeSessionCatalogIpc";
import * as NativeSessionCatalog from "../agent-backend/NativeSessionCatalog";
import * as AutomationIpc from "../ipc/handlers/AutomationIpc";
import * as AvatarOverlayIpc from "../ipc/handlers/AvatarOverlayIpc";
import * as CodexPendingWorktreeIpc from "../ipc/handlers/CodexPendingWorktreeIpc";
import * as CodexWorkspaceIpc from "../ipc/handlers/CodexWorkspaceIpc";
import * as CoreDocumentIpc from "../ipc/handlers/CoreDocumentIpc";
import * as DocumentRecoveryIpc from "../ipc/handlers/DocumentRecoveryIpc";
import * as CoreMutationIpc from "../ipc/handlers/CoreMutationIpc";
import * as DatabaseProjectionIpc from "../ipc/handlers/DatabaseProjectionIpc";
import * as CodexRealtimeVoiceIpc from "../ipc/handlers/CodexRealtimeVoiceIpc";
import * as DictationIpc from "../ipc/handlers/DictationIpc";
import * as DictationStreamingIpc from "../ipc/handlers/DictationStreamingIpc";
import * as ExecutionHostIpc from "../ipc/handlers/ExecutionHostIpc";
import * as GitApplicationIpc from "../ipc/handlers/GitApplicationIpc";
import * as GitWorkerIpc from "../ipc/handlers/GitWorkerIpc";
import * as RemoteHostedPipIpc from "../ipc/handlers/RemoteHostedPipIpc";
import * as ManagedMediaIpc from "../ipc/handlers/ManagedMediaIpc";
import * as StructuralClipboardIpc from "../ipc/handlers/StructuralClipboardIpc";
import * as NativeShellIpc from "../ipc/handlers/NativeShellIpc";
import * as NativeResourceIpc from "../ipc/handlers/NativeResourceIpc";
import * as PageSearchIpc from "../ipc/handlers/PageSearchIpc";
import * as FilesIpc from "../ipc/handlers/FilesIpc";
import * as ProjectWorkspaceIpc from "../ipc/handlers/ProjectWorkspaceIpc";
import * as InboxIpc from "../ipc/handlers/InboxIpc";
import * as ProjectionDeliveryIpc from "../ipc/handlers/ProjectionDeliveryIpc";
import * as StoreAdministrationIpc from "../ipc/handlers/StoreAdministrationIpc";
import * as TerminalIpc from "../ipc/handlers/TerminalIpc";
import * as WorktreeEnvironmentIpc from "../ipc/handlers/WorktreeEnvironmentIpc";
import * as WorkspaceFileIpc from "../ipc/handlers/WorkspaceFileIpc";
import * as WorkspaceFileQueries from "../host-runtime/WorkspaceFileQueries";
import * as SessionPolicyRuntime from "../host-runtime/SessionPolicyRuntime";
import * as CodexRendererProjectionRuntime from "../host-runtime/CodexRendererProjectionRuntime";
import * as CodexThreadNotificationRuntime from "../host-runtime/CodexThreadNotificationRuntime";
import * as TerminalProjectAdmission from "../terminal-runtime/TerminalProjectAdmission";

const terminalIngress = TerminalIpc.live.pipe(Layer.provideMerge(TerminalProjectAdmission.live));

/** Electron callback ingress that translates platform events into typed application capabilities. */
export const live = Layer.mergeAll(
  WorkbenchAgentIpc.live,
  AppUpdateIpc.live,
  NodexAccountIpc.live.pipe(Layer.provide(NodexAccountLive.live)),
  OpenCodeSetupIpc.live.pipe(
    Layer.provide(OpenCodeSetup.live.pipe(Layer.provide(OpenCodeInstallPlatform.nodeLive))),
  ),
  AvatarOverlayIpc.live,
  SessionPolicyRuntime.live,
  RemoteHostedPipIpc.live,
  ChromeControlSettingsIpc.live,
  ComputerUseSettingsIpc.live,
  GitWorkerIpc.live,
  DictationIpc.live(),
  CodexRealtimeVoiceIpc.live,
  DictationStreamingIpc.live(),
  ApplicationSyncIpc.live,
  WorkspaceFileIpc.live().pipe(Layer.provide(WorkspaceFileQueries.live)),
  FileSearchIpc.live,
  WorkspaceTextSearchIpc.live.pipe(
    Layer.provide(WorkspaceTextSearch.live.pipe(Layer.provide(WorkspaceTextSearchPlatform.live))),
  ),
  CodexFilesystemAssetRuntime.live,
  ApplicationLifecycleIpc.live,
  ComposerAppshotIpc.live,
  CodexApplicationIpc.live,
  PluginManagerIpc.live,
  McpAppDataIpc.live,
  CodexRendererIpc.live,
  CodexVisualizationIpc.live,
  CodexVisualizationStateIpc.live,
  CodexConversationServiceIpc.live,
  CodexRendererProjectionRuntime.live,
  CodexThreadNotificationRuntime.live,
  ApplicationWindowIpc.live(),
  BrowserProfileIpc.live,
  BrowserSidebarIpc.live,
  CoreAuthorityIpc.live,
  ExecutionHostIpc.live,
  ApplicationLocalStateIpc.live,
  ApplicationSettingsIpc.live,
  AgentBackendIpc.live,
  AgentRuntimeIpc.live,
  ClaudeUsageIpc.live,
  AcpAgentsIpc.live.pipe(Layer.provide(AcpAgents.live)),
  NativeSessionCatalogIpc.live.pipe(Layer.provide(NativeSessionCatalog.live)),
  AutomationIpc.live,
  CodexPendingWorktreeIpc.live,
  CodexThreadHandoffIpc.live,
  CodexWorkspaceIpc.live,
  CoreDocumentIpc.live,
  CoreMutationIpc.live,
  DocumentRecoveryIpc.live,
  DatabaseProjectionIpc.live,
  GitApplicationIpc.live,
  ManagedMediaIpc.live,
  StructuralClipboardIpc.live,
  NativeShellIpc.live,
  NativeResourceIpc.live,
  PageSearchIpc.live({}),
  FilesIpc.live,
  ProjectWorkspaceIpc.live,
  InboxIpc.live,
  ProjectionDeliveryIpc.live,
  StoreAdministrationIpc.live,
  WorktreeEnvironmentIpc.live,
  terminalIngress,
);
