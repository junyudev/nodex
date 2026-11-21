import type { ServerProviderCompatibilityAdvisory } from "@nodex/runtime-contracts";

export interface AntigravityExecutable {
  readonly executablePath: string;
  readonly source: "override" | "managed" | "path";
  readonly version: string | null;
  readonly managedVersionDirectory: string | null;
}

export interface AntigravityInstallationChoice {
  readonly binaryPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
}
export interface AntigravityInstallationInspection {
  readonly driver: "antigravity";
  readonly platform: {
    readonly os: NodeJS.Platform;
    readonly arch: string;
    readonly supported: boolean;
  };
  readonly managedDirectory: string;
  readonly managed: AntigravityExecutable | null;
  readonly managedIssue: string | null;
  readonly path: AntigravityExecutable | null;
  readonly choices: ReadonlyArray<{
    readonly source: "managed" | "custom" | "path" | "unavailable";
    readonly executablePath: string | null;
    readonly version: string | null;
    readonly issue: string | null;
  }>;
  readonly compatibility: ServerProviderCompatibilityAdvisory | null;
  readonly minimumVersion: string | null;
  readonly recommendedVersion: string | null;
  readonly recommendedRange: string | null;
  /** The directory lock is observable, but does not prove another process is executing a release. */
  readonly managedLock: "clear" | "present" | "unknown";
  readonly leaseScope: "runtime";
  readonly supportedRanges: ReadonlyArray<string>;
  readonly latestKnownVersion: string | null;
  readonly updateAvailable: boolean | null;
  readonly leaseCount: number;
  readonly inUse: boolean;
  readonly installing: boolean;
  readonly canRemove: boolean;
  readonly removalBlockedBy: ReadonlyArray<"installation_running" | "in_use" | "configured_path">;
}
