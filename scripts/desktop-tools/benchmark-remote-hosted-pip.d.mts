export const DEFAULT_REPLACEMENT_COUNT: 1000;
export const DEFAULT_TASK_CYCLE_COUNT: 100;

export interface LatencySummary {
  readonly count: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
}

export interface StateMemorySample {
  readonly arrayBuffersBytes: number;
  readonly externalBytes: number;
  readonly heapUsedBytes: number;
  readonly rssBytes: number;
  readonly stage: string;
}

export interface WindowOwnershipSnapshot {
  readonly auxiliaryWindowCount: number;
  readonly listenerCount: number;
  readonly primaryWindowCount: number;
  readonly registryEntryCount: number;
}

export interface StateBenchmarkReport {
  readonly benchmarks: {
    readonly resourceGovernor: {
      readonly lifecycle: LatencySummary;
      readonly limits: {
        readonly maximumDecodedBytesPerProcess: number;
        readonly maximumPresentationsPerProcess: number;
      };
      readonly replacement: LatencySummary;
      readonly retained: {
        readonly finalDecodedBytes: number;
        readonly finalPresentationCount: number;
        readonly peakDecodedBytes: number;
        readonly peakPresentationCount: number;
      };
    };
    readonly runtimeProjection: {
      readonly lifecycle: LatencySummary;
      readonly memorySamples: readonly (StateMemorySample & {
        readonly activeTaskCount: number;
        readonly fakeNativePresentationCount: number;
        readonly retainedPresentationCount: number;
      })[];
      readonly nativeFake: {
        readonly finalPresentationCount: number;
        readonly invalidationCount: number;
        readonly peakPresentationCount: number;
        readonly upsertCount: number;
      };
      readonly replacement: LatencySummary;
      readonly retained: {
        readonly activeBeforeHostRetirement: number;
        readonly finalActiveTaskCount: number;
        readonly finalPresentationCount: number;
        readonly peakPresentationCount: number;
      };
    };
  };
  readonly environment: {
    readonly arch: string;
    readonly node: string;
    readonly platform: NodeJS.Platform;
    readonly release: string;
  };
  readonly evidence: {
    readonly doesNotProve: readonly string[];
    readonly grade: "state-only";
    readonly productionBrowserTouched: false;
    readonly productionWindowTouched: false;
    readonly proves: readonly string[];
    readonly requiredExternalGates: readonly string[];
    readonly signedNative: false;
  };
  readonly isolation: {
    readonly acceptedLocalCodexOccurrences: number;
    readonly activeTaskIds: readonly string[];
    readonly attemptedOccurrences: number;
    readonly rejectedNonLocalOccurrences: number;
  };
  readonly memory: {
    readonly heapUsedDeltaBytes: number;
    readonly peakRssBytes: number;
    readonly rssDeltaBytes: number;
    readonly samples: readonly StateMemorySample[];
  };
  readonly replacementCount: number;
  readonly schemaVersion: 1;
  readonly status: "passed";
  readonly taskCycleCount: number;
  readonly timestamp: string;
  readonly windowOwnership: {
    readonly afterTeardown: WindowOwnershipSnapshot;
    readonly beforeTeardown: WindowOwnershipSnapshot;
  };
}

export function percentile(samples: readonly number[], fraction: number): number;
export function summarize(samples: readonly number[]): LatencySummary;
export function runStateBenchmark(input?: {
  readonly replacementCount?: number;
  readonly taskCycleCount?: number;
}): Promise<StateBenchmarkReport>;
export function resolveOutputPath(argv?: readonly string[], now?: Date): string;
export function main(argv?: readonly string[]): Promise<void>;
