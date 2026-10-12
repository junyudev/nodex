import type { BrowserRuntimeManifest } from "../../src/shared/browser-runtime-metadata.js";

export interface RealRuntimeOptions {
  readonly allowNativeUi: boolean;
  readonly electronExecutable: string | null | undefined;
  readonly replacementCount: number;
  readonly requested: boolean;
  readonly runtimeRoot: string | null;
  readonly serviceReconnectCount: number;
  readonly taskCycleCount: number;
  readonly timeoutMs: number;
  readonly windowCycleCount: number;
}

export type ElectronProcessRole =
  | "electron-main"
  | "electron-renderer"
  | "electron-gpu"
  | "electron-utility"
  | "electron-helper"
  | "electron-child";

export interface ProcessRecord {
  readonly command: string;
  readonly pid: number;
  readonly ppid: number;
  readonly rssBytes: number;
  readonly state: string;
}

export interface Footprint {
  readonly footprintBytes: number;
  readonly footprintPeakBytes: number;
}

export interface ResourceSample {
  readonly stage: string;
  readonly processes: readonly {
    readonly footprintBytes?: number | null;
    readonly role: string;
    readonly rssBytes: number;
  }[];
}

export interface NumericSummary {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
}

export interface ResourceSummary {
  readonly baselineFootprintBytes: number | null;
  readonly baselineRssBytes: number;
  readonly peakFootprintBytes: number | null;
  readonly peakRssBytes: number;
  readonly recoveryFootprintBytes: number | null;
  readonly recoveryRssBytes: number;
  readonly rss: NumericSummary;
  readonly rssWhenPresent: NumericSummary;
  readonly footprintBytes: NumericSummary;
}

export type ResourceSummaries = Readonly<Record<string, ResourceSummary | undefined>> & {
  readonly total: ResourceSummary;
};

export type CodeSignature =
  | {
      readonly authority: string | null;
      readonly status: "verified";
      readonly teamId: string | null;
    }
  | { readonly message: string; readonly status: "unverified"; readonly teamId: null };

export type ProcessOwnership =
  | "validated-external-native-service"
  | "spawned-electron-main"
  | "verified-electron-descendant";

interface RuntimeIdentity {
  readonly manifestSha256: string;
  readonly root: string;
}

interface BenchmarkEnvironment {
  readonly arch: string;
  readonly platform: NodeJS.Platform;
  readonly release: string;
}

type BenchmarkCounts = Pick<
  RealRuntimeOptions,
  "replacementCount" | "serviceReconnectCount" | "taskCycleCount" | "windowCycleCount"
>;

export interface RealRuntimeSkipReport {
  readonly environment: BenchmarkEnvironment;
  readonly evidence: {
    readonly grade: "unavailable";
    readonly productionBrowserTouched: false;
    readonly productionProfileTouched: false;
    readonly signedNative: false;
  };
  readonly input: BenchmarkCounts;
  readonly message?: string;
  readonly reason:
    | "native-ui-opt-in-required"
    | "platform-unsupported"
    | "runtime-root-not-provided"
    | "runtime-root-not-found"
    | "runtime-verification-failed"
    | "electron-runtime-not-found"
    | "electron-runtime-invalid"
    | "electron-launch-returned-no-pid";
  readonly runtime?: RuntimeIdentity & { readonly signedNative: true };
  readonly schemaVersion: 2;
  readonly status: "skipped";
  readonly timestamp: string;
}

export type ProcessExit =
  | {
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly timedOut: boolean;
    }
  | { readonly error: Error; readonly timedOut: boolean };

