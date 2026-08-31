export type AppServerRuntimeIdentity = {
  readonly entrypointSha256: string;
  readonly protocolSchemaFingerprint: string;
  readonly runtimeVersion: string;
  readonly sourceCommit: string;
  readonly targetArch: string;
  readonly targetPlatform: string;
};

export type BrowserPeerRuntimeIdentity = {
  readonly browserPluginVersion: string;
  readonly manifestSha256: string;
  readonly peerCliVersion: string;
  readonly targetArch: string;
  readonly targetPlatform: string;
};

export type TestedBrowserAppServerPair = {
  readonly appServer: AppServerRuntimeIdentity;
  readonly browser: BrowserPeerRuntimeIdentity;
};

export const TESTED_BROWSER_APP_SERVER_PAIRS: readonly TestedBrowserAppServerPair[];

export function isTestedBrowserAppServerPair(
  appServer: AppServerRuntimeIdentity,
  browser: BrowserPeerRuntimeIdentity,
  testedPairs?: readonly TestedBrowserAppServerPair[],
): boolean;

export function projectBundledAppServerRuntimeIdentity(metadata: {
  readonly appServerRuntimeVersion: string;
  readonly artifacts: ReadonlyArray<{
    readonly executable: boolean;
    readonly path: string;
    readonly sha256: string;
  }>;
  readonly entrypoint: string;
  readonly releaseAsset: { readonly entrypointSha256: string };
  readonly protocolSchemaFingerprint: string;
  readonly sourceRevision: { readonly commit: string };
  readonly targetArch: string;
  readonly targetPlatform: string;
}): AppServerRuntimeIdentity;

export function projectBrowserPeerRuntimeIdentity(
  metadata: {
    readonly browserPlugin: { readonly version: string };
    readonly runtimeVersions: { readonly codexCli: string };
    readonly targetArch: string;
    readonly targetPlatform: string;
  },
  manifestSha256: string,
): BrowserPeerRuntimeIdentity;
