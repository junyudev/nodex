import type { Rectangle } from "electron";
import type {
  RemoteHostedPipNativeAvailability,
  RemoteHostedPipNativeEvent,
  RemoteHostedPipNativeLayoutState,
} from "../../src/main/platform/electron/RemoteHostedPipNativePlatform.js";

export interface ProbeArguments {
  readonly allowNativeUi: boolean;
  readonly capture: boolean;
  readonly electronExecutable: string | null;
  readonly fixture: boolean;
  readonly manifestPath: string | null;
  readonly outputDirectory: string | null;
  readonly resultPath: string | null;
  readonly runtimeRoot: string | null;
}

export interface SerializedError {
  readonly message: string;
  readonly name: string;
}

export interface NativeOperationEvidence {
  readonly durationMs?: number;
  readonly error?: SerializedError;
  readonly name: string;
  readonly status: "success" | "failure";
  readonly value: boolean | readonly string[] | RemoteHostedPipNativeLayoutState;
}

export interface NativeWindowRow {
  readonly id: number;
  readonly name: string;
  readonly bounds?: Partial<Rectangle>;
  readonly [metadata: string]: unknown;
}

export interface NativeLayerEvidence {
  readonly class?: string;
  readonly cornerRadius?: number;
  readonly frame?: Partial<Rectangle>;
  readonly masksToBounds?: boolean;
  readonly name?: string;
  readonly sublayers?: readonly NativeLayerEvidence[];
  readonly [metadata: string]: unknown;
}

export interface NativeWindowIntrospection {
  readonly class?: string;
  readonly classChain?: readonly string[];
  readonly contentLayerTree?: NativeLayerEvidence;
  readonly contentViewTree?: {
    readonly class?: string;
    readonly classChain?: readonly string[];
    readonly [metadata: string]: unknown;
  };
  readonly frame?: Partial<Rectangle>;
  readonly isOpaque?: boolean;
  readonly isPanel?: boolean;
  readonly isVisible?: boolean;
  readonly parentWindowNumber?: number | null;
  readonly title?: string;
  readonly windowNumber?: number;
  readonly [metadata: string]: unknown;
}

export interface NativeWindowStage {
  readonly browserWindowIds?: readonly number[];
  readonly captures?: readonly {
    readonly bytes: number;
    readonly destination: string;
    readonly error: string | null;
    readonly windowId: number;
  }[];
  readonly enumerationError?: string | null;
  readonly name: string;
  readonly nativeIntrospectionError?: string | null;
  readonly nativeIntrospectionRows?: readonly NativeWindowIntrospection[];
  readonly nativePanelCandidates?: number;
  readonly nativeRows?: readonly NativeWindowRow[];
  readonly rows?: readonly NativeWindowRow[];
}

/** Classification accepts incomplete evidence from failed fixture processes. */
export interface NativeFixtureEvidence {
  readonly availability?: Pick<RemoteHostedPipNativeAvailability, "status"> | null;
  readonly events?: readonly { readonly at: string; readonly event: RemoteHostedPipNativeEvent }[];
  readonly fatalError?: SerializedError;
  readonly fixturePid?: number;
  readonly operations?: readonly NativeOperationEvidence[];
  readonly platform?: NodeJS.Platform;
  readonly processArch?: string;
  readonly reduceMotion?: {
    readonly effectiveAnimatedRegistration: boolean;
    readonly systemPreference: boolean | null;
    readonly toggledByHarness: boolean;
  };
  readonly schemaVersion?: 1;
  readonly scopeCloseError?: SerializedError;
  readonly teardown?: {
    readonly hostStopped?: boolean;
    readonly scopeClosed?: boolean;
    readonly windowsDestroyed?: boolean;
  };
  readonly userDataPath?: string;
  readonly windowEvidence?: {
    readonly captureEnabled?: boolean;
    readonly stages?: readonly NativeWindowStage[];
  };
}

export interface NativeRuntimeProvenance {
  readonly addon: {
    readonly architecture: string;
    readonly bytes: number;
    // This inspector reads raw manifest metadata; only checksum/signature evidence is verified.
    readonly expectedSha256: unknown;
    readonly hashVerified: boolean;
    readonly path: string;
    readonly sha256: string;
    readonly signatureDetails: readonly string[];
    readonly signatureVerified: boolean;
    readonly signingTeamId: string | null;
  };
  readonly manifest: {
    readonly browserPluginVersion: unknown;
    readonly desktopBuild: unknown;
    readonly desktopBuildNumber: unknown;
    readonly path: string;
    readonly schemaVersion: unknown;
    readonly sha256: string;
    readonly targetArch: unknown;
    readonly targetPlatform: unknown;
  };
  readonly runtimeRoot: string;
}