export interface RealRuntimeReport {
  readonly chromeNativeMessaging: {
    readonly reason: "no-owned-disposable-extension-instance";
    readonly status: "unavailable";
  };
  readonly diagnostics: { readonly stderr: readonly string[]; readonly stdout: readonly string[] };
  readonly environment: BenchmarkEnvironment & {
    readonly electron: string;
    // The fixture subprocess's JSON is retained without claiming it has been validated.
    readonly electronVersion: unknown;
    readonly node: string;
  };
  readonly evidence: {
    readonly grade: "signed-runtime-and-electron" | "signed-runtime-mixed-host";
    readonly productionBrowserTouched: false;
    readonly productionProfileTouched: false;
    readonly signedNative: true;
  };
  readonly input: BenchmarkCounts;
  readonly memory: {
    readonly rejectedProcesses: readonly {
      readonly actualExecutablePath: string;
      readonly expectedExecutablePath: string;
      readonly pid: number;
      readonly reason: "executable-or-ownership-mismatch";
      readonly stage: string;
    }[];
    readonly samples: readonly (ResourceSample & {
      readonly capturedAt: string;
      readonly processes: readonly (ResourceSample["processes"][number] & {
        readonly executablePath: string;
        readonly footprintPeakBytes?: number;
        readonly footprintUnavailable?: {
          readonly message?: string;
          readonly reason: "unparseable-output" | "footprint-command-failed";
          readonly status: "unavailable";
        };
        readonly ownership: ProcessOwnership;
        readonly pid: number;
        readonly ppid: number;
        readonly signature: CodeSignature;
      })[];
    })[];
    readonly summaryByRole: ResourceSummaries;
    readonly unavailableProcesses: readonly {
      readonly pid: number;
      readonly processCommand: string;
      readonly reason: "executable-unavailable-during-sample";
      readonly stage: string;
      readonly state: string;
    }[];
  };
  readonly processOwnership: {
    readonly electron: {
      readonly executablePath: string;
      readonly signature: CodeSignature & { readonly inspectedPath: string };
    };
    readonly leakedAfterExit: readonly { readonly executablePath: string; readonly pid: number }[];
    readonly mainPid: number;
    readonly verifiedProcesses: readonly {
      readonly executablePath: string;
      readonly ownership: ProcessOwnership;
      readonly pid: number;
      readonly role: string;
      readonly signature: CodeSignature | null;
    }[];
  };
  readonly runtime: RuntimeIdentity & {
    readonly browserPluginVersion: BrowserRuntimeManifest["browserPlugin"]["version"];
    readonly chromeHost: {
      readonly executablePath: string;
      readonly sha256: string;
      readonly signature: Extract<CodeSignature, { status: "verified" }>;
      readonly status: "verified-not-launched";
    };
    readonly computerUse: BrowserRuntimeManifest["capabilities"]["computerUse"]["status"];
    readonly runtimeVersions: BrowserRuntimeManifest["runtimeVersions"];
    readonly skyNativeAddon: {
      readonly executablePath: string;
      readonly expectedExportCount: number;
      readonly sha256: string;
      readonly signature: Extract<CodeSignature, { status: "verified" }>;
    };
    readonly targetArch: BrowserRuntimeManifest["targetArch"];
    readonly targetPlatform: BrowserRuntimeManifest["targetPlatform"];
  };
  readonly schemaVersion: 2;
  readonly status: "failed" | "partial" | "passed";
  readonly teardown: {
    readonly nativeStateReturnedToBaseline: boolean;
    readonly processTreeReturnedToBaseline: boolean;
  };
  readonly timestamp: string;
  readonly transport: { readonly exit: ProcessExit; readonly fixtureFailure: unknown };
  readonly workloads: unknown;
}

export function parseRealRuntimeOptions(argv?: readonly string[]): RealRuntimeOptions;
export function parseFootprintOutput(output: string): Footprint | null;
export function parseProcessTable(output: string): ProcessRecord[];
export function classifyElectronProcess(
  record: Pick<ProcessRecord, "command" | "pid"> & Partial<Omit<ProcessRecord, "command" | "pid">>,
  mainPid: number,
): ElectronProcessRole;
export function summarizeResourceSamples(samples: readonly ResourceSample[]): ResourceSummaries;
export function classifyRealRuntimeStatus(input: {
  readonly hardGatePassed: boolean;
  readonly nativeHostPassed: boolean;
  readonly workloadStatuses: readonly (string | null | undefined)[];
}): RealRuntimeReport["status"];
export function runRealRuntimeBenchmark(
  input: RealRuntimeOptions,
): Promise<RealRuntimeSkipReport | RealRuntimeReport>;
