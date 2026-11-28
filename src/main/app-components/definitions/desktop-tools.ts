import browserRuntimeLock from "../../../../resources/browser-runtime/browser-runtime.lock.json";
import type { AppComponentDefinition, AppComponentTargetKey } from "../AppComponentCatalog";

export function desktopToolsDefinition(target: AppComponentTargetKey): AppComponentDefinition {
  const asset = browserRuntimeLock.assets[target];
  return {
    id: "desktop-tools",
    unpackedBytes: asset.unpackedSize,
    install: "at-startup",
    payload: { kind: "desktop-tools", manifestSha256: asset.manifestSha256 },
    archive: {
      assetName: asset.assetName,
      url: asset.url,
      size: asset.archiveSize,
      sha256: asset.archiveSha256,
    },
  };
}
