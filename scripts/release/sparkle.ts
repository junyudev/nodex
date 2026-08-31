import { execFileSync, spawnSync } from "node:child_process";
import { createPublicKey, verify as verifySignature } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DOMParser, XMLSerializer } from "@xmldom/xmldom";

import { materializeSparkleRuntime } from "../materialize-sparkle-runtime";
import {
  compareStableVersions,
  compareBuildVersions,
  buildVersionForMainlineOrdinal,
  normalizeReleaseVersion,
  normalizeAppleBuildVersion,
  sha256File,
  stableVersionFromAppTag,
  tagForReleaseVersion,
  type ReleaseChannel,
} from "./model";
import {
  parseSparkleArchitectureUpdateManifest,
  type SparkleArchitectureUpdateManifest,
  type SparkleDeltaIdentity,
  type SparkleFileIdentity,
} from "./sparkle-manifest";
import type { MacArchitecture } from "./bundle";
import { parseReleaseBundleManifest } from "./bundle";
import { verifySparkleAppcastContract } from "./sparkle-appcast-contract";

const SPARKLE_NAMESPACE = "http://www.andymatuschak.org/xml-namespaces/sparkle";
const PRODUCT_BUNDLE_ID = "app.jyu.nodex";

interface FinalizeSparkleOptions {
  readonly architecture: MacArchitecture;
  readonly channel: ReleaseChannel;
  readonly architectureDirectory: string;
  readonly historyDirectories?: readonly string[];
  readonly outputDirectory: string;
  readonly privateKey: string;
  readonly publishedAt: string;
  readonly releaseNotesPath: string;
  readonly sourceSha: string;
  readonly toolchainDirectory: string;
  readonly version: string;
}

interface AppIdentity {
  readonly appPath: string;
  readonly buildVersion: string;
  readonly bundleId: string;
  readonly packageProvenanceSchema: number;
  readonly publicKey: string;
  readonly runtimePublicKey: string;
  readonly teamIdentifier: string;
  readonly version: string;
}

const ensureEmptyDirectory = (directory: string): void => {
  if (existsSync(directory) && readdirSync(directory).length > 0) {
    throw new Error(`Sparkle output directory must be empty: ${directory}`);
  }
  mkdirSync(directory, { recursive: true });
};

const run = (command: string, args: readonly string[], cwd?: string): string =>
  execFileSync(command, [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();

const runWithPrivateKey = (
  executable: string,
  args: readonly string[],
  privateKey: string,
  cwd?: string,
): string => {
  const result = spawnSync(executable, [...args], {
    cwd,
    encoding: "utf8",
    input: privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `Sparkle tool ${path.basename(executable)} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`,
    );
  }
  return result.stdout.trim();
};

const appAtRoot = (root: string): string => {
  const apps = readdirSync(root, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.endsWith(".app"),
  );
  if (apps.length !== 1) throw new Error(`Expected exactly one app in ${root}.`);
  return path.join(root, apps[0].name);
};

const readAppIdentity = (appPath: string): AppIdentity => {
  const infoPlist = path.join(appPath, "Contents", "Info.plist");
  const readPlist = (key: string): string =>
    run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", infoPlist]);
  const signature = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", appPath], {
    encoding: "utf8",
  });
  if (signature.error || signature.status !== 0) {
    throw new Error(`Could not inspect Sparkle target app signature: ${signature.stderr}`);
  }
  const teamIdentifier = /^TeamIdentifier=(.+)$/mu
    .exec(`${signature.stdout}\n${signature.stderr}`)?.[1]
    ?.trim();
  if (!teamIdentifier || teamIdentifier === "not set") {
    throw new Error("Sparkle target app has no Developer ID Team ID.");
  }
  const provenance = JSON.parse(
    readFileSync(path.join(appPath, "Contents/Resources/nodex-build-provenance.json"), "utf8"),
  ) as { readonly schemaVersion?: unknown };
  const runtime = JSON.parse(
    readFileSync(path.join(appPath, "Contents/Resources/native/sparkle-runtime.json"), "utf8"),
  ) as { readonly publicKey?: unknown };
  if (typeof runtime.publicKey !== "string") {
    throw new Error("Sparkle target app runtime manifest has no public key.");
  }
  return {
    appPath,
    buildVersion: readPlist("CFBundleVersion"),
    bundleId: readPlist("CFBundleIdentifier"),
    packageProvenanceSchema: Number(provenance.schemaVersion),
    publicKey: readPlist("SUPublicEDKey"),
    runtimePublicKey: runtime.publicKey,
    teamIdentifier,
    version: readPlist("CFBundleShortVersionString"),
  };
};

