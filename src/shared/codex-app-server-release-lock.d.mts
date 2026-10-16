export type AgentRuntimeTargetPlatform = "darwin";
export type AgentRuntimeTargetArch = "arm64";
export type AgentRuntimeTargetKey = `${AgentRuntimeTargetPlatform}-${AgentRuntimeTargetArch}`;

export const CODEX_APP_SERVER_REQUIRED_ARTIFACTS: readonly [
  "codex-package.json",
  "bin/codex",
  "bin/codex-code-mode-host",
  "codex-path/rg",
];
export const OFFICIAL_CODEX_MACOS_SIGNING_TEAM_ID: "2DC432GLL2";

export type CodexReleaseTargetKey = "darwin-arm64" | `${"linux" | "win32"}-${"arm64" | "x64"}`;

export interface CodexReleaseArchive {
  archiveSha256: string;
  archiveSize: number;
  assetName: string;
  targetTriple: string;
  url: string;
}

export interface AgentRuntimeBuild extends CodexReleaseArchive {
  entrypointSha256: string;
  runtimeMetadataSha256: string;
}

export interface CodexSchemaToolAsset {
  archiveSha256: string;
  archiveSize: number;
  assetName: string;
  entrypoint: string;
  targetTriple: string;
  url: string;
}

export interface CodexAppServerReleaseLock {
  appServerRuntimeVersion: string;
  builds: Record<CodexReleaseTargetKey, CodexReleaseArchive> &
    Record<AgentRuntimeTargetKey, AgentRuntimeBuild>;
  notices: {
    licensePath: string;
    licenseSha256: string;
    noticePath: string;
    noticeSha256: string;
  };
  packageManifest: {
    entrypoint: string;
    layoutVersion: number;
    pathDir: string;
    resourcesDir: string;
    variant: "codex";
    version: string;
  };
  protocolSchema: {
    experimental: true;
    sha256: string;
    tools: Record<AgentRuntimeTargetKey, CodexSchemaToolAsset>;
  };
  readonly requiredArtifacts: readonly string[];
  runtimeFamily: "codex";
  schemaVersion: 1;
  upstream: {
    checksumManifest: {
      assetName: string;
      sha256: string;
      size: number;
      url: string;
    };
    commit: string;
    repository: "openai/codex";
    signingTeamId: typeof OFFICIAL_CODEX_MACOS_SIGNING_TEAM_ID;
    tag: string;
  };
}

export function parseCodexAppServerReleaseLock(value: unknown): CodexAppServerReleaseLock;
