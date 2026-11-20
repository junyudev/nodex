import browserRuntimeLock from "../../../../resources/browser-runtime/browser-runtime.lock.json";
import type { AppComponentDefinition } from "../AppComponentCatalog";

export function desktopToolsDefinition(): AppComponentDefinition {
  const asset = browserRuntimeLock.assets["darwin-arm64"];
  return {
    id: "desktop-tools",
    // The release lock currently records only the compressed length. Budget for the macOS closure.
    unpackedBytes: 768 * 1024 * 1024,
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