const repositoryRoot = path.resolve(import.meta.dirname, "../..");

const readConfiguredPublicKey = (): string => {
  const publicKey = readFileSync(
    path.join(repositoryRoot, "resources/sparkle/public-key.txt"),
    "utf8",
  ).trim();
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(publicKey) || Buffer.from(publicKey, "base64").length !== 32) {
    throw new Error("Configured Sparkle public key is invalid.");
  }
  return publicKey;
};

const extractZip = (zipPath: string, outputDirectory: string): string => {
  mkdirSync(outputDirectory, { recursive: true });
  run("/usr/bin/ditto", ["-x", "-k", zipPath, outputDirectory]);
  return appAtRoot(outputDirectory);
};

const findFileRecursively = (root: string, name: string): string | null => {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name === name) return entryPath;
    if (entry.isDirectory()) {
      const found = findFileRecursively(entryPath, name);
      if (found) return found;
    }
  }
  return null;
};

const fileIdentity = (filePath: string, url: string, edSignature: string): SparkleFileIdentity => ({
  bytes: statSync(filePath).size,
  edSignature,
  name: path.basename(filePath),
  sha256: sha256File(filePath),
  url,
});

const signFile = (signUpdate: string, filePath: string, privateKey: string): string => {
  const signature = runWithPrivateKey(
    signUpdate,
    ["--ed-key-file", "-", "-p", filePath],
    privateKey,
  );
  if (!/^[A-Za-z0-9+/]{86}==$/u.test(signature)) {
    throw new Error(
      `Sparkle returned an invalid Ed25519 signature for ${path.basename(filePath)}.`,
    );
  }
  return signature;
};

const assertPrivateKeyMatchesPublicKey = (
  signUpdate: string,
  privateKey: string,
  publicKey: string,
): void => {
  const verificationRoot = mkdtempSync(path.join(tmpdir(), "nodex-sparkle-key-verify-"));
  try {
    const sentinelPath = path.join(verificationRoot, "sentinel.txt");
    writeFileSync(sentinelPath, "Nodex Sparkle signing-key verification\n", "utf8");
    const signature = Buffer.from(signFile(signUpdate, sentinelPath, privateKey), "base64");
    const rawPublicKey = Buffer.from(publicKey, "base64");
    const key = createPublicKey({
      format: "der",
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawPublicKey]),
      type: "spki",
    });
    if (!verifySignature(null, readFileSync(sentinelPath), key, signature)) {
      throw new Error("Sparkle private key does not match the configured public key.");
    }
  } finally {
    rmSync(verificationRoot, { force: true, recursive: true });
  }
};

const textFor = (item: Element, localName: string): string | null => {
  const elements = item.getElementsByTagNameNS(SPARKLE_NAMESPACE, localName);
  const text = elements.item(0)?.textContent?.trim();
  return text || null;
};

const directEnclosures = (item: Element): Element[] => {
  const enclosures = item.getElementsByTagName("enclosure");
  const result: Element[] = [];
  for (let index = 0; index < enclosures.length; index += 1) {
    const enclosure = enclosures.item(index);
    if (enclosure && !enclosure.getAttributeNS(SPARKLE_NAMESPACE, "deltaFrom")) {
      result.push(enclosure);
    }
  }
  return result;
};

