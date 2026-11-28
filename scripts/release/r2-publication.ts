import { lstatSync } from "node:fs";
import { basename, extname } from "node:path";
import {
  parseStableReleasePointer,
  releaseDownloadUrl,
  releaseObjectKey,
  STABLE_RELEASE_POINTER_KEY,
  type StableReleasePointer,
} from "../../src/shared/release-download";
import type { ReleaseDistributionBundle } from "./bundle";
import { readReleaseDistributionBundle } from "./github-release";
import { compareStableVersions, sha256File } from "./model";
import { type ReleaseBucket, verifyPublicReleaseObject } from "./r2";

const isLatestAlias = (name: string): boolean => name.startsWith("Nodex-latest-");

const contentTypes: Readonly<Record<string, string>> = {
  ".apk": "application/vnd.android.package-archive",
  ".dmg": "application/x-apple-diskimage",
  ".exe": "application/vnd.microsoft.portable-executable",
  ".json": "application/json",
  ".xml": "application/xml",
  ".xz": "application/x-xz",
  SHA256SUMS: "text/plain; charset=utf-8",
};

export function stableReleasePointer(bundle: ReleaseDistributionBundle): StableReleasePointer {
  if (bundle.releaseIdentity.channel !== "stable") throw new Error("Expected a Stable bundle.");
  const dmg = bundle.assets.find(({ name, role }) => role === "dmg" && !isLatestAlias(name));
  const windows = bundle.assets.find(
    ({ name, role, architecture }) =>
      role === "windows-installer" && architecture === "windows-x64" && !isLatestAlias(name),
  );
  if (!dmg || !windows) throw new Error("Stable bundle is missing its versioned installers.");
  return {
    version: 1,
    tag: bundle.tag,
    installers: {
      macos: dmg.name,
      "windows-x64": windows.name,
      android: bundle.mobile.android.artifact.name,
    },
  };
}

const parsePointer = (bytes: Uint8Array): StableReleasePointer =>
  parseStableReleasePointer(JSON.parse(new TextDecoder().decode(bytes)));

export async function publishReleaseBundleToR2(options: {
  readonly bucket: ReleaseBucket;
  readonly bundlePath: string;
  readonly fetchRequest?: typeof fetch;
  readonly windowsPublicKey?: string;
}) {
  const { bucket } = options;
  const { bundle, paths } = readReleaseDistributionBundle(
    options.bundlePath,
    options.windowsPublicKey,
  );
  const pointer = bundle.releaseIdentity.channel === "stable" ? stableReleasePointer(bundle) : null;
  const index = new Map(bundle.assets.map((asset) => [asset.name, asset]));
  const assets = paths
    .filter((filePath) => !isLatestAlias(basename(filePath)))
    .map((filePath) => {
      const name = basename(filePath);
      return {
        filePath,
        name,
        key: releaseObjectKey(bundle.tag, name),
        identity: {
          ...(index.get(name) ?? { bytes: lstatSync(filePath).size, sha256: sha256File(filePath) }),
          contentType: contentTypes[extname(name) || name] ?? "application/octet-stream",
        },
      };
    });

  const uploaded: string[] = [];
  const skipped: string[] = [];
  for (const { key, filePath, name, identity } of assets) {
    const result = await bucket.putImmutableFile(key, filePath, identity);
    (result === "uploaded" ? uploaded : skipped).push(name);
  }
  await Promise.all(
    assets.map(({ name, identity }) =>
      verifyPublicReleaseObject(
        releaseDownloadUrl(bundle.tag, name),
        identity.bytes,
        options.fetchRequest,
      ),
    ),
  );

  if (pointer) {
    const existing = await bucket.getMutable(STABLE_RELEASE_POINTER_KEY);
    const current = existing && parsePointer(existing.bytes);
    if (current && compareStableVersions(bundle.version, current.tag.slice(1)) < 0) {
      throw new Error(
        `Stable download pointer cannot move from ${current.tag} back to ${bundle.tag}.`,
      );
    }
    await bucket.putMutable(
      STABLE_RELEASE_POINTER_KEY,
      new TextEncoder().encode(`${JSON.stringify(pointer)}\n`),
      "application/json",
      existing,
    );
  }
  return { tag: bundle.tag, uploaded, skipped };
}
