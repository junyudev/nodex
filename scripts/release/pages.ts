import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { DOMParser } from "@xmldom/xmldom";

import { parseReleaseBundleManifest } from "./bundle";
import { releaseAssetPaths } from "./github-release";
import { compareBuildVersions, normalizeAppleBuildVersion, sha256File } from "./model";
import { verifySparkleAppcastContract } from "./sparkle-appcast-contract";
import { parseSparkleArchitectureUpdateManifest } from "./sparkle-manifest";

const wait = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};

const SPARKLE_NAMESPACE = "http://www.andymatuschak.org/xml-namespaces/sparkle";

export function latestVersionInAppcast(xml: string): string {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  if (document.getElementsByTagName("parsererror").length > 0) {
    throw new Error("Existing Sparkle appcast is invalid XML.");
  }
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

const assertProjectionDoesNotMoveFeedBackwards = (options: {
  readonly candidateSha256: string;
  readonly candidateBuildVersion: string;
  readonly existingPath: string;
}): void => {
  if (!existsSync(options.existingPath)) return;
  const metadata = lstatSync(options.existingPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Existing Sparkle feed must be a regular file: ${options.existingPath}`);
  }
  const existingVersion = latestVersionInAppcast(readFileSync(options.existingPath, "utf8"));
  const order = compareBuildVersions(options.candidateBuildVersion, existingVersion);
  if (order < 0) {
    throw new Error(
      `Sparkle feed projection cannot move build ${existingVersion} back to ${options.candidateBuildVersion}.`,
    );
  }
  if (order === 0 && sha256File(options.existingPath) !== options.candidateSha256) {
    throw new Error(`Sparkle feed ${existingVersion} already exists with different bytes.`);
  }
};

const readBundleInputs = (bundlePath: string) => {
  const resolvedBundle = path.resolve(bundlePath);
  const root = path.dirname(resolvedBundle);
  releaseAssetPaths(resolvedBundle);
  const bundle = parseReleaseBundleManifest(
    JSON.parse(readFileSync(resolvedBundle, "utf8")) as unknown,
  );
  const updates = (["arm64"] as const).map((architecture) => {
    const name = `Nodex-${bundle.version}-update-${architecture}.json`;
    const updatePath = path.join(root, name);
    const update = parseSparkleArchitectureUpdateManifest(
      JSON.parse(readFileSync(updatePath, "utf8")) as unknown,
    );
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
      update.tag !== bundle.tag ||
      update.target.version !== bundle.version ||
      !appcastAsset ||
      appcastAsset.architecture !== architecture ||
      appcastAsset.role !== "sparkle-appcast" ||
      appcastAsset.bytes !== update.appcast.bytes ||
      appcastAsset.sha256 !== update.appcast.sha256 ||
      !fullAsset ||
      fullAsset.architecture !== architecture ||
      fullAsset.role !== "sparkle-full" ||
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
    if (sha256File(appcastPath) !== update.appcast.sha256) {
      throw new Error(`${architecture} appcast snapshot does not match its update manifest.`);
    }
    verifySparkleAppcastContract(readFileSync(appcastPath, "utf8"), update);
    return { appcastPath, architecture, update };
  });
  return { bundle, updates };
};

export function projectReleaseAppcasts(options: {
  readonly bundlePath: string;
  readonly existingSiteDirectory?: string;
  readonly siteDirectory: string;
}): {
  readonly bundleSha256: string;
  readonly feeds: readonly {
    readonly architecture: "arm64";
    readonly path: string;
    readonly sha256: string;
  }[];
  readonly tag: string;
} {
  const { bundle, updates } = readBundleInputs(options.bundlePath);
  const site = path.resolve(options.siteDirectory);
  for (const { appcastPath, update } of updates) {
    const destination = path.join(site, ...update.appcast.feedPath.split("/"));
    if (options.existingSiteDirectory) {
      assertProjectionDoesNotMoveFeedBackwards({
        candidateSha256: update.appcast.sha256,
        candidateBuildVersion: update.target.buildVersion,
        existingPath: path.join(
          path.resolve(options.existingSiteDirectory),
          ...update.appcast.feedPath.split("/"),
        ),
      });
    }
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(appcastPath, destination);
    if (sha256File(destination) !== update.appcast.sha256) {
      throw new Error(`Projected ${update.architecture} appcast changed bytes.`);
    }
  }
  return {
    bundleSha256: sha256File(path.resolve(options.bundlePath)),
    feeds: updates.map(({ architecture, update }) => ({
      architecture,
      path: update.appcast.feedPath,
      sha256: update.appcast.sha256,
    })),
    tag: bundle.tag,
  };
}

const verifyEnclosure = async (url: string, bytes: number): Promise<void> => {
  const response = await fetch(url, { method: "HEAD", redirect: "follow" });
  if (!response.ok) throw new Error(`Sparkle enclosure returned HTTP ${response.status}: ${url}`);
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) !== bytes) {
    throw new Error(`Sparkle enclosure size mismatch for ${url}.`);
  }
};

const fetchSha256 = async (url: string): Promise<string> => {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Sparkle appcast returned HTTP ${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Buffer.from(digest).toString("hex");
};

export async function verifyPublishedAppcasts(options: {
  readonly attempts?: number;
  readonly bundlePath: string;
  readonly delayMs?: number;
}): Promise<void> {
  const { bundle, updates } = readBundleInputs(options.bundlePath);
  const attempts = options.attempts ?? 12;
  const delayMs = options.delayMs ?? 10_000;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      for (const { architecture, update } of updates) {
        const feedUrl = `https://nodex.jyu.app/${update.appcast.feedPath}`;
        const cacheBustedSha256 = await fetchSha256(
          `${feedUrl}?release=${encodeURIComponent(bundle.tag)}&attempt=${attempt}`,
        );
        const canonicalSha256 = await fetchSha256(feedUrl);
        if (
          cacheBustedSha256 !== update.appcast.sha256 ||
          canonicalSha256 !== update.appcast.sha256
        ) {
          throw new Error(`${architecture} published appcast does not match the Release Bundle.`);
        }
        await verifyEnclosure(update.full.url, update.full.bytes);
        for (const delta of update.deltas) await verifyEnclosure(delta.url, delta.bytes);
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await wait(delayMs);
    }
  }
  throw new Error("Published Sparkle appcasts did not converge before the verification deadline.", {
    cause: lastError,
  });
}
