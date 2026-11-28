import workspaceRuntimeLock from "../../../../resources/workspace-runtime/workspace-runtime.lock.json";
import type { AppComponentDefinition, AppComponentTargetKey } from "../AppComponentCatalog";

export function documentToolsDefinition(
  target: AppComponentTargetKey,
): AppComponentDefinition | null {
  if (target !== "darwin-arm64") return null;
  const asset = workspaceRuntimeLock.release.assets[target];
  if (!asset?.url) return null;
  return {
    id: "document-tools",
    archive: {
      assetName: asset.assetName,
      url: asset.url,
      size: asset.archiveSize,
      sha256: asset.archiveSha256,
    },
    unpackedBytes: asset.unpackedBytes,
    install: "on-first-use",
    payload: { kind: "document-tools", manifestSha256: asset.manifestSha256 },
  };
}
