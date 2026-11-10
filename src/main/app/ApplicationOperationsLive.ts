import { CoreModules } from "../core-runtime/CoreModules";
import { workspaceWindow } from "../agent-backend/PageWorkspaceApplication";
import { nodeLive as openCodeSdkLive } from "../platform/node/OpenCodeSdk";
import { live as openCodeModelCatalogLive } from "../agent-backend/opencode/OpenCodeModelCatalog";
import { live as claudeSdkLive } from "../platform/node/ClaudeSdk";
import { live as claudeNativeCatalogLive } from "../agent-backend/claude/ClaudeNativeCatalog";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { live as appToolInterpreterLive } from "../app-tools/AppToolInterpreter";
import { live as sessionWaiterLive } from "../app-tools/SessionWaiter";
import { live as sessionObservationLive } from "../app-tools/NativeSessionObservation";
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
import { live as projectSessionCommandsLive } from "../project-application/ProjectSessionCommandsLive";
import { live as coreApplicationProjectionLive } from "../core-runtime/CoreApplicationProjectionRuntime";
import { live as projectionDeliveryLive } from "../core-runtime/ProjectionDeliveryRuntime";
import { live as coreEventHubLive } from "../core-runtime/CoreEventHub";
import { live as sessionReminderLive } from "../host-runtime/SessionReminderRuntime";
import { live as reminderSchedulerLive } from "../host-runtime/ReminderSchedulerRuntime";
import { live as unreadBadgeLive } from "../host-runtime/UnreadBadgeRuntime";
import { MainConfig } from "./MainConfig";
import { live as agentBackendApplicationLive } from "../agent-backend/AgentBackendApplication";
import { live as agentBackendRegistryLive } from "../agent-backend/AgentBackendRegistry";
import { live as workspaceDependencies } from "../../host/WorkspaceDependenciesLive";

import { live as skillInventoryLive } from "./SkillInventoryLive";

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
    const core = yield* CoreModules;
    return Layer.effect(
      ManagedWorktreeCatalog,
      makeManagedWorktreeCatalog({
        defaultManagedRoot: `${config.nodexHome}/worktrees`,
        pageWorkspacePaths: workspaceWindow(core).pipe(
          Effect.map((values) =>
            values
              .filter((value) => value.lifecycle !== "removed")
              .flatMap((value) => (value.worktree_path ? [value.worktree_path] : [])),
          ),
        ),
      }),
    );
  }),
).pipe(Layer.provideMerge(projectSessions));
const coreApplicationProjection = coreApplicationProjectionLive.pipe(
  Layer.provideMerge(managedWorktreeCatalog),
);
const projectionDelivery = projectionDeliveryLive.pipe(
  Layer.provideMerge(coreApplicationProjection),
);
const coreEvents = coreEventHubLive({}).pipe(Layer.provideMerge(projectionDelivery));
const reminders = Layer.mergeAll(
  reminderSchedulerLive({}),
  sessionReminderLive,
  unreadBadgeLive,
).pipe(Layer.provideMerge(coreEvents));
const agentBackends = agentBackendApplicationLive.pipe(
  Layer.provideMerge(Layer.merge(agentBackendRegistryLive, nativeMetadata)),
  Layer.provideMerge(reminders),
);

/** Application operations that depend on the Core, host, and canonical Conversation graphs. */
export const live = Layer.mergeAll(
  workspaceDependencies,
  workbenchObservationLive,
  Layer.effect(WorkbenchContentRouting, makeWorkbenchContentRouting),
).pipe(
  Layer.provideMerge(
    Layer.merge(sessionWaiterLive, skillInventoryLive).pipe(
      Layer.provideMerge(sessionObservationLive.pipe(Layer.provideMerge(agentBackends))),
    ),
  ),
);

/** Tools activate after the Inbox and Coordinator application Interfaces exist. */
export const tools = appToolInterpreterLive;
