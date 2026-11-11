/** Canonical execution contracts; renderer consumers must use type-only imports. */
export {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  getProviderAttachmentLimitError,
  DEFAULT_RUNTIME_MODE,
  RUNTIME_MODE_RANK,
} from "@nodex/runtime-contracts";
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
  RuntimeMode,
  ProviderApprovalDecision,
  ProviderInstanceId,
  ThreadId,
  RunId,
  ProjectId,
} from "@nodex/runtime-contracts";

export type { HostDesktopTools } from "@nodex/provider-core/server/ExecutionHost";
export type * from "./Interface.ts";
export type { AgentRuntimeBootstrap } from "./Bootstrap.ts";
export {
  AGENT_RUNTIME_CODEX_THREAD_SOURCE,
  isAgentRuntimeCodexThreadSource,
} from "./CodexThreadSource.ts";
export { AGENT_RUNTIME_STRUCTURED_GENERATION_MAX_TIMEOUT_MS } from "./TextGenerationLimits.ts";
export {
  AGENT_RUNTIME_NATIVE_IMPORT_MAX_TIMEOUT_MS,
  NATIVE_THREAD_IMPORT_OPERATION_PREFIX,
} from "./NativeImportLimits.ts";

export type * from "./AcpManagementContract.ts";
export type * from "./WindowsSandboxContract.ts";
export { decodeAgentAcpFailure } from "./AcpFailureContract.ts";

export {
  asDesktopRecord,
  codexDesktopToolItemActivity,
  parseDesktopIdentifier,
  parseDesktopToolActivity,
  type BrowserUsePipSurface,
  type DesktopToolActivity,
} from "@nodex/provider-core/server/desktopToolActivity";
