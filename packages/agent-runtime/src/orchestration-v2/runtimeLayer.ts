import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Layer from "effect/Layer";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../project/AgentSessionScanner.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderContinuationService from "./ProviderContinuationService.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadLifecycleService from "./ThreadLifecycleService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import {
  layerEventInfrastructure,
  layerCommandReceiptStoreProvided,
  layerEventSinkProvided,
  layerProjectService,
  layerOrchestratorProvided,
  layerThreadManagementProvided,
  layer,
} from "./executionLayer.ts";
export {
  layerEventInfrastructure,
  layerEventSink,
  layerProjectService,
  layer,
} from "./executionLayer.ts";

const layerAgentSessionImporterProvided = AgentSessionImporter.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      AgentSessionScanner.layer,
      layerProjectService,
      layerOrchestratorProvided,
      layerEventSinkProvided,
      IdAllocator.layer,
      ProviderSessionRuntime.layer,
    ),
  ),
);

export const layerProjectSetupScriptRunner = ProjectSetupScriptRunner.layer.pipe(
  Layer.provide(layerProjectService),
);

const layerManagedProjectFoldersProvided = ManagedProjectFolders.layer.pipe(
  Layer.provide(layerProjectService),
);

const layerThreadLaunchProvided = ThreadLaunchService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerProjectService,
      layerProjectSetupScriptRunner,
      layerManagedProjectFoldersProvided,
      layerThreadManagementProvided,
      layerCommandReceiptStoreProvided,
      IdAllocator.layer,
    ),
  ),
);

const layerThreadLifecycleProvided = ThreadLifecycleService.layer.pipe(
  Layer.provide(layerThreadManagementProvided),
);

const layerSecretRequestsProvided = SecretRequests.layer.pipe(
  Layer.provide(layerThreadManagementProvided),
);

const layerScheduledTaskProvided = ScheduledTaskService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerThreadLaunchProvided,
      layerThreadManagementProvided,
      layerSecretRequestsProvided,
    ),
  ),
);

const layerProviderContinuationWorkerProvided = ProviderContinuationService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProviderContinuationRequests.layer,
      layerThreadManagementProvided,
      IdAllocator.layer,
    ),
  ),
);

export const layerProduction = Layer.mergeAll(
  layer.pipe(Layer.provide(layerProjectService)),
  layerProjectService,
  layerManagedProjectFoldersProvided,
  layerThreadLaunchProvided,
  layerThreadLifecycleProvided,
  layerScheduledTaskProvided,
  layerSecretRequestsProvided,
  UsageLimitRecoveryWorker.layer.pipe(
    Layer.provide(Layer.mergeAll(ProjectionStore.layer, layerThreadManagementProvided)),
  ),
  layerProviderContinuationWorkerProvided,
  layerAgentSessionImporterProvided,
  EffectOutbox.layerPruneWorker.pipe(Layer.provide(EffectOutbox.layer)),
).pipe(Layer.provide(Scheduler.layer), Layer.provideMerge(layerEventInfrastructure));
