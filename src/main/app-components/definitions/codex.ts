import codexLock from "../../../../resources/agent-runtime/codex-app-server.lock.json";
import type { AppComponentDefinition, AppComponentTargetKey } from "../AppComponentCatalog";

export const codexSeedArtifactSizes = codexLock.builds["darwin-arm64"].artifactSizes;

export function codexDefinition(target: AppComponentTargetKey) {
  const asset = codexLock.builds[target];
  return {
    id: "codex",
    install: "on-first-use",
    unpackedBytes: asset.unpackedSize,
    archive: {
      assetName: asset.assetName,
      url: asset.url,
      size: asset.archiveSize,
      sha256: asset.archiveSha256,
    },
    payload: {
      kind: "codex",
      metadataSha256: asset.runtimeMetadataSha256,
      entrypointSha256: asset.entrypointSha256,
    },
  } as const satisfies AppComponentDefinition;
}
