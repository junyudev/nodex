import { readFileSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import path from "node:path";

import { releaseDownloadUrl, STABLE_DOWNLOAD_TARGETS } from "../../src/shared/release-download";
import { readReleaseDistributionBundle } from "./github-release";
import { compareBuildVersions, normalizeAppleBuildVersion, sha256File } from "./model";
import { parseAppcastXml, verifySparkleAppcastContract } from "./sparkle-appcast-contract";
import { RELEASE_ARCHITECTURES } from "./targets";
import { parseWindowsArchitectureUpdateManifest } from "./windows-updates";
import { sha256Bytes, type ReleaseBucket } from "./r2";
import { stableReleasePointer } from "./r2-publication";
import { parseSparkleArchitectureUpdateManifest } from "./sparkle-manifest";

const SPARKLE_NAMESPACE = "http://www.andymatuschak.org/xml-namespaces/sparkle";

function latestVersionInAppcast(xml: string): string {
  const document = parseAppcastXml(xml, "Existing Sparkle appcast");
  const items = document.getElementsByTagName("item");
  let latest: string | null = null;
  for (let index = 0; index < items.length; index += 1) {
    const item = items.item(index);
    if (!item) continue;
    const buildVersion = item
      .getElementsByTagNameNS(SPARKLE_NAMESPACE, "version")
      .item(0)
      ?.textContent?.trim();
    const version = normalizeAppleBuildVersion(buildVersion || "");
    if (latest === null || compareBuildVersions(version, latest) > 0) latest = version;
  }
  if (latest === null) throw new Error("Existing Sparkle appcast has no update items.");
  return latest;
}

const assertFeedDoesNotMoveBackwards = (options: {
  readonly candidateSha256: string;
  readonly candidateBuildVersion: string;
  readonly existingBytes: Uint8Array;
}): void => {
  const existingVersion = latestVersionInAppcast(new TextDecoder().decode(options.existingBytes));
  const order = compareBuildVersions(options.candidateBuildVersion, existingVersion);
  if (order < 0) {
    throw new Error(
      `Sparkle feed cannot move build ${existingVersion} back to ${options.candidateBuildVersion}.`,
    );
  }
  if (order === 0 && sha256Bytes(options.existingBytes) !== options.candidateSha256) {
    throw new Error(`Sparkle feed ${existingVersion} already exists with different bytes.`);
  }
};

const readBundleInputs = (bundlePath: string, windowsPublicKey?: string) => {
  const { bundle, root } = readReleaseDistributionBundle(bundlePath, windowsPublicKey);
  const updates = RELEASE_ARCHITECTURES.map((architecture) => {
    const name = `Nodex-${bundle.version}-update-${architecture}.json`;
    const updatePath = path.join(root, name);
    const value: unknown = JSON.parse(readFileSync(updatePath, "utf8"));
    const update =
      architecture === "arm64"
        ? parseSparkleArchitectureUpdateManifest(value)
        : parseWindowsArchitectureUpdateManifest(value);
    const asset = bundle.assets.find((candidate) => candidate.name === name);
    const appcastAsset = bundle.assets.find((candidate) => candidate.name === update.appcast.name);
    const fullAsset = bundle.assets.find((candidate) => candidate.name === update.full.name);
    const deltaAssets = new Map(
      bundle.assets
        .filter(
          (candidate) =>
            candidate.architecture === architecture && candidate.role === "sparkle-delta",
        )
        .map((candidate) => [candidate.name, candidate]),
    );
    if (
      !asset ||
      asset.architecture !== architecture ||
      asset.role !== "sparkle-update-manifest" ||
      sha256File(updatePath) !== asset.sha256 ||
      update.architecture !== architecture ||
      update.sourceSha !== bundle.sourceSha ||
      update.channel !== bundle.releaseIdentity.channel ||
      update.target.buildVersion !== bundle.releaseIdentity.buildVersion ||
      update.tag !== bundle.tag ||
      update.target.version !== bundle.version ||
      !appcastAsset ||
      appcastAsset.architecture !== architecture ||
      appcastAsset.role !== "sparkle-appcast" ||
      appcastAsset.bytes !== update.appcast.bytes ||
      appcastAsset.sha256 !== update.appcast.sha256 ||
      !fullAsset ||
      fullAsset.architecture !== architecture ||
      fullAsset.role !== (architecture === "arm64" ? "sparkle-full" : "windows-installer") ||
      fullAsset.bytes !== update.full.bytes ||
      fullAsset.sha256 !== update.full.sha256 ||
      update.deltas.some((delta) => {
        const deltaAsset = deltaAssets.get(delta.name);
        return (
          !deltaAsset || deltaAsset.bytes !== delta.bytes || deltaAsset.sha256 !== delta.sha256
        );
      }) ||
      deltaAssets.size !== update.deltas.length
    ) {
      throw new Error(`${architecture} update manifest is not bound by the Release Bundle.`);
    }
    const appcastPath = path.join(root, update.appcast.name);
    const bytes = readFileSync(appcastPath);
    if (sha256Bytes(bytes) !== update.appcast.sha256) {
      throw new Error(`${architecture} appcast snapshot does not match its update manifest.`);
    }
    verifySparkleAppcastContract(bytes.toString("utf8"), update);

    return { bytes, architecture, update };
  });
  return { bundle, updates };
};

export async function publishAppcastsToR2(options: {
  readonly bucket: ReleaseBucket;
  readonly bundlePath: string;
  readonly windowsPublicKey?: string;
}) {
  const { bundle, updates } = readBundleInputs(options.bundlePath, options.windowsPublicKey);
  const feeds = await Promise.all(
    updates.map(async ({ bytes, architecture, update }) => {
      const { feedPath, sha256 } = update.appcast;
      const existing = await options.bucket.getMutable(feedPath);
      if (existing) {
        assertFeedDoesNotMoveBackwards({
          candidateSha256: sha256,
          candidateBuildVersion: update.target.buildVersion,
          existingBytes: existing.bytes,
        });
      }
      return { bytes, existing, architecture, path: feedPath, sha256 };
    }),
  );
  // Validate all the existing feeds before updating any architecture.
  for (const { bytes, existing, path } of feeds) {
    await options.bucket.putMutable(path, bytes, "application/xml", existing);
  }
  return {
    tag: bundle.tag,
    feeds: feeds.map(({ architecture, path, sha256 }) => ({ architecture, path, sha256 })),
  };
}

const verifyEnclosure = async (
  fetchRequest: typeof fetch,
  url: string,
  bytes: number,
): Promise<void> => {
  const response = await fetchRequest(url, {
    method: "HEAD",
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Sparkle enclosure returned HTTP ${response.status}: ${url}`);
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) !== bytes) {
    throw new Error(`Sparkle enclosure size mismatch for ${url}.`);
  }
};

const fetchSha256 = async (fetchRequest: typeof fetch, url: string): Promise<string> => {
  const response = await fetchRequest(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Sparkle appcast returned HTTP ${response.status}: ${url}`);
  }
  return sha256Bytes(new Uint8Array(await response.arrayBuffer()));
};

const verifyStableRedirect = async (
  fetchRequest: typeof fetch,
  target: string,
  expected: string,
): Promise<void> => {
  const response = await fetchRequest(`https://nodex.jyu.app/dl/${target}`, {
    method: "HEAD",
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  const location = response.headers.get("location");
  if (response.status !== 302 || location !== expected) {
    throw new Error(
      `Stable ${target} download expected HTTP 302 to ${expected}; received HTTP ${response.status} to ${location ?? "no location"}.`,
    );
  }
};

export async function verifyPublishedAppcasts(options: {
  readonly attempts?: number;
  readonly bundlePath: string;
  readonly delayMs?: number;
  readonly fetchRequest?: typeof fetch;
  readonly windowsPublicKey?: string;
}): Promise<void> {
  const { bundle, updates } = readBundleInputs(options.bundlePath, options.windowsPublicKey);
  const fetchRequest = options.fetchRequest ?? fetch;
  const pointer = bundle.releaseIdentity.channel === "stable" ? stableReleasePointer(bundle) : null;
  const attempts = options.attempts ?? 12;
  const delayMs = options.delayMs ?? 10_000;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      for (const { architecture, update } of updates) {
        const feedUrl = `https://nodex.jyu.app/${update.appcast.feedPath}`;
        const cacheBustedSha256 = await fetchSha256(
          fetchRequest,
          `${feedUrl}?release=${encodeURIComponent(bundle.tag)}&attempt=${attempt}`,
        );
        const canonicalSha256 = await fetchSha256(fetchRequest, feedUrl);
        if (
          cacheBustedSha256 !== update.appcast.sha256 ||
          canonicalSha256 !== update.appcast.sha256
        ) {
          throw new Error(`${architecture} published appcast does not match the Release Bundle.`);
        }
        await verifyEnclosure(fetchRequest, update.full.url, update.full.bytes);
        for (const delta of update.deltas)
          await verifyEnclosure(fetchRequest, delta.url, delta.bytes);
      }
      if (pointer) {
        await Promise.all(
          STABLE_DOWNLOAD_TARGETS.map((target) =>
            verifyStableRedirect(
              fetchRequest,
              target,
              releaseDownloadUrl(pointer.tag, pointer.installers[target]),
            ),
          ),
        );
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await wait(delayMs);
    }
  }
  throw new Error(
    `Published update feeds and downloads did not converge: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    { cause: lastError },
  );
}
