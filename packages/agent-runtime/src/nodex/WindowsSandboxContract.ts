import type {
  WindowsSandboxReadiness,
  WindowsSandboxSetupMode,
} from "@nodex/codex-app-server-protocol/v2";

/** Public setup observations never contain native errors, paths or configuration values. */
export interface AgentWindowsSandboxState {
  readonly generation: string;
  readonly status: WindowsSandboxReadiness | "notApplicable" | "checking" | "settingUp" | "failed";
  readonly mode: WindowsSandboxSetupMode | null;
  readonly failure: "checkFailed" | "setupFailed" | "cancelled" | "timeout" | null;
  readonly allowedModes: readonly WindowsSandboxSetupMode[];
}

export interface AgentWindowsSandboxOperations {
  readonly "providers.windows-sandbox.read": {
    readonly input: { readonly instanceId: string; readonly refresh?: boolean };
    readonly output: AgentWindowsSandboxState;
  };
  readonly "providers.windows-sandbox.setup": {
    readonly input: {
      readonly instanceId: string;
      readonly mode: WindowsSandboxSetupMode;
    };
    readonly output: AgentWindowsSandboxState;
  };
  readonly "providers.windows-sandbox.cancel": {
    readonly input: { readonly instanceId: string; readonly generation: string };
    readonly output: AgentWindowsSandboxState;
  };
}
