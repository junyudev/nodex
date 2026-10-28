import { nodeLive as openCodeSdkLive } from "../platform/node/OpenCodeSdk";
import { live as openCodeModelCatalogLive } from "../agent-backend/opencode/OpenCodeModelCatalog";
import { live as claudeSdkLive } from "../platform/node/ClaudeSdk";
import { live as claudeNativeCatalogLive } from "../agent-backend/claude/ClaudeNativeCatalog";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { live as appToolInterpreterLive } from "../app-tools/AppToolInterpreter";
import { live as sessionWaiterLive } from "../app-tools/SessionWaiter";
import { live as sessionObservationLive } from "../app-tools/SessionObservation";
import { live as workbenchObservationLive } from "../app-tools/WorkbenchObservation";
import {
  WorkbenchContentRouting,
  make as makeWorkbenchContentRouting,
} from "../app-tools/WorkbenchContentRouting";
import {
  CodexBackgroundProcesses,
  make as makeCodexBackgroundProcesses,
} from "../codex-application/CodexBackgroundProcesses";
import {
  ManagedWorktreeCatalog,
  make as makeManagedWorktreeCatalog,
} from "../codex-application/ManagedWorktreeCatalog";
import { live as projectArchiveBlockersLive } from "../project-application/ProjectArchiveBlockers";
import { live as projectLifecycleCommandsLive } from "../project-application/ProjectLifecycleCommands";
import { live as projectSessionCommandsLive } from "../project-application/ProjectSessionCommands";
import { live as initialProjectBootstrapLive } from "../initial-project/InitialProjectBootstrapRuntime";
import { resolveInitialProjectProjectsDirectory } from "../initial-project/initial-project-filesystem";
import { resolveInitialProjectJournalPath } from "../initial-project/initial-project-journal-store";
import { live as coreApplicationProjectionLive } from "../core-runtime/CoreApplicationProjectionRuntime";
import { live as projectionDeliveryLive } from "../core-runtime/ProjectionDeliveryRuntime";
import { live as coreEventHubLive } from "../core-runtime/CoreEventHub";
import { live as reminderSchedulerLive } from "../host-runtime/ReminderSchedulerRuntime";
import { CodexPlatform } from "./CodexApplicationLive";
import { MainConfig } from "./MainConfig";
import { live as agentBackendApplicationLive } from "../agent-backend/AgentBackendApplication";
import { live as agentBackendRegistryLive } from "../agent-backend/AgentBackendRegistry";
import { live as workspaceDependencyLive } from "../host-runtime/WorkspaceDependencyRuntime";

const workspaceDependencies = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const codex = yield* CodexPlatform;
    const browser = codex.runtime.browserRuntime;
    return workspaceDependencyLive({
      root: config.isPackaged
        ? `${config.resourcesPath}/workspace-runtime`
        : `${config.projectRootPath}/.generated/workspace-runtime/${config.arch}`,
      platform: config.platform,
      arch: config.arch,
      node:
        browser.status === "available"
          ? {
              executable: browser.bundle.paths.node,
              version: browser.bundle.manifest.runtimeVersions.node,
            }
          : null,
    });
  }),
);

const backgroundProcesses = Layer.effect(CodexBackgroundProcesses, makeCodexBackgroundProcesses);
const projectArchiveBlockers = projectArchiveBlockersLive.pipe(
  Layer.provideMerge(backgroundProcesses),
);
const nativeMetadata = Layer.mergeAll(
  claudeNativeCatalogLive.pipe(Layer.provideMerge(claudeSdkLive)),
  openCodeModelCatalogLive.pipe(Layer.provideMerge(openCodeSdkLive)),
);
const projectLifecycle = projectLifecycleCommandsLive.pipe(
  Layer.provideMerge(projectArchiveBlockers),
);
const projectSessions = projectSessionCommandsLive.pipe(Layer.provideMerge(projectLifecycle));
const managedWorktreeCatalog = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    return Layer.effect(
      ManagedWorktreeCatalog,
      makeManagedWorktreeCatalog({ defaultManagedRoot: `${config.nodexHome}/worktrees` }),
    );
  }),
).pipe(Layer.provideMerge(projectSessions));
const initialProjectBootstrap = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    return initialProjectBootstrapLive({
      projectsDirectory: resolveInitialProjectProjectsDirectory({
        configuredDirectory: config.initialProjectsDirectory ?? undefined,
        documentsDirectory: config.documentsPath,
      }),
      journalPath: resolveInitialProjectJournalPath(config.nodexHome),
    });
  }),
).pipe(Layer.provideMerge(managedWorktreeCatalog));
const coreApplicationProjection = coreApplicationProjectionLive.pipe(
  Layer.provideMerge(initialProjectBootstrap),
);
const projectionDelivery = projectionDeliveryLive.pipe(
  Layer.provideMerge(coreApplicationProjection),
);
const coreEvents = coreEventHubLive({}).pipe(Layer.provideMerge(projectionDelivery));
const reminders = reminderSchedulerLive({}).pipe(Layer.provideMerge(coreEvents));
const agentBackends = agentBackendApplicationLive.pipe(
  Layer.provideMerge(Layer.merge(agentBackendRegistryLive, nativeMetadata)),
  Layer.provideMerge(reminders),
);

/** Application operations that depend on the Core, host, and canonical Conversation graphs. */
export const live = appToolInterpreterLive.pipe(
  Layer.provideMerge(workspaceDependencies),
  Layer.provideMerge(
    Layer.merge(
      workbenchObservationLive,
      Layer.effect(WorkbenchContentRouting, makeWorkbenchContentRouting),
    ),
  ),
  Layer.provideMerge(
    sessionWaiterLive.pipe(
      Layer.provideMerge(sessionObservationLive.pipe(Layer.provideMerge(agentBackends))),
    ),
  ),
);
