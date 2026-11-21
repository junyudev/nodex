import type { AgentWire } from "./Interface.ts";
import type { AntigravityInstallationInspection } from "../provider/AntigravityInstallationContract.ts";

export type AgentProviderInstallationState = AgentWire<
  Omit<AntigravityInstallationInspection, "choices">
> & {
  readonly runtimeGeneration: string;
  readonly instances: ReadonlyArray<
    AgentWire<AntigravityInstallationInspection["choices"][number]> & {
      readonly instanceId: string;
      readonly configuredBinaryPath: string | null;
    }
  >;
};
export interface AgentProviderInstallationFailure {
  readonly reason:
    | "invalid_request"
    | "operation_expired"
    | "busy"
    | "unsupported_platform"
    | "inspection_failed"
    | "download_failed"
    | "verification_failed"
    | "installation_failed"
    | "removal_failed";
  readonly message: string;
}
export interface AgentProviderInstallationOperation {
  readonly operationId: string;
  readonly runtimeGeneration: string;
  readonly driver: "antigravity";
  readonly kind: "install" | "remove";
  readonly revision: number;
  readonly cancellable: boolean;
  readonly phase: "running" | "succeeded" | "failed" | "cancelled";
  readonly result: AgentProviderInstallationState | null;
  readonly error: AgentProviderInstallationFailure | null;
  readonly progress?: {
    readonly phase: "downloading" | "verifying" | "extracting" | "installing";
    readonly downloadedBytes: number;
    readonly totalBytes: number | null;
  };
}

/** The executable installation belongs to the driver and can be managed before an account exists. */
export interface AgentProviderInstallationManagementOperations {
  /** Filesystem and cached inspection. A refresh also probes the version of external executables. */
  readonly "providers.install.read": {
    readonly input: { readonly driver: "antigravity"; readonly refresh?: boolean };
    readonly output: AgentProviderInstallationState;
  };
  readonly "providers.install.start": {
    readonly input: { readonly driver: "antigravity"; readonly operationId: string };
    readonly output: AgentProviderInstallationOperation;
  };
  readonly "providers.install.remove": {
    readonly input: { readonly driver: "antigravity"; readonly operationId: string };
    readonly output: AgentProviderInstallationOperation;
  };
  readonly "providers.install.operation.read": {
    readonly input: { readonly operationId: string };
    readonly output: AgentProviderInstallationOperation;
  };
  readonly "providers.install.operation.cancel": {
    readonly input: { readonly operationId: string };
    readonly output: AgentProviderInstallationOperation;
  };
}
