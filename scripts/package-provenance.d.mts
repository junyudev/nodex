import type { TestedBrowserAppServerPair } from "../src/shared/browser-app-server-compatibility.mjs";

export const PACKAGED_BUILD_PROVENANCE_SCHEMA_VERSION: 12;

export interface PackagedCodexIdentity {
  readonly url: string;
  readonly archiveSha256: string;
  readonly archiveSize: number;
  readonly assetName: string;
  readonly entrypointSha256: string;
  readonly lockSha256: string;
  readonly metadataSha256: string;
  readonly protocolSchemaFingerprint: string;
  readonly signingTeamId: "2DC432GLL2";
  readonly sourceCommit: string;
  readonly sourceTag: string;
  readonly targetTriple: string;
  readonly version: string;
}

export interface PackagedBuildProvenance {
  readonly schemaVersion: typeof PACKAGED_BUILD_PROVENANCE_SCHEMA_VERSION;
  readonly codex: PackagedCodexIdentity;
  readonly desktopTools: {
    readonly url: string;
    readonly archiveSha256: string;
    readonly archiveSize: number;
    readonly manifestSha256: string;
  };
  readonly claudeCode: {
    readonly version: string;
    readonly url: string;
    readonly archiveSha256: string;
    readonly archiveSize: number;
    readonly unpackedSize: number;
    readonly executable: { readonly path: string; readonly size: number; readonly sha256: string };
  };
  readonly documentTools: PackagedBuildProvenance["desktopTools"] & {
    readonly assetName: string;
    readonly unpackedBytes: number;
  };
  readonly product: {
    readonly name: string;
    readonly version: string;
  };
  readonly agentSkills: {
    readonly manifestSha256: string;
    readonly treeSha256: string;
  };
  readonly provenanceId: string;
  readonly target: {
    readonly arch: "arm64";
    readonly platform: "darwin";
  };
}

interface PackagedBuildProvenanceOptions {
  readonly testedPairs?: readonly TestedBrowserAppServerPair[];
}

export function writePackagedBuildProvenance(
  appPath: string,
  options?: PackagedBuildProvenanceOptions,
): PackagedBuildProvenance;

export function verifyPackagedBuildProvenance(
  appPath: string,
  options?: PackagedBuildProvenanceOptions & {
    readonly expectedArch?: "arm64";
    readonly expectedPreparedManifestPath?: string;
  },
): PackagedBuildProvenance;