const normalizedReleaseUrl = (tag: string, name: string): string =>
  `https://github.com/junyudev/nodex/releases/download/${tag}/${encodeURIComponent(name)}`;

const normalizeGeneratedAppcast = (options: {
  readonly appcastPath: string;
  readonly architecture: MacArchitecture;
  readonly buildVersion: string;
  readonly currentFullPath: string;
  readonly privateKey: string;
  readonly publishedAt: string;
  readonly signUpdate: string;
  readonly tag: string;
  readonly version: string;
  readonly workingDirectory: string;
}): { readonly deltas: readonly SparkleDeltaIdentity[]; readonly full: SparkleFileIdentity } => {
  const document = new DOMParser().parseFromString(
    readFileSync(options.appcastPath, "utf8"),
    "application/xml",
  );
  if (document.getElementsByTagName("parsererror").length > 0) {
    throw new Error("Generated Sparkle appcast is invalid XML.");
  }
  const items = document.getElementsByTagName("item");
  let currentItem: Element | null = null;
  const displayVersionByBuildVersion = new Map<string, string>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items.item(index);
    if (!item) continue;
    const shortVersion = textFor(item, "shortVersionString") ?? textFor(item, "version");
    const buildVersion = textFor(item, "version");
    if (shortVersion && buildVersion) displayVersionByBuildVersion.set(buildVersion, shortVersion);
    if (!currentItem && shortVersion === options.version && buildVersion === options.buildVersion) {
      currentItem = item;
    }
  }
  if (!currentItem) throw new Error("Generated appcast does not contain the current release item.");
  const fullEnclosures = directEnclosures(currentItem);
  if (fullEnclosures.length !== 1)
    throw new Error("Current appcast item must contain one full enclosure.");
  const fullName = path.basename(options.currentFullPath);
  const fullUrl = normalizedReleaseUrl(options.tag, fullName);
  const fullSignature = signFile(options.signUpdate, options.currentFullPath, options.privateKey);
  const fullEnclosure = fullEnclosures[0];
  fullEnclosure.setAttribute("url", fullUrl);
  fullEnclosure.setAttribute("length", String(statSync(options.currentFullPath).size));
  fullEnclosure.setAttributeNS(SPARKLE_NAMESPACE, "sparkle:edSignature", fullSignature);

  const pubDates = currentItem.getElementsByTagName("pubDate");
  const pubDate = new Date(options.publishedAt);
  if (Number.isNaN(pubDate.getTime())) throw new Error("Release publishedAt must be an ISO date.");
  if (pubDates.length === 0) {
    const node = document.createElement("pubDate");
    node.appendChild(document.createTextNode(pubDate.toUTCString()));
    currentItem.insertBefore(node, fullEnclosure);
  } else {
    pubDates.item(0)!.textContent = pubDate.toUTCString();
  }

  const deltas: SparkleDeltaIdentity[] = [];
  const enclosures = currentItem.getElementsByTagName("enclosure");
  for (let index = 0; index < enclosures.length; index += 1) {
    const enclosure = enclosures.item(index);
    if (!enclosure) continue;
    const fromBuildVersion = enclosure.getAttributeNS(SPARKLE_NAMESPACE, "deltaFrom");
    if (!fromBuildVersion) continue;
    const fromVersion = displayVersionByBuildVersion.get(fromBuildVersion);
    if (!fromVersion) {
      throw new Error(
        `Generated appcast has no display version for delta source build ${fromBuildVersion}.`,
      );
    }
    const originalUrl = enclosure.getAttribute("url");
    if (!originalUrl) throw new Error("Generated Sparkle delta omits its URL.");
    const originalName = decodeURIComponent(new URL(originalUrl).pathname.split("/").at(-1) ?? "");
    const originalPath = findFileRecursively(options.workingDirectory, originalName);
    if (!originalPath) throw new Error(`Generated Sparkle delta is missing: ${originalName}`);
    const deltaName = `Nodex-${fromVersion}-to-${options.version}-${options.architecture}.delta`;
    const deltaPath = path.join(options.workingDirectory, deltaName);
    if (path.resolve(originalPath) !== path.resolve(deltaPath)) renameSync(originalPath, deltaPath);
    const deltaUrl = normalizedReleaseUrl(options.tag, deltaName);
    const signature = signFile(options.signUpdate, deltaPath, options.privateKey);
    enclosure.setAttribute("url", deltaUrl);
    enclosure.setAttribute("length", String(statSync(deltaPath).size));
    enclosure.setAttributeNS(SPARKLE_NAMESPACE, "sparkle:edSignature", signature);
    deltas.push({
      ...fileIdentity(deltaPath, deltaUrl, signature),
      fromBuildVersion,
      fromVersion,
      toBuildVersion: options.buildVersion,
      toVersion: options.version,
    });
  }

  const serialized = new XMLSerializer().serializeToString(document);
  writeFileSync(
    options.appcastPath,
    serialized.endsWith("\n") ? serialized : `${serialized}\n`,
    "utf8",
  );
  runWithPrivateKey(
    options.signUpdate,
    ["--ed-key-file", "-", "--disable-signing-warning", options.appcastPath],
    options.privateKey,
  );
  runWithPrivateKey(
    options.signUpdate,
    ["--verify", "--ed-key-file", "-", options.appcastPath],
    options.privateKey,
  );
  return {
    deltas: deltas.sort((left, right) => left.fromVersion.localeCompare(right.fromVersion)),
    full: fileIdentity(options.currentFullPath, fullUrl, fullSignature),
  };
};

