import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { live as automationExecutionLive } from "../automation-application/AutomationExecution";
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
import { live as scheduledAutomationLive } from "../host-runtime/ScheduledAutomationRuntime";
import { live as coreApplicationProjectionLive } from "../core-runtime/CoreApplicationProjectionRuntime";
import { live as projectionDeliveryLive } from "../core-runtime/ProjectionDeliveryRuntime";
import { live as coreEventHubLive } from "../core-runtime/CoreEventHub";
import { live as reminderSchedulerLive } from "../host-runtime/ReminderSchedulerRuntime";
import { live as storeAdministrationSchedulerLive } from "../host-runtime/StoreAdministrationSchedulerRuntime";
import { CodexPlatform } from "./CodexApplicationLive";
import { MainConfig } from "./MainConfig";
import { live as agentBackendApplicationLive } from "../agent-backend/AgentBackendApplication";
import { live as agentBackendRegistryLive } from "../agent-backend/AgentBackendRegistry";
import { live as acpBackendSessionManagerLive } from "../agent-backend/acp/AcpBackendSessionManager";
import { live as acpAgentLaunchProbeLive } from "../platform/node/AcpAgentLaunchProbe";
import { live as acpSessionTransportLive } from "../platform/node/AcpSessionTransport";

const automationExecution = Layer.unwrap(
  Effect.gen(function* () {
    const codex = yield* CodexPlatform;
    return automationExecutionLive({
      runtimeStateHome: codex.runtimeStateHome,
      runtimeVersion: codex.runtime.appServerRuntimeVersion ?? codex.runtime.version,
    });
  }),
);
const backgroundProcesses = Layer.effect(
  CodexBackgroundProcesses,
  makeCodexBackgroundProcesses,
).pipe(Layer.provideMerge(automationExecution));
const projectArchiveBlockers = projectArchiveBlockersLive.pipe(
  Layer.provideMerge(backgroundProcesses),
);
const acpPlatform = Layer.merge(acpAgentLaunchProbeLive, acpSessionTransportLive);
const acpSessions = acpBackendSessionManagerLive.pipe(Layer.provideMerge(acpPlatform));
const projectLifecycle = projectLifecycleCommandsLive.pipe(
  Layer.provideMerge(Layer.merge(projectArchiveBlockers, acpSessions)),
);
const projectSessions = projectSessionCommandsLive.pipe(
  Layer.provideMerge(Layer.merge(projectLifecycle, acpSessions)),
);
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
const scheduledAutomation = scheduledAutomationLive().pipe(
  Layer.provideMerge(initialProjectBootstrap),
);
const coreApplicationProjection = coreApplicationProjectionLive.pipe(
  Layer.provideMerge(scheduledAutomation),
);
const projectionDelivery = projectionDeliveryLive.pipe(
  Layer.provideMerge(coreApplicationProjection),
);
const coreEvents = coreEventHubLive({}).pipe(Layer.provideMerge(projectionDelivery));
const reminders = reminderSchedulerLive({}).pipe(Layer.provideMerge(coreEvents));
const storeSchedulers = storeAdministrationSchedulerLive({}).pipe(Layer.provideMerge(reminders));
const agentBackends = agentBackendApplicationLive.pipe(
  Layer.provideMerge(Layer.merge(agentBackendRegistryLive, acpSessions)),
  Layer.provideMerge(storeSchedulers),
);

/** Application operations that depend on the Core, host, and canonical Conversation graphs. */
export const live = agentBackends;
