/** Core execution composition, independent of desktop launch and scheduling capabilities. */
import * as Layer from "effect/Layer";
import * as OrchestrationCommandReceipts from "../persistence/OrchestrationCommandReceipts.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as McpAppRequests from "../mcpApps/McpAppRequests.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as CheckpointCaptureService from "./CheckpointCaptureService.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as CommandPolicy from "./CommandPolicy.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderRuntimeRecoveryService from "./ProviderRuntimeRecoveryService.ts";
import * as ProviderSwitchService from "./ProviderSwitchService.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RunFinalizationService from "./RunFinalization.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadForkService from "./ThreadForkService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

export const layerEventInfrastructure = Layer.mergeAll(
  OrchestrationEventStore.layer,
  OrchestrationCommandReceipts.layer,
);

export const layerRuntimePolicyProvided = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provide(ProjectStore.layer),
);

export const layerEventStoreProvided = EventStore.layerFromOrchestrationEventStore.pipe(
  Layer.provide(layerEventInfrastructure),
);

export const layerCommandReceiptStoreProvided =
  CommandReceiptStore.layerFromApplicationReceipts.pipe(Layer.provide(layerEventInfrastructure));

export const layerStores = Layer.mergeAll(
  layerEventInfrastructure,
  layerEventStoreProvided,
  ProjectionStore.layer,
  ProjectStore.layer,
  layerCommandReceiptStoreProvided,
  EffectOutbox.layer,
  TurnItemPositionStore.layer,
);

export const layerEventSink = EventSink.layerFromStores.pipe(Layer.provide(layerStores));

export const layerEventSinkProvided = layerEventSink;

export const layerProjectionMaintenanceProvided = ProjectionMaintenance.layer.pipe(
  Layer.provide(layerStores),
);

export const layerLegacyV1ThreadImporterProvided = LegacyV1ThreadImporter.layer.pipe(
  Layer.provide(layerEventSinkProvided),
);

export const layerProjectService = ProjectService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectStore.layer,
      ProjectionStore.layer,
      layerEventSinkProvided,
      IdAllocator.layer,
      layerLegacyV1ThreadImporterProvided,
    ),
  ),
);

export const layerProviderEventIngestorProvided = ProviderEventIngestor.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerEventSinkProvided,
      IdAllocator.layer,
      ProjectionStore.layer,
      ThreadCommandExecutor.layer,
    ),
  ),
);

export const layerCheckpointServiceProvided = CheckpointService.layer.pipe(
  Layer.provide(IdAllocator.layer),
);

export const layerContextHandoffServiceProvided = ContextHandoffService.layer.pipe(
  Layer.provide(IdAllocator.layer),
);

export const layerProviderAdapterRegistryProvided =
  ProviderAdapterRegistry.layerFromProviderInstanceRegistry;

export const layerProviderSwitchServiceProvided = ProviderSwitchService.layer.pipe(
  Layer.provide(layerProviderAdapterRegistryProvided),
);

export const layerProviderSessionManagerProvided = ProviderSessionManager.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerProviderAdapterRegistryProvided,
      layerEventSinkProvided,
      IdAllocator.layer,
      layerProviderEventIngestorProvided,
      ProjectionStore.layer,
    ),
  ),
);

export const layerProviderAuthServiceProvided = ProviderAuthService.layer.pipe(
  Layer.provide(Layer.merge(ProjectionStore.layer, layerProviderSessionManagerProvided)),
);

export const layerRunExecutionServiceProvided = RunExecutionService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      McpAppModelContext.layer,
      layerCheckpointServiceProvided,
      layerEventSinkProvided,
      IdAllocator.layer,
      layerProviderEventIngestorProvided,
    ),
  ),
);

export const layerProviderTurnStartServiceProvided = ProviderTurnStartService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerContextHandoffServiceProvided,
      layerEventSinkProvided,
      IdAllocator.layer,
      ProjectionStore.layer,
      layerProviderSessionManagerProvided,
      layerProviderAuthServiceProvided,
      layerRunExecutionServiceProvided,
      layerRuntimePolicyProvided,
    ),
  ),
);

