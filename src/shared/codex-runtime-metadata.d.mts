export const AGENT_RUNTIME_LAYOUT_VERSION: 4;
export const AGENT_RUNTIME_METADATA_FILENAME: "agent-runtime.json";

export interface AgentRuntimeArtifact {
  readonly executable: boolean;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface CodexAppServerPackageManifest {
  readonly entrypoint: string;
  readonly layoutVersion: number;
  readonly pathDir: string;
  readonly resourcesDir: string;
  readonly target: string;
  readonly variant: "codex-app-server";
  readonly version: string;
}

export interface BundledAgentRuntimeMetadata {
  readonly appServerRuntimeVersion: string;
  readonly artifacts: readonly AgentRuntimeArtifact[];
  readonly entrypoint: string;
  readonly layoutVersion: 4;
  readonly packageManifest: CodexAppServerPackageManifest;
  readonly protocolSchemaFingerprint: string;
  readonly releaseAsset: {
    readonly archiveSha256: string;
    readonly archiveSize: number;
    readonly assetName: string;
    readonly entrypointSha256: string;
    readonly repository: "openai/codex";
    readonly tag: string;
  };
  readonly runtimeFamily: "codex-app-server";
  readonly searchPaths: readonly string[];
  readonly sourceRevision: {
    readonly commit: string;
    readonly repository: "openai/codex";
    readonly tag: string;
  };
  readonly targetArch: string;
  readonly targetPlatform: string;
  readonly targetTriple: string;
}

export function parseBundledAgentRuntimeMetadata(
  value: unknown,
): BundledAgentRuntimeMetadata | null;

export function canonicalBundledAgentRuntimeMetadataJson(
  metadata: BundledAgentRuntimeMetadata,
): string;
