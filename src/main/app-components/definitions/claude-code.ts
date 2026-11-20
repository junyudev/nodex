import claudeCodeLock from "../../../../resources/agent-runtime/claude-code.lock.json";
import type { AppComponentDefinition } from "../AppComponentCatalog";

export function claudeCodeDefinition() {
  const asset = claudeCodeLock.assets["darwin-arm64"];
  return {
    id: "claude-code",
    unpackedBytes: asset.unpackedSize,
    install: "on-first-use",
    payload: { kind: "claude-code", executable: asset.executable },
    archive: {
      assetName: new URL(asset.url).pathname.split("/").at(-1)!,
      url: asset.url,
      size: asset.archiveSize,
      sha256: asset.archiveSha256,
    },
  } as const satisfies AppComponentDefinition;
}
