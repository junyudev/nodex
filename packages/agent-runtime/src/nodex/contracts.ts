/** Canonical execution contracts; renderer consumers must use type-only imports. */
export type {
  OrchestrationV2AppThread,
  OrchestrationV2ServerCommand,
  OrchestrationV2ThreadProjection,
  OrchestrationV2DomainEvent,
  OrchestrationV2StoredEvent,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadHistoryPage,
  ModelSelection,
  ProviderInstanceId,
  ThreadId,
  RunId,
  ProjectId,
} from "@t3tools/contracts";

export type * from "./Interface.ts";
export type { AgentRuntimeBootstrap } from "./Bootstrap.ts";
export {
  AGENT_RUNTIME_CODEX_THREAD_SOURCE,
  isAgentRuntimeCodexThreadSource,
} from "./CodexThreadSource.ts";
export { AGENT_RUNTIME_STRUCTURED_GENERATION_MAX_TIMEOUT_MS } from "./TextGenerationLimits.ts";
export {
  AGENT_RUNTIME_CODEX_IMPORT_MAX_TIMEOUT_MS,
  CODEX_THREAD_IMPORT_OPERATION_PREFIX,
} from "./CodexImportLimits.ts";
