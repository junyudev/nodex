import {
  AGENT_RUNTIME_LAYOUT_VERSION as layoutVersion,
  AGENT_RUNTIME_METADATA_FILENAME as metadataFilename,
  canonicalBundledAgentRuntimeMetadataJson as canonicalMetadataJson,
  parseBundledAgentRuntimeMetadata as parseMetadata,
} from "./codex-runtime-metadata.mjs";

export const AGENT_RUNTIME_LAYOUT_VERSION = layoutVersion;
export const AGENT_RUNTIME_METADATA_FILENAME = metadataFilename;

export type AgentRuntimeArtifact = {
  executable: boolean;
  path: string;
  sha256: string;
  size: number;
};

export type CodexAppServerPackageManifest = {
  entrypoint: string;
  layoutVersion: number;
  pathDir: string;
  resourcesDir: string;
  target: string;
  variant: "codex-app-server";
  version: string;
};

export type BundledAgentRuntimeMetadata = {
  appServerRuntimeVersion: string;
  artifacts: AgentRuntimeArtifact[];
  entrypoint: string;
  layoutVersion: typeof AGENT_RUNTIME_LAYOUT_VERSION;
  packageManifest: CodexAppServerPackageManifest;
  protocolSchemaFingerprint: string;
  releaseAsset: {
    archiveSha256: string;
    archiveSize: number;
    assetName: string;
    /** Official upstream entrypoint identity bound by the release archive. */
    entrypointSha256: string;
    repository: "openai/codex";
    tag: string;
  };
  runtimeFamily: "codex-app-server";
  searchPaths: string[];
  sourceRevision: {
    commit: string;
    repository: "openai/codex";
    tag: string;
  };
  targetArch: string;
  targetPlatform: string;
  targetTriple: string;
};

export function parseBundledAgentRuntimeMetadata(
  value: unknown,
): BundledAgentRuntimeMetadata | null {
  return parseMetadata(value) as BundledAgentRuntimeMetadata | null;
}

export function canonicalBundledAgentRuntimeMetadataJson(
  metadata: BundledAgentRuntimeMetadata,
): string {
  return canonicalMetadataJson(metadata);
}
