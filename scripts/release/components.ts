import { lstatSync, readFileSync } from "node:fs";
import {
  appComponentCatalog,
  type AppComponentDefinition,
} from "../../src/main/app-components/AppComponentCatalog";
import {
  APP_COMPONENT_MANIFEST_MAX_BYTES,
  appComponentManifestSchema,
  type AppComponentManifestTarget,
} from "../../src/shared/app-component-manifest";
import type { WindowsArchitecture } from "../desktop-build-target";
import type { BuildIdentity } from "./model";

type ComponentBuildIdentity = Pick<BuildIdentity, "version" | "buildVersion">;

export function windowsComponentPins(architecture: WindowsArchitecture) {
  return requireWindowsComponentPins(
    appComponentCatalog({ platform: "win32", arch: architecture, isPackaged: true }),
  );
}

export function requireWindowsComponentPins(pins: readonly AppComponentDefinition[]) {
  if (
    pins.length !== 3 ||
    !pins.some(({ id, install }) => id === "desktop-tools" && install === "at-startup") ||
    !pins.some(({ id, install }) => id === "codex" && install === "on-first-use") ||
    !pins.some(({ id, install }) => id === "claude-code" && install === "on-first-use")
  )
    throw new Error("Packaged Windows catalog must pin Desktop Tools, Codex and Claude Code.");
  return pins;
}

function componentManifest(
  { version, buildVersion }: ComponentBuildIdentity,
  target: AppComponentManifestTarget,
  components: readonly AppComponentDefinition[],
) {
  return appComponentManifestSchema.parse({
    schemaVersion: 1,
    target,
    version,
    buildVersion,
    components,
  });
}

export function macComponentManifest(identity: ComponentBuildIdentity) {
  return componentManifest(
    identity,
    "darwin-arm64",
    appComponentCatalog({ platform: "darwin", arch: "arm64", isPackaged: true }),
  );
}

export function windowsComponentManifest(
  identity: ComponentBuildIdentity,
  pins = windowsComponentPins("x64"),
) {
  return componentManifest(identity, "win32-x64", requireWindowsComponentPins(pins));
}

export function readComponentManifest(
  file: string,
  target: AppComponentManifestTarget,
  identity: ComponentBuildIdentity,
) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > APP_COMPONENT_MANIFEST_MAX_BYTES)
    throw new Error("Component manifest must be a bounded regular file.");
  const manifest = appComponentManifestSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (
    manifest.target !== target ||
    manifest.version !== identity.version ||
    manifest.buildVersion !== identity.buildVersion
  )
    throw new Error("Component manifest does not match its architecture build.");
  if (target === "win32-x64") requireWindowsComponentPins(manifest.components);
  return manifest;
}

/** Check the published URL independently of the local immutable cache. */
type DownloadPin = { readonly url: string | null; readonly archiveSize: number };

export async function verifyComponentDownload(
  label: string,
  asset: DownloadPin,
  fetchAsset: typeof fetch = fetch,
): Promise<void> {
  if (!asset.url) throw new Error(`Publish the pinned ${label} archive first.`);
  const signal = AbortSignal.timeout(30_000);
  const head = await fetchAsset(asset.url, { method: "HEAD", signal });
  const length = head.headers.get("content-length");
  if (head.ok && length !== null) {
    if (Number(length) === asset.archiveSize) return;
    throw new Error(
      `Published ${label} archive has ${length} bytes, expected ${asset.archiveSize}.`,
    );
  }
  const range = await fetchAsset(asset.url, { headers: { Range: "bytes=0-0" }, signal });
  const contentRange = range.headers.get("content-range");
  await range.body?.cancel();
  if (range.status !== 206 || contentRange !== `bytes 0-0/${asset.archiveSize}`)
    throw new Error(
      `Published ${label} archive is unavailable or has the wrong size (HTTP ${range.status}).`,
    );
}

export async function verifyWindowsComponentDownloads(
  pins: readonly AppComponentDefinition[],
  fetchAsset?: typeof fetch,
): Promise<void> {
  await Promise.all(
    requireWindowsComponentPins(pins).map(({ id, archive }) =>
      verifyComponentDownload(
        `Windows ${id}`,
        { url: archive.url, archiveSize: archive.size },
        fetchAsset,
      ),
    ),
  );
}
