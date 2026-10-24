import type {
  AcpRegistrySearchInput,
  AcpRegistryPrepareInput,
  AcpRegistryInstallPreview,
  AcpRegistryOperationErrorReason,
  AcpRegistryProbeAuthMethod,
  AcpRegistryUrlAuthAction,
  AcpRegistrySearchResult,
  AcpRegistryPrepareResult,
  AcpRegistryProbeResult,
  AcpRegistryListSessionsResult,
  AcpRegistryListProvidersResult,
  AcpRegistrySetProviderInput,
  ProviderAuthStartInput,
  ProviderAuthRespondInput,
  ProviderAuthCompleteInput,
  ProviderAuthCancelInput,
  ProviderAuthState,
} from "@t3tools/contracts";
import type { AcpRegistryInspection } from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import type { AgentWire } from "./Interface.ts";

export interface AgentAcpTarget {
  readonly instanceId: string;
  readonly cwd: string;
}
export interface AgentAcpFailure {
  readonly reason:
    | AcpRegistryOperationErrorReason
    | "busy"
    | "configuration_pending"
    | "disabled"
    | "invalid_request"
    | "operation_expired";
  readonly message: string;
  readonly authMethods?: AgentWire<ReadonlyArray<AcpRegistryProbeAuthMethod>>;
  readonly authAction?: AgentWire<AcpRegistryUrlAuthAction>;
  readonly affectedThreadIds?: ReadonlyArray<string>;
}
export interface AgentAcpOperation {
  readonly operationId: string;
  readonly kind: "install" | "connect";
  readonly phase: "running" | "succeeded" | "failed" | "cancelled";
  readonly instanceId: string | null;
  readonly agentId: string | null;
  readonly result: AgentWire<AcpRegistryPrepareResult | AcpRegistryProbeResult> | null;
  readonly error: AgentAcpFailure | null;
  readonly progress?: {
    readonly phase: "downloading" | "verifying" | "extracting" | "installing";
    readonly downloadedBytes: number;
    readonly totalBytes: number | null;
  };
}
export interface AgentAcpManagementOperations {
  readonly "acp.activity": {
    readonly input: Record<string, never>;
    readonly output: { readonly activeOperations: number; readonly activeAuthentication: number };
  };
  readonly "acp.registry.search": {
    readonly input: AgentWire<AcpRegistrySearchInput>;
    readonly output: AgentWire<AcpRegistrySearchResult>;
  };
  readonly "acp.inspect": {
    readonly input: { readonly instanceId: string };
    readonly output: AcpRegistryInspection;
  };
  readonly "acp.install.preview": {
    readonly input: AgentWire<AcpRegistryPrepareInput>;
    readonly output: AgentWire<AcpRegistryInstallPreview>;
  };
  readonly "acp.install.start": {
    readonly input: {
      readonly operationId: string;
      readonly agentId: string;
      readonly distribution?: "auto" | "binary" | "npx" | "uvx";
      readonly expectedInstallationId?: string;
    };
    readonly output: AgentAcpOperation;
  };
  readonly "acp.registry.uninstall": {
    readonly input: { readonly agentId: string };
    readonly output: { readonly agentId: string; readonly removed: boolean };
  };
  readonly "acp.connection.start": {
    readonly input: AgentAcpTarget & { readonly operationId: string };
    readonly output: AgentAcpOperation;
  };
  readonly "acp.operation.read": {
    readonly input: { readonly operationId: string };
    readonly output: AgentAcpOperation;
  };
  readonly "acp.operation.cancel": {
    readonly input: { readonly operationId: string };
    readonly output: AgentAcpOperation;
  };
  readonly "acp.auth.read": {
    readonly input: { readonly instanceId: string; readonly ownerId: string };
    readonly output: AgentWire<ProviderAuthState>;
  };
  readonly "acp.auth.start": {
    readonly input: AgentWire<ProviderAuthStartInput> & { readonly ownerId: string };
    readonly output: AgentWire<ProviderAuthState>;
  };
  readonly "acp.auth.respond": {
    readonly input: AgentWire<ProviderAuthRespondInput> & { readonly ownerId: string };
    readonly output: AgentWire<ProviderAuthState>;
  };
  readonly "acp.auth.complete": {
    readonly input: AgentWire<ProviderAuthCompleteInput> & { readonly ownerId: string };
    readonly output: AgentWire<ProviderAuthState>;
  };
  readonly "acp.auth.cancel": {
    readonly input: AgentWire<ProviderAuthCancelInput> & { readonly ownerId: string };
    readonly output: AgentWire<ProviderAuthState>;
  };
  readonly "acp.auth.logout": {
    readonly input: { readonly instanceId: string };
    readonly output: AgentWire<ProviderAuthState>;
  };
  readonly "acp.urlAuth.accept": {
    readonly input: { readonly instanceId: string; readonly elicitationId: string };
    readonly output: { readonly accepted: boolean };
  };
  readonly "acp.sessions.list": {
    readonly input: AgentAcpTarget & { readonly cursor?: string };
    readonly output: AgentWire<AcpRegistryListSessionsResult>;
  };
  readonly "acp.sessions.prepareImport": {
    readonly input: AgentAcpTarget & { readonly sessionId: string };
    readonly output: {
      readonly threadId: string;
      readonly sourceFingerprint: string;
      readonly title: string;
      readonly cwd: string;
      readonly canLoad: boolean;
      readonly canResume: boolean;
      readonly imported: boolean;
    };
  };
  readonly "acp.sessions.import": {
    readonly input: AgentAcpTarget & {
      readonly commandId: string;
      readonly threadId: string;
      readonly projectId: string;
      readonly title: string;
      readonly sessionId: string;
      readonly sourceFingerprint: string;
      readonly model: string;
    };
    readonly output: { readonly threadId: string };
  };
  readonly "acp.sessions.delete": {
    readonly input: AgentAcpTarget & { readonly sessionId: string };
    readonly output: { readonly deleted: true };
  };
  readonly "acp.modelProviders.list": {
    readonly input: AgentAcpTarget;
    readonly output: AgentWire<AcpRegistryListProvidersResult>;
  };
  readonly "acp.modelProviders.set": {
    readonly input: AgentAcpTarget &
      AgentWire<Omit<AcpRegistrySetProviderInput, "instanceId" | "projectId">>;
    readonly output: AgentWire<AcpRegistryListProvidersResult>;
  };
  readonly "acp.modelProviders.disable": {
    readonly input: AgentAcpTarget & { readonly providerId: string };
    readonly output: AgentWire<AcpRegistryListProvidersResult>;
  };
}