const verifyDeltaRoundTrip = (options: {
  readonly binaryDelta: string;
  readonly currentAppPath: string;
  readonly delta: SparkleDeltaIdentity;
  readonly workingDirectory: string;
}): void => {
  const sourceZipName = `Nodex-${options.delta.fromVersion}-${options.delta.name.endsWith("-arm64.delta") ? "arm64" : "x64"}.zip`;
  const sourceZip = findFileRecursively(options.workingDirectory, sourceZipName);
  const deltaPath = findFileRecursively(options.workingDirectory, options.delta.name);
  if (!sourceZip || !deltaPath)
    throw new Error(`Cannot verify delta from ${options.delta.fromVersion}.`);
  const verificationRoot = mkdtempSync(path.join(tmpdir(), "nodex-sparkle-delta-verify-"));
  try {
    const sourceApp = extractZip(sourceZip, path.join(verificationRoot, "source"));
    const outputApp = path.join(verificationRoot, "Nodex.app");
    run(options.binaryDelta, ["apply", sourceApp, deltaPath, outputApp]);
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", outputApp]);
    run("/usr/bin/diff", ["-qr", outputApp, options.currentAppPath]);
  } finally {
    rmSync(verificationRoot, { force: true, recursive: true });
  }
};

export function selectLatestSparkleHistoryAppcast(paths: readonly string[]): string | null {
  const candidates: Array<{ readonly buildVersion: string; readonly path: string }> = [];
  for (const candidatePath of paths) {
    const nameMatch = /^Nodex-(.+)-appcast-(?:arm64|x64)\.xml$/u.exec(path.basename(candidatePath));
    if (!nameMatch) continue;
    if (!existsSync(candidatePath)) {
      try {
        candidates.push({
          buildVersion: normalizeAppleBuildVersion(nameMatch[1]),
          path: candidatePath,
        });
      } catch {
        // A Nightly appcast needs its XML build version and cannot be inferred from the filename.
      }
      continue;
    }
    const document = new DOMParser().parseFromString(
      readFileSync(candidatePath, "utf8"),
      "application/xml",
    );
    const buildVersions = [
      ...Array.from({ length: document.getElementsByTagName("item").length }, (_, index) => index),
    ]
      .map((index) => document.getElementsByTagName("item").item(index))
      .map((item) => (item ? textFor(item, "version") : null))
      .filter((value): value is string => value !== null);
    const buildVersion = buildVersions.sort((left, right) => compareBuildVersions(right, left))[0];
    if (buildVersion) candidates.push({ buildVersion, path: candidatePath });
  }
  return (
    candidates
      .sort((left, right) => compareBuildVersions(right.buildVersion, left.buildVersion))
      .at(0)?.path ?? null
  );
}