export const layerProviderTurnControlServiceProvided = ProviderTurnControlService.layer.pipe(
  Layer.provide(Layer.merge(ProjectionStore.layer, layerProviderSessionManagerProvided)),
);

export const layerRuntimeRequestServiceProvided = RuntimeRequestService.layer.pipe(
  Layer.provide(Layer.merge(ProjectionStore.layer, layerProviderSessionManagerProvided)),
);

export const layerCheckpointRollbackServiceProvided = CheckpointRollbackService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      ProjectStore.layer,
      layerCheckpointServiceProvided,
      layerEventSinkProvided,
      IdAllocator.layer,
      ProjectionStore.layer,
      layerProviderSessionManagerProvided,
      ThreadCommandExecutor.layer,
      layerRuntimePolicyProvided,
    ),
  ),
);

export const layerCheckpointCaptureServiceProvided = CheckpointCaptureService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerCheckpointServiceProvided,
      layerEventSinkProvided,
      IdAllocator.layer,
      ProjectionStore.layer,
    ),
  ),
);

export const layerRunFinalizationServiceProvided = RunFinalizationService.layer.pipe(
  Layer.provide(Layer.merge(layerCheckpointCaptureServiceProvided, ProjectionStore.layer)),
);

export const layerOrchestratorProvided = Orchestrator.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerCheckpointServiceProvided,
      CommandPolicy.layer,
      layerStores,
      layerEventSinkProvided,
      layerCommandReceiptStoreProvided,
      layerContextHandoffServiceProvided,
      IdAllocator.layer,
      ProjectStore.layer,
      layerProviderAdapterRegistryProvided,
      // Same layer reference as the continuation worker and the adapter
      // infrastructure so layer memoization yields one shared request queue.
      ProviderContinuationRequests.layer,
      layerProviderEventIngestorProvided,
      layerRuntimePolicyProvided,
      layerProviderSessionManagerProvided,
      layerProviderSwitchServiceProvided,
      layerRunExecutionServiceProvided,
      ThreadForkService.layer,
    ),
  ),
);

export const layerThreadManagementProvided = ThreadManagementService.layerWithLegacyImporter.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerOrchestratorProvided,
      layerLegacyV1ThreadImporterProvided,
      layerCommandReceiptStoreProvided,
      layerProviderSessionManagerProvided,
    ),
  ),
);

export const layerThreadTitleRegenerationProvided = ThreadTitleRegenerationService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(layerThreadManagementProvided, ProjectStore.layer, TextGeneration.layer),
  ),
);

export const layerEffectExecutorProvided = EffectWorker.layerExecutor.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerRunFinalizationServiceProvided,
      layerCheckpointRollbackServiceProvided,
      layerProviderSessionManagerProvided,
      layerProviderTurnControlServiceProvided,
      layerProviderTurnStartServiceProvided,
      layerRuntimeRequestServiceProvided,
      layerThreadTitleRegenerationProvided,
      layerThreadManagementProvided,
    ),
  ),
);

export const layerEffectWorkerProvided = EffectWorker.layer.pipe(
  Layer.provide(Layer.merge(layerStores, layerEffectExecutorProvided)),
);

export const layerProviderRuntimeRecoveryProvided = ProviderRuntimeRecoveryService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerEffectWorkerProvided,
      layerStores,
      layerEventSinkProvided,
      IdAllocator.layer,
      ProjectionStore.layer,
    ),
  ),
);

export const layerMcpAppRequestsProvided = McpAppRequests.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      McpAppModelContext.layer,
      layerOrchestratorProvided,
      layerThreadManagementProvided,
      layerProviderSessionManagerProvided,
    ),
  ),
);

export const layer = Layer.mergeAll(
  layerOrchestratorProvided,
  layerMcpAppRequestsProvided,
  layerThreadManagementProvided,
  layerEffectWorkerProvided,
  layerProviderSessionManagerProvided,
  layerProviderAuthServiceProvided,
  layerProviderRuntimeRecoveryProvided,
  layerProjectionMaintenanceProvided,
  layerLegacyV1ThreadImporterProvided,
);
