import { isDevelopmentFeatureEnabled } from "../../shared/development-features";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  AutomationApplication,
  live as automationApplicationLive,
} from "../automation-application/AutomationApplication";
import {
  AutomationRoutingIndex,
  live as automationRoutingIndexLive,
} from "../core-runtime/AutomationRoutingIndex";
import {
  CoreAuthority,
  CoreSessionAccess,
  live as coreAuthorityLive,
} from "../core-runtime/CoreAuthority";
import { CoreModules, live as coreModulesLive } from "../core-runtime/CoreModules";
import {
  DocumentLiveRuntime,
  live as documentLiveRuntimeLive,
} from "../core-runtime/DocumentLiveRuntime";
import {
  StoreAdministration,
  live as storeAdministrationLive,
} from "../core-runtime/StoreAdministration";
import type { CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { live as coreTransportLive } from "../core-runtime/CoreTransport";
import { DesktopDocumentSessionRuntime, desktopDocumentSessionRuntimeLive } from "../core-client";
import { DatabaseModule, live as databaseModuleLive } from "../database-application/DatabaseModule";
import {
  CodexEphemeralThreadRouting,
  live as codexEphemeralThreadRoutingLive,
} from "../codex-runtime/CodexEphemeralThreadRouting";
import { CodexThreadHostResolver } from "../codex-runtime/CodexGateway";
import {
  live as projectRuntimeLifecycleLive,
  ProjectRuntimeLifecycleRuntime,
} from "../host-runtime/ProjectRuntimeLifecycleRuntime";
import {
  CanvasPresenceRuntime,
  live as canvasPresenceRuntimeLive,
} from "../host-runtime/CanvasPresenceRuntime";
import {
  WorktreeEnvironmentRuntime,
  live as worktreeEnvironmentRuntimeLive,
} from "../host-runtime/WorktreeEnvironmentRuntime";
import { ApplicationInitializationRuntime } from "../host-runtime/ApplicationInitializationRuntime";
import { LibraryModule, live as libraryModuleLive } from "../library-application/LibraryModule";
import {
  NodexAgentApplication,
  live as nodexAgentApplicationLive,
} from "../nodex-agent-application/NodexAgentApplication";
import {
  NodexAgentDynamicTools,
  layer as nodexAgentDynamicToolsLive,
} from "../nodex-agent-application/NodexAgentDynamicTools";
import {
  NodexAgentResourceAccess,
  live as nodexAgentResourceAccessLive,
} from "../nodex-agent-application/NodexAgentResourceAccess";
import {
  ProjectWorkspace,
  live as projectWorkspaceLive,
} from "../project-application/ProjectWorkspace";
import { MainConfig } from "./MainConfig";
import { MainShutdown } from "./MainShutdown";
import { ScopedCallbackRuntime } from "./ScopedCallbackRuntime";
import { threadHostResolverLive } from "../codex-application/ExecutionHostRuntime";

const transport = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const callbacks = yield* ScopedCallbackRuntime;
    const initialization = yield* ApplicationInitializationRuntime;

    return coreTransportLive({
      appResourcesPath: config.isPackaged ? config.resourcesPath : undefined,
      buildId: `nodex-desktop/${config.appVersion}`,
      isPackaged: config.isPackaged,
      nodexHome: config.nodexHome,
      onAuthorityProcessExit: (event) => {
        void callbacks.runPromise(initialization.observeAuthorityExit(event));
      },
      onStartupEvent: (event) => {
        void callbacks.runPromise(initialization.observeCoreStartup(event));
      },
      repositoryRoot: config.projectRootPath,
    });
  }),
);

const authority = coreAuthorityLive().pipe(Layer.provide(transport));
const core = coreModulesLive.pipe(Layer.provideMerge(authority));
const workspace = projectWorkspaceLive.pipe(Layer.provideMerge(core));
const hostResolver = threadHostResolverLive.pipe(
  Layer.provideMerge(Layer.merge(core, codexEphemeralThreadRoutingLive)),
);
const applicationData = Layer.merge(libraryModuleLive, databaseModuleLive).pipe(
  Layer.provideMerge(core),
);
const automationRouting = automationRoutingIndexLive.pipe(Layer.provideMerge(core));
const automation = automationApplicationLive.pipe(Layer.provideMerge(automationRouting));
const storeAdministration = storeAdministrationLive.pipe(Layer.provideMerge(core));
const worktreeEnvironment = worktreeEnvironmentRuntimeLive.pipe(Layer.provideMerge(core));
const canvasPresence = canvasPresenceRuntimeLive();
const documentLive = documentLiveRuntimeLive;
const documentSessions = Layer.unwrap(
  Effect.gen(function* () {
    const canvas = yield* CanvasPresenceRuntime;
    return desktopDocumentSessionRuntimeLive({ canvasPresenceHub: canvas.hub });
  }),
).pipe(Layer.provideMerge(Layer.mergeAll(core, canvasPresence, documentLive)));
const nodexAgent = nodexAgentApplicationLive.pipe(Layer.provideMerge(applicationData));
const nodexAgentTools = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    return nodexAgentDynamicToolsLive(
      isDevelopmentFeatureEnabled("nodex-dynamic-tools", config.environment),
    );
  }),
).pipe(Layer.provideMerge(nodexAgent));
const nodexAgentResourceAccess = nodexAgentResourceAccessLive.pipe(Layer.provideMerge(core));

/** Core authority and its direct application projections as one declarative dependency cluster. */
export const live: Layer.Layer<
  | CoreAuthority
  | CoreSessionAccess
  | CoreModules
  | ProjectWorkspace
  | ProjectRuntimeLifecycleRuntime
  | CodexEphemeralThreadRouting
  | CodexThreadHostResolver
  | AutomationRoutingIndex
  | AutomationApplication
  | LibraryModule
  | DatabaseModule
  | StoreAdministration
  | WorktreeEnvironmentRuntime
  | CanvasPresenceRuntime
  | DocumentLiveRuntime
  | DesktopDocumentSessionRuntime
  | NodexAgentApplication
  | NodexAgentDynamicTools
  | NodexAgentResourceAccess,
  CoreRuntimeError,
  MainConfig | MainShutdown | ScopedCallbackRuntime | ApplicationInitializationRuntime
> = Layer.mergeAll(
  workspace,
  hostResolver,
  projectRuntimeLifecycleLive,
  automation,
  storeAdministration,
  worktreeEnvironment,
  documentSessions,
  nodexAgentTools,
  nodexAgentResourceAccess,
);