export interface NativeHostIdentity {
  readonly authority: string | null;
  readonly developerIdVerified: boolean;
  readonly executablePath: string;
  readonly inspectedBundlePath: string;
  readonly signatureVerified: boolean;
  readonly signingTeamId: string | null;
}

export interface NativeWindowAssertions {
  readonly avatarHostWindowObserved: boolean;
  readonly avatarWindowNumber: number | null;
  readonly calayerHierarchyObserved: boolean;
  readonly completionEffectLayerObserved: boolean;
  readonly contentImageLayerContractObserved: boolean;
  readonly controlsLayerContractObserved: boolean;
  readonly nativePanelClassObserved: boolean;
  readonly nativePanelWindowIds: readonly number[];
  readonly nativePanelsDetachedAndHiddenAfterStop: boolean;
  readonly nativePanelsParentedToOwner: boolean;
  readonly nativePanelsRemovedAfterStop: boolean;
  readonly nativePanelsStayedOnPrimaryWithAvatarObserved: boolean;
  readonly nativeWindowPairCoLocated: boolean;
  readonly nativeWindowPairObserved: boolean;
  readonly nativeWindowsFollowedOwner: boolean;
  readonly ownerWindowNumber: number | null;
  readonly panelHierarchyObserved: boolean;
  readonly pipStackContentHierarchyObserved: boolean;
  readonly processWindowsReturnedToBaseline: boolean;
}

export interface NativeEvidenceClassification {
  readonly activeTaskStateObserved: boolean;
  readonly dynamicPathPassed: boolean;
  readonly evidenceGrade:
    | "signed-addon-and-host-window-observed"
    | "signed-addon-unsigned-host-window-observed"
    | "signed-addon-and-host-api-observed"
    | "signed-addon-unsigned-host-api-observed"
    | "signed-addon-and-host-partial"
    | "signed-addon-unsigned-host-partial"
    | "unverified-runtime";
  readonly failedOperations: readonly string[];
  readonly failedAssertions: readonly string[];
  readonly hostStartAccepted: boolean;
  readonly motionAssertions: {
    readonly nativeTransitionMode:
      | "read-only-reduced-motion-input"
      | "read-only-standard-motion-input"
      | "system-preference-unavailable";
    readonly reduceMotionInputPolicyPassed: boolean;
    readonly systemPreference: boolean | null;
    readonly toggledByHarness: boolean;
  };
  readonly nativeWindowsObserved: boolean;
  readonly presentationObserved: boolean;
  readonly primaryLayoutObserved: boolean;
  readonly processWindowsReturnedToBaseline: boolean;
  readonly signedHost: boolean;
  readonly signedRuntime: boolean;
  readonly status: "passed" | "partial";
  readonly teardownPassed: boolean;
  readonly windowAssertions: NativeWindowAssertions;
}

export interface NativeProbeReport {
  readonly classification: NativeEvidenceClassification;
  readonly evidence: {
    readonly doesNotProve: readonly string[];
    readonly observableBlockers: readonly string[];
    readonly productionBrowserTouched: false;
    readonly productionNodexTouched: false;
    readonly productionWindowTouched: false;
    readonly proves: readonly string[];
    readonly tier: "signed-native-disposable-host";
  };
  // The child process's JSON result is retained without validating it as a typed fixture.
  readonly fixture: unknown;
  readonly fixtureProcess: {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly timedOut: boolean;
    readonly hostIdentity: NativeHostIdentity;
    readonly stderr: string;
    readonly stdout: string;
  };
  readonly outputDirectory: string;
  readonly provenance: NativeRuntimeProvenance;
  readonly schemaVersion: 2;
  readonly timestamp: string;
}

export function parseProbeArguments(argv?: readonly string[]): ProbeArguments;
export function assertNativeUiOptIn(arguments_: Pick<ProbeArguments, "allowNativeUi">): void;
export function nativeProbeExitCode(
  report:
    | { readonly classification?: Pick<NativeEvidenceClassification, "dynamicPathPassed"> | null }
    | null
    | undefined,
): 0 | 1;
export function inspectNativeRuntime(runtimeRootInput?: string): Promise<NativeRuntimeProvenance>;
export function deriveNativeWindowAssertions(
  fixtureReport: NativeFixtureEvidence,
): NativeWindowAssertions;
export function classifyNativeEvidence(
  fixtureReport: NativeFixtureEvidence,
  provenance: {
    readonly addon: Pick<NativeRuntimeProvenance["addon"], "hashVerified" | "signatureVerified">;
  },
  hostIdentity?: Pick<NativeHostIdentity, "developerIdVerified"> | null,
): NativeEvidenceClassification;
export function runNativeProbe(arguments_?: ProbeArguments): Promise<NativeProbeReport>;
