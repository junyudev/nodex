import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { BROWSER_RUNTIME_SCHEMA_VERSION } from "../src/shared/browser-runtime-metadata";
import type { BrowserRuntimeReleaseAsset } from "./browser-runtime-release-lock";

/** Project the exact published macOS manifest into the current staging format. */
export function projectPublishedMacBrowserRuntimeManifest(
  manifestPath: string,
  asset: BrowserRuntimeReleaseAsset,
): void {
  if (!asset.archiveManifestSha256) return;
  const bytes = readFileSync(manifestPath);
  if (createHash("sha256").update(bytes).digest("hex") !== asset.archiveManifestSha256) {
    throw new Error("Published macOS Desktop Tool manifest does not match the archive lock");
  }
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest.schemaVersion !== 7 || manifest.targetPlatform !== "darwin") {
    throw new Error("Unexpected published macOS Desktop Tool manifest format");
  }
  const { peerAuthorization, ...projected } = manifest;
  const computerUse = projected.capabilities.computerUse;
  const chrome = projected.capabilities.browserUse.backends.chrome;
  const trust = {
    ...peerAuthorization,
    ...(computerUse.status === "available"
      ? { computerUseSigningTeamId: computerUse.signingTeamId }
      : {}),
    ...(chrome.status === "available"
      ? { chromeSigningTeamId: chrome.nativeHost.signingTeamId }
      : {}),
  };
  if (computerUse.status === "available") delete computerUse.signingTeamId;
  if (chrome.status === "available") delete chrome.nativeHost.signingTeamId;
  projected.schemaVersion = BROWSER_RUNTIME_SCHEMA_VERSION;
  writeFileSync(manifestPath, JSON.stringify({ ...projected, trust }, null, 2) + "\n");
}