const copyHistory = (directories: readonly string[], workingDirectory: string): void => {
  const candidatePaths: string[] = [];
  for (const directory of directories) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (entry.name.endsWith(".zip") || entry.name.includes("appcast")) {
        const destination = path.join(workingDirectory, entry.name);
        if (!existsSync(destination)) copyFileSync(path.join(directory, entry.name), destination);
        if (entry.name.includes("appcast") && entry.name.endsWith(".xml")) {
          candidatePaths.push(destination);
        }
      }
    }
  }
  const latestAppcast = selectLatestSparkleHistoryAppcast(candidatePaths);
  if (latestAppcast) {
    copyFileSync(latestAppcast, path.join(workingDirectory, "appcast.xml"));
  }
};

export async function finalizeSparkleArchitectureUpdate(
  options: FinalizeSparkleOptions,
): Promise<SparkleArchitectureUpdateManifest> {
  if (process.platform !== "darwin") throw new Error("Sparkle finalization requires macOS.");
  const version = normalizeReleaseVersion(options.version);
  const tag = tagForReleaseVersion(version);
  if (!/^[a-f0-9]{40}$/u.test(options.sourceSha)) throw new Error("Sparkle source SHA is invalid.");
  if (!options.privateKey.trim()) throw new Error("Sparkle private key is required.");
  const architectureRoot = path.resolve(options.architectureDirectory);
  const fullName = `Nodex-${version}-${options.architecture}.zip`;
  const fullSourcePath = path.join(architectureRoot, fullName);
  const output = path.resolve(options.outputDirectory);
  ensureEmptyDirectory(output);
  const toolchainDirectory = path.resolve(options.toolchainDirectory);
  await materializeSparkleRuntime({ outputPath: toolchainDirectory });
  const generateAppcast = path.join(toolchainDirectory, "bin", "generate_appcast");
  const signUpdate = path.join(toolchainDirectory, "bin", "sign_update");
  const binaryDelta = path.join(toolchainDirectory, "bin", "BinaryDelta");
  const publicKey = readConfiguredPublicKey();
  assertPrivateKeyMatchesPublicKey(signUpdate, options.privateKey, publicKey);
  const workingRoot = mkdtempSync(path.join(tmpdir(), `nodex-sparkle-${options.architecture}-`));
  try {
    const fullPath = path.join(workingRoot, fullName);
    copyFileSync(fullSourcePath, fullPath);
    copyFileSync(
      options.releaseNotesPath,
      path.join(workingRoot, `${path.parse(fullName).name}.md`),
    );
    copyHistory(options.historyDirectories ?? [], workingRoot);
    const currentAppPath = extractZip(fullPath, path.join(workingRoot, "current-app"));
    const identity = readAppIdentity(currentAppPath);
    if (
      identity.version !== version ||
      identity.bundleId !== PRODUCT_BUNDLE_ID ||
      identity.packageProvenanceSchema !== 5 ||
      identity.publicKey !== publicKey ||
      identity.runtimePublicKey !== publicKey
    ) {
      throw new Error("Sparkle target app identity does not match the release contract.");
    }

    runWithPrivateKey(
      generateAppcast,
      [
        "--ed-key-file",
        "-",
        "--disable-signing-warning",
        "--download-url-prefix",
        `https://github.com/junyudev/nodex/releases/download/${tag}/`,
        "--embed-release-notes",
        "--link",
        "https://nodex.jyu.app/",
        "--maximum-versions",
        "3",
        "--maximum-deltas",
        "5",
        "-o",
        "appcast.xml",
        workingRoot,
      ],
      options.privateKey,
      workingRoot,
    );
    const appcastPath = path.join(workingRoot, "appcast.xml");
    const normalized = normalizeGeneratedAppcast({
      appcastPath,
      architecture: options.architecture,
      buildVersion: identity.buildVersion,
      currentFullPath: fullPath,
      privateKey: options.privateKey,
      publishedAt: options.publishedAt,
      signUpdate,
      tag,
      version,
      workingDirectory: workingRoot,
    });
    for (const delta of normalized.deltas) {
      verifyDeltaRoundTrip({ binaryDelta, currentAppPath, delta, workingDirectory: workingRoot });
    }
    const appcastName = `Nodex-${version}-appcast-${options.architecture}.xml`;
    const outputAppcastPath = path.join(output, appcastName);
    copyFileSync(appcastPath, outputAppcastPath);
    for (const delta of normalized.deltas) {
      const source = findFileRecursively(workingRoot, delta.name);
      if (!source) throw new Error(`Normalized Sparkle delta is missing: ${delta.name}`);
      copyFileSync(source, path.join(output, delta.name));
    }
    const manifest: SparkleArchitectureUpdateManifest = {
      architecture: options.architecture,
      channel: options.channel,
      appcast: {
        bytes: statSync(outputAppcastPath).size,
        feedPath: `updates/${options.channel}/${options.architecture}/appcast.xml`,
        name: appcastName,
        sha256: sha256File(outputAppcastPath),
      },
      deltas: normalized.deltas,
      full: normalized.full,
      schemaVersion: 2,
      sourceSha: options.sourceSha,
      tag,
      target: {
        buildVersion: identity.buildVersion,
        bundleId: PRODUCT_BUNDLE_ID,
        packageProvenanceSchema: 5,
        teamIdentifier: identity.teamIdentifier,
        version,
      },
    };
    const verified = parseSparkleArchitectureUpdateManifest(manifest);
    verifySparkleAppcastContract(readFileSync(outputAppcastPath, "utf8"), verified);
    writeFileSync(
      path.join(output, `Nodex-${version}-update-${options.architecture}.json`),
      `${JSON.stringify(verified, null, 2)}\n`,
      "utf8",
    );
    return verified;
  } finally {
    rmSync(workingRoot, { force: true, recursive: true });
  }
}

