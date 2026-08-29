import * as Layer from "effect/Layer";
import * as AppUpdateIpc from "../ipc/handlers/AppUpdateIpc";
import * as ApplicationLifecycleIpc from "../ipc/handlers/ApplicationLifecycleIpc";
import * as ApplicationSyncIpc from "../ipc/handlers/ApplicationSyncIpc";
import * as ApplicationWindowIpc from "../ipc/handlers/ApplicationWindowIpc";
import * as BrowserProfileIpc from "../ipc/handlers/BrowserProfileIpc";
import * as BrowserSidebarIpc from "../ipc/handlers/BrowserSidebarIpc";
import * as ComposerAppshotIpc from "../ipc/handlers/ComposerAppshotIpc";
import * as CodexApplicationIpc from "../ipc/handlers/CodexApplicationIpc";
import * as CodexRendererIpc from "../ipc/handlers/CodexRendererIpc";
import * as CodexPermissionsIpc from "../ipc/handlers/CodexPermissionsIpc";
import * as ComputerUseSettingsIpc from "../ipc/handlers/ComputerUseSettingsIpc";
import * as CoreAuthorityIpc from "../ipc/handlers/CoreAuthorityIpc";
import * as ApplicationLocalStateIpc from "../ipc/handlers/ApplicationLocalStateIpc";
import * as ApplicationSettingsIpc from "../ipc/handlers/ApplicationSettingsIpc";
import * as AutomationIpc from "../ipc/handlers/AutomationIpc";
import * as CodexPendingWorktreeIpc from "../ipc/handlers/CodexPendingWorktreeIpc";
import * as CodexWorkspaceIpc from "../ipc/handlers/CodexWorkspaceIpc";
import * as CoreDocumentIpc from "../ipc/handlers/CoreDocumentIpc";
import * as CoreMutationIpc from "../ipc/handlers/CoreMutationIpc";
import * as DatabaseProjectionIpc from "../ipc/handlers/DatabaseProjectionIpc";
import * as DictationIpc from "../ipc/handlers/DictationIpc";
import * as ExecutionHostIpc from "../ipc/handlers/ExecutionHostIpc";
import * as GitApplicationIpc from "../ipc/handlers/GitApplicationIpc";
import * as GitWorkerIpc from "../ipc/handlers/GitWorkerIpc";
import * as RemoteHostedPipIpc from "../ipc/handlers/RemoteHostedPipIpc";
import * as ManagedMediaIpc from "../ipc/handlers/ManagedMediaIpc";
import * as StructuralClipboardIpc from "../ipc/handlers/StructuralClipboardIpc";
import * as NativeShellIpc from "../ipc/handlers/NativeShellIpc";
import * as PageSearchIpc from "../ipc/handlers/PageSearchIpc";
import * as PageFilesIpc from "../ipc/handlers/PageFilesIpc";
import * as ProjectWorkspaceIpc from "../ipc/handlers/ProjectWorkspaceIpc";
import * as ProjectionDeliveryIpc from "../ipc/handlers/ProjectionDeliveryIpc";
import * as StoreAdministrationIpc from "../ipc/handlers/StoreAdministrationIpc";
import * as TerminalIpc from "../ipc/handlers/TerminalIpc";
import * as WorktreeEnvironmentIpc from "../ipc/handlers/WorktreeEnvironmentIpc";
import * as WorkspaceFileIpc from "../ipc/handlers/WorkspaceFileIpc";
import * as SessionPolicyRuntime from "../host-runtime/SessionPolicyRuntime";
import * as CodexRendererProjectionRuntime from "../host-runtime/CodexRendererProjectionRuntime";
import * as CodexThreadNotificationRuntime from "../host-runtime/CodexThreadNotificationRuntime";
import * as TerminalProjectAdmission from "../terminal-runtime/TerminalProjectAdmission";

const terminalIngress = TerminalIpc.live.pipe(Layer.provideMerge(TerminalProjectAdmission.live));

/** Electron callback ingress that translates platform events into typed application capabilities. */
export const live = Layer.mergeAll(
  AppUpdateIpc.live,
  SessionPolicyRuntime.live,
  RemoteHostedPipIpc.live,
  ComputerUseSettingsIpc.live,
  GitWorkerIpc.live,
  DictationIpc.live(),
  ApplicationSyncIpc.live,
  WorkspaceFileIpc.live(),
  ApplicationLifecycleIpc.live,
  ComposerAppshotIpc.live,
  CodexApplicationIpc.live,
  CodexRendererIpc.live,
  CodexRendererProjectionRuntime.live,
  CodexThreadNotificationRuntime.live,
  CodexPermissionsIpc.live,
  ApplicationWindowIpc.live(),
  BrowserProfileIpc.live,
  BrowserSidebarIpc.live,
  CoreAuthorityIpc.live,
  ExecutionHostIpc.live,
  ApplicationLocalStateIpc.live,
  ApplicationSettingsIpc.live,
  AutomationIpc.live,
  CodexPendingWorktreeIpc.live,
  CodexWorkspaceIpc.live,
  CoreDocumentIpc.live,
  CoreMutationIpc.live,
  DatabaseProjectionIpc.live,
  GitApplicationIpc.live,
  ManagedMediaIpc.live,
  StructuralClipboardIpc.live,
  NativeShellIpc.live,
  PageSearchIpc.live({}),
  PageFilesIpc.live,
  ProjectWorkspaceIpc.live,
  ProjectionDeliveryIpc.live,
  StoreAdministrationIpc.live,
  WorktreeEnvironmentIpc.live,
  terminalIngress,
);
