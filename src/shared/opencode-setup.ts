export type OpenCodeExecutable =
  | { readonly status: "missing" }
  | { readonly status: "ready"; readonly binaryPath: string; readonly version: string }
  | {
      readonly status: "incompatible";
      readonly binaryPath: string;
      readonly version: string;
      readonly minimumVersion: string;
    }
  | { readonly status: "unusable"; readonly message: string };

export interface OpenCodeInstallerLog {
  readonly lines: readonly string[];
  readonly progress: number | null;
}

export type OpenCodeInstallFailureReason =
  | "unsupported-platform"
  | "invalid-home"
  | "existing-installation"
  | "process"
  | "timeout"
  | "output-limit"
  | "invalid-version"
  | "configuration";

/** Host setup is independent of the account Profiles and conversations using OpenCode. */
export interface OpenCodeSetupState {
  readonly revision: number;
  readonly supported: boolean;
  readonly command: string;
  readonly executable: OpenCodeExecutable;
  readonly installation:
    | { readonly phase: "idle" }
    | { readonly phase: "running" | "succeeded"; readonly log: OpenCodeInstallerLog }
    | {
        readonly phase: "failed";
        readonly log: OpenCodeInstallerLog;
        readonly reason: OpenCodeInstallFailureReason;
        readonly message: string;
      };
}