const splitHistoryDirectories = (value: string | undefined): readonly string[] =>
  value
    ? value
        .split(path.delimiter)
        .filter(Boolean)
        .map((entry) => path.resolve(entry))
    : [];

export async function runSparkleFinalizeCli(args: ReadonlyMap<string, string>): Promise<void> {
  const architecture = args.get("arch");
  if (architecture !== "arm64" && architecture !== "x64") {
    throw new Error("Sparkle --arch must be arm64 or x64.");
  }
  const required = (name: string): string => {
    const value = args.get(name)?.trim();
    if (!value) throw new Error(`Missing Sparkle --${name}.`);
    return value;
  };
  await finalizeSparkleArchitectureUpdate({
    architecture,
    channel: (() => {
      const channel = required("channel");
      if (channel !== "stable" && channel !== "nightly")
        throw new Error("Sparkle --channel must be stable or nightly.");
      return channel;
    })(),
    architectureDirectory: required("architecture-dir"),
    historyDirectories: splitHistoryDirectories(args.get("history-dirs")),
    outputDirectory: required("output"),
    privateKey: process.env.SPARKLE_ED25519_PRIVATE_KEY ?? "",
    publishedAt: required("published-at"),
    releaseNotesPath: required("notes"),
    sourceSha: required("source-sha"),
    toolchainDirectory: args.get("toolchain") ?? path.resolve(".generated/sparkle-toolchain/2.9.4"),
    version: required("version"),
  });
}

interface GitHubReleaseAsset {
  readonly digest?: string | null;
  readonly name: string;
  readonly size: number;
}

interface GitHubReleaseSummary {
  readonly assets: readonly GitHubReleaseAsset[];
  readonly draft: boolean;
  readonly immutable?: boolean;
  readonly prerelease: boolean;
  readonly published_at: string | null;
  readonly tag_name: string;
}

export const isEligibleSparkleHistoryRelease = (
  release: Pick<GitHubReleaseSummary, "draft" | "immutable" | "prerelease">,
  channel: ReleaseChannel = "stable",
): boolean =>
  !release.draft && release.prerelease === (channel === "nightly") && release.immutable === true;

const gh = (args: readonly string[]): string => run("gh", args);

const assertDownloadedGitHubAsset = (release: GitHubReleaseSummary, filePath: string): void => {
  const name = path.basename(filePath);
  const asset = release.assets.find((candidate) => candidate.name === name);
  if (!asset) throw new Error(`GitHub release ${release.tag_name} is missing ${name}.`);
  const digest = asset.digest?.replace(/^sha256:/u, "");
  if (asset.size !== statSync(filePath).size || digest !== sha256File(filePath)) {
    throw new Error(`GitHub release asset ${release.tag_name}/${name} failed digest verification.`);
  }
};

export function fetchSparkleHistory(options: {
  readonly architecture: MacArchitecture;
  readonly channel?: ReleaseChannel;
  readonly currentBuildVersion?: string;
  readonly currentVersion: string;
  readonly limit?: number;
  readonly outputDirectory: string;
  readonly repository: string;
}): readonly string[] {
  const channel = options.channel ?? "stable";
  const currentVersion = normalizeReleaseVersion(options.currentVersion);
  const nightlyOrdinal = /-nightly\.\d{8}\.([1-9]\d*)$/u.exec(currentVersion)?.[1];
  const currentBuildVersion = options.currentBuildVersion
    ? normalizeAppleBuildVersion(options.currentBuildVersion)
    : channel === "stable"
      ? normalizeAppleBuildVersion(currentVersion)
      : buildVersionForMainlineOrdinal(Number(nightlyOrdinal));
  const output = path.resolve(options.outputDirectory);
  ensureEmptyDirectory(output);
  const releases = (
    JSON.parse(
      gh(["api", `repos/${options.repository}/releases?per_page=30`]),
    ) as GitHubReleaseSummary[]
  )
    .filter((release) => isEligibleSparkleHistoryRelease(release, channel))
    .map((release) => ({
      release,
      version:
        channel === "stable"
          ? stableVersionFromAppTag(release.tag_name)
          : (() => {
              try {
                return normalizeReleaseVersion(release.tag_name.replace(/^v/u, ""));
              } catch {
                return null;
              }
            })(),
    }))
    .filter(
      (entry): entry is { release: GitHubReleaseSummary; version: string } =>
        entry.version !== null &&
        (channel === "nightly" || compareStableVersions(entry.version, currentVersion) < 0),
    )
    .sort((left, right) =>
      channel === "stable"
        ? compareStableVersions(right.version, left.version)
        : Number(/\.([1-9]\d*)$/u.exec(right.version)?.[1] ?? 0) -
          Number(/\.([1-9]\d*)$/u.exec(left.version)?.[1] ?? 0),
    );

  const accepted: string[] = [];
  for (const { release, version } of releases) {
    if (accepted.length >= (options.limit ?? 5)) break;
    if (!release.assets.some(({ name }) => name === "release-bundle.json")) continue;
    const releaseRoot = path.join(output, version);
    mkdirSync(releaseRoot);
    gh([
      "release",
      "download",
      release.tag_name,
      "--repo",
      options.repository,
      "--dir",
      releaseRoot,
      "--pattern",
      "release-bundle.json",
    ]);
    const bundlePath = path.join(releaseRoot, "release-bundle.json");
    assertDownloadedGitHubAsset(release, bundlePath);
    const rawBundle = JSON.parse(readFileSync(bundlePath, "utf8")) as {
      readonly schemaVersion?: unknown;
    };
    if (rawBundle.schemaVersion !== 2) {
      rmSync(releaseRoot, { force: true, recursive: true });
      continue;
    }
    const bundle = parseReleaseBundleManifest(rawBundle);
    if (
      bundle.releaseIdentity.channel !== channel ||
      compareBuildVersions(bundle.releaseIdentity.buildVersion, currentBuildVersion) >= 0
    ) {
      rmSync(releaseRoot, { force: true, recursive: true });
      continue;
    }
    if (bundle.tag !== release.tag_name) {
      throw new Error(`${release.tag_name} does not match its Release Bundle tag.`);
    }
    const releaseTagTarget = gh([
      "api",
      `repos/${options.repository}/commits/${release.tag_name}`,
      "--jq",
      ".sha",
    ]).trim();
    if (releaseTagTarget !== bundle.sourceSha) {
      throw new Error(`${release.tag_name} does not target its Release Bundle source SHA.`);
    }
    const selected = bundle.assets.filter(
      (asset) =>
        asset.architecture === options.architecture &&
        (asset.role === "sparkle-full" ||
          asset.role === "sparkle-appcast" ||
          asset.role === "sparkle-update-manifest"),
    );
    if (selected.length !== 3) {
      throw new Error(
        `${release.tag_name} does not contain one complete ${options.architecture} update set.`,
      );
    }
    for (const asset of selected) {
      gh([
        "release",
        "download",
        release.tag_name,
        "--repo",
        options.repository,
        "--dir",
        releaseRoot,
        "--pattern",
        asset.name,
      ]);
      const assetPath = path.join(releaseRoot, asset.name);
      assertDownloadedGitHubAsset(release, assetPath);
      if (statSync(assetPath).size !== asset.bytes || sha256File(assetPath) !== asset.sha256) {
        throw new Error(`${release.tag_name}/${asset.name} does not match release-bundle.json.`);
      }
    }
    const updateName = `Nodex-${version}-update-${options.architecture}.json`;
    const update = parseSparkleArchitectureUpdateManifest(
      JSON.parse(readFileSync(path.join(releaseRoot, updateName), "utf8")) as unknown,
    );
    const fullAsset = selected.find(({ role }) => role === "sparkle-full");
    const appcastAsset = selected.find(({ role }) => role === "sparkle-appcast");
    if (
      update.target.packageProvenanceSchema !== 5 ||
      update.channel !== channel ||
      update.sourceSha !== bundle.sourceSha ||
      update.tag !== bundle.tag ||
      update.target.version !== bundle.version ||
      !fullAsset ||
      update.full.name !== fullAsset.name ||
      update.full.bytes !== fullAsset.bytes ||
      update.full.sha256 !== fullAsset.sha256 ||
      !appcastAsset ||
      update.appcast.name !== appcastAsset.name ||
      update.appcast.bytes !== appcastAsset.bytes ||
      update.appcast.sha256 !== appcastAsset.sha256
    ) {
      throw new Error(`${release.tag_name} is not a Sparkle-capable provenance release.`);
    }
    verifySparkleAppcastContract(
      readFileSync(path.join(releaseRoot, update.appcast.name), "utf8"),
      update,
    );
    accepted.push(releaseRoot);
  }
  return accepted;
}

export function runSparkleHistoryCli(args: ReadonlyMap<string, string>): void {
  const architecture = args.get("arch");
  if (architecture !== "arm64" && architecture !== "x64") {
    throw new Error("Sparkle history --arch must be arm64 or x64.");
  }
  const required = (name: string): string => {
    const value = args.get(name)?.trim();
    if (!value) throw new Error(`Missing Sparkle history --${name}.`);
    return value;
  };
  const directories = fetchSparkleHistory({
    architecture,
    channel: (() => {
      const channel = args.get("channel") ?? "stable";
      if (channel !== "stable" && channel !== "nightly")
        throw new Error("Sparkle history --channel must be stable or nightly.");
      return channel;
    })(),
    currentBuildVersion: args.get("build-version"),
    currentVersion: required("version"),
    outputDirectory: required("output"),
    repository: required("repo"),
  });
  process.stdout.write(`${directories.join(path.delimiter)}\n`);
}
