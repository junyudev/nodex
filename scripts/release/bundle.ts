import { isSparkleHistoryArchiveName, sparkleFullArchiveName } from "./sparkle-archive";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  appComponentManifestName,
  type AppComponentManifestTarget,
} from "../../src/shared/app-component-manifest";
import { macComponentManifest, readComponentManifest } from "./components";
import { assertWindowsInstalledProbe } from "./windows-installed-probe";

import {
  buildIdentityOf,
  normalizeReleaseVersion,
  parseBuildIdentity,
  type BuildIdentity,
  normalizeStableVersion,
  parseReleaseIdentity,
  sha256File,
  type ReleaseIdentity,
} from "./model";
import { verifySparkleAppcastContract } from "./sparkle-appcast-contract";
import { parseSparkleArchitectureUpdateManifest } from "./sparkle-manifest";

import {
  RELEASE_ARCHITECTURES,
  windowsInstallerName,
  type ReleaseArchitecture,
  type MacArchitecture,
} from "./targets";
import { parseWindowsArchitectureUpdateManifest } from "./windows-updates";
import { readConfiguredPublicKey, verifyFileSignature } from "./signing";
import {
  ANDROID_LATEST_APK,
  MOBILE_BUILD_MANIFEST,
  MOBILE_PLATFORMS,
  mobileAppFor,
  mobileArtifactName,
  readMobileBuildDirectory,
  type MobileApp,
  type MobileArtifact,
  type MobilePlatform,
} from "./mobile";
export type { MacArchitecture } from "./targets";
export const RELEASE_BUNDLE_SCHEMA_VERSION = 9;
/** Bundles that carry every desktop target; schema 5 adds Nodex Mobile. */
export const COMPLETE_RELEASE_BUNDLE_SCHEMA_VERSIONS: readonly number[] = [
  4,
  5,
  6,
  7,
  8,
  RELEASE_BUNDLE_SCHEMA_VERSION,
];
/** Every bundle a published release may carry, back to the last macOS-only format. */
export const RELEASE_HISTORY_SCHEMA_VERSIONS: readonly number[] = [
  3,
  ...COMPLETE_RELEASE_BUNDLE_SCHEMA_VERSIONS,
];
/** Where a bundle keeps its certified iOS build: TestFlight receives it, GitHub never does. */
export const TESTFLIGHT_DIRECTORY = "testflight";

export interface ReleaseArtifactIdentity<Architecture extends string = ReleaseArchitecture> {
  readonly architecture?: Architecture;
  readonly bytes: number;
  readonly name: string;
  readonly role:
    | "android-apk"
    | "windows-installer"
    | "components-manifest"
    | "dmg"
    | "sparkle-appcast"
    | "sparkle-delta"
    | "sparkle-full"
    | "sparkle-update-manifest"
    | "release-identity";
  readonly sha256: string;
}

export interface AgentSkillsIdentity {
  readonly manifestSha256: string;
  readonly treeSha256: string;
}

export interface ArchitectureBuildManifest {
  readonly updates: "disabled" | "enabled";
  readonly agentSkills: AgentSkillsIdentity;
  readonly architecture: ReleaseArchitecture;
  readonly artifacts: readonly ReleaseArtifactIdentity[];
  readonly packageProvenanceSha256: string;
  readonly preparedBuild: {
    readonly generation: string;
    readonly manifestSha256: string;
    readonly state: "clean";
  };
  readonly runner: Readonly<Record<string, string>>;
  readonly runtimeLocks: {
    readonly nodeSha256?: string;
    readonly ripgrepSha256?: string;
    readonly agentSha256: string;
    readonly browserSha256: string;
    readonly sparkleSha256: string;
  };
  readonly schemaVersion: 3;
  readonly buildIdentity: BuildIdentity;
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly version: string;
}

/** One phone build a release ships: its manifest, store versions and exact artifact. */
export interface ReleaseBundleMobileBuild {
  readonly manifestSha256: string;
  readonly app: MobileApp;
  readonly artifact: MobileArtifact;
}

/** Published bundles with the current set of distribution targets and enclosure format. */
export type ReleaseDistributionBundle = Omit<ReleaseBundleManifest, "schemaVersion"> & {
  readonly schemaVersion: 8 | typeof RELEASE_BUNDLE_SCHEMA_VERSION;
};

export interface ReleaseBundleManifest {
  readonly agentSkills: AgentSkillsIdentity;
  readonly architectures: Readonly<
    Record<
      ReleaseArchitecture,
      {
        readonly manifestSha256: string;
        readonly preparedBuildGeneration: string;
        readonly updateManifestSha256: string;
      }
    >
  >;
  readonly assets: readonly ReleaseArtifactIdentity[];
  readonly mobile: Readonly<Record<MobilePlatform, ReleaseBundleMobileBuild>>;
  readonly runtimeLocks: ArchitectureBuildManifest["runtimeLocks"];
  readonly schemaVersion: typeof RELEASE_BUNDLE_SCHEMA_VERSION;
  readonly releaseIdentity: ReleaseIdentity;
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly tag: string;
  readonly version: string;
}

const SHA_PATTERN = /^[a-f0-9]{64}$/u;
const ARTIFACT_ROLES = new Set<ReleaseArtifactIdentity["role"]>([
  "android-apk",
  "windows-installer",
  "components-manifest",
  "dmg",
  "sparkle-appcast",
  "sparkle-delta",
  "sparkle-full",
  "sparkle-update-manifest",
  "release-identity",
]);

const assertSha = (value: string, label: string): string => {
  const normalized = value.trim().toLowerCase();
  if (!SHA_PATTERN.test(normalized)) throw new Error(`${label} must be a SHA-256 hex digest.`);
  return normalized;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const legacyStableIdentity = (options: {
  sourceSha: string;
  sourceTree: string;
  version: string;
}): ReleaseIdentity => ({
  schemaVersion: 1,
  channel: "stable",
  sourceSha: options.sourceSha,
  sourceTree: options.sourceTree,
  version: options.version,
  buildVersion: options.version,
  tag: `v${options.version}`,
  mainlineOrdinal: 1,
  sourceDate: "1970-01-01",
});

const parseAgentSkillsIdentity = (value: unknown, label: string): AgentSkillsIdentity => {
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["manifestSha256", "treeSha256"])
  ) {
    throw new Error(`${label} has an unsupported shape.`);
  }
  return {
    manifestSha256: assertSha(String(value.manifestSha256), `${label} manifest`),
    treeSha256: assertSha(String(value.treeSha256), `${label} tree`),
  };
};

const assertRegularFile = (filePath: string): void => {
  const stats = lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Release artifact must be a regular file: ${filePath}`);
  }
};

const artifactIdentity = (
  filePath: string,
  role: ReleaseArtifactIdentity["role"],
  architecture?: ReleaseArchitecture,
): ReleaseArtifactIdentity => {
  assertRegularFile(filePath);
  const stats = lstatSync(filePath);
  return {
    ...(architecture ? { architecture } : {}),
    bytes: stats.size,
    name: basename(filePath),
    role,
    sha256: sha256File(filePath),
  };
};

const readJson = (filePath: string): unknown =>
  JSON.parse(readFileSync(filePath, "utf8")) as unknown;

const parseArtifact = <Architecture extends string>(
  value: unknown,
  architectures: readonly Architecture[],
): ReleaseArtifactIdentity<Architecture> => {
  if (!isRecord(value)) throw new Error("Release artifact identity is invalid.");
  const architecture = value.architecture as Architecture | undefined;
  if (
    typeof value.name !== "string" ||
    basename(value.name) !== value.name ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) <= 0 ||
    typeof value.sha256 !== "string" ||
    typeof value.role !== "string" ||
    !ARTIFACT_ROLES.has(value.role as ReleaseArtifactIdentity["role"]) ||
    (architecture !== undefined && !architectures.includes(architecture))
  ) {
    throw new Error("Release artifact identity is invalid.");
  }
  return {
    ...(architecture ? { architecture } : {}),
    bytes: value.bytes as number,
    name: value.name,
    role: value.role as ReleaseArtifactIdentity["role"],
    sha256: assertSha(value.sha256, `artifact ${value.name}`),
  };
};

export function parseArchitectureBuildManifest(value: unknown): ArchitectureBuildManifest {
  if (!isRecord(value)) throw new Error("Architecture build manifest is invalid.");
  const candidate = value as Partial<ArchitectureBuildManifest>;
  if (
    candidate.schemaVersion !== 3 ||
    !RELEASE_ARCHITECTURES.includes(candidate.architecture as ReleaseArchitecture) ||
    typeof candidate.version !== "string" ||
    (candidate.updates !== "disabled" && candidate.updates !== "enabled") ||
    typeof candidate.sourceSha !== "string" ||
    typeof candidate.sourceTree !== "string" ||
    !candidate.preparedBuild ||
    candidate.preparedBuild.state !== "clean" ||
    !candidate.runtimeLocks ||
    typeof candidate.packageProvenanceSha256 !== "string" ||
    !Array.isArray(candidate.artifacts) ||
    !candidate.runner
  ) {
    throw new Error("Architecture build manifest is invalid.");
  }
  const version = normalizeStableVersion(candidate.version);
  const buildIdentity = parseBuildIdentity(candidate.buildIdentity);
  if (
    version !== buildIdentity.version ||
    candidate.sourceSha !== buildIdentity.sourceSha ||
    candidate.sourceTree !== buildIdentity.sourceTree
  )
    throw new Error("Architecture build source identity does not match its release identity.");
  if (
    !/^[a-f0-9]{40}$/u.test(candidate.sourceSha) ||
    !/^[a-f0-9]{40}$/u.test(candidate.sourceTree)
  ) {
    throw new Error("Architecture build source identity is invalid.");
  }
  assertSha(candidate.preparedBuild.generation, "prepared build generation");
  assertSha(candidate.preparedBuild.manifestSha256, "prepared build manifest");
  assertSha(candidate.runtimeLocks.agentSha256, "Agent runtime lock");
  assertSha(candidate.runtimeLocks.browserSha256, "Browser runtime lock");
  assertSha(candidate.runtimeLocks.sparkleSha256, "Sparkle runtime lock");
  if (candidate.runtimeLocks.ripgrepSha256 !== undefined)
    assertSha(candidate.runtimeLocks.ripgrepSha256, "ripgrep runtime lock");
  assertSha(candidate.packageProvenanceSha256, "package provenance");
  if (candidate.architecture !== "arm64") {
    assertSha(candidate.runtimeLocks.nodeSha256 ?? "", "Windows Node runtime lock");
  }
  return {
    ...candidate,
    agentSkills: parseAgentSkillsIdentity(
      candidate.agentSkills,
      "Architecture Agent Skills identity",
    ),
    artifacts: candidate.artifacts.map((artifact) =>
      parseArtifact(artifact, RELEASE_ARCHITECTURES),
    ),
    version,
    buildIdentity,
  } as ArchitectureBuildManifest;
}

const LEGACY_RELEASE_ARCHITECTURES = ["arm64", "windows-x64", "windows-arm64"] as const;
type ReleaseHistoryArchitecture = (typeof LEGACY_RELEASE_ARCHITECTURES)[number];

type ReleaseHistoryBundle = Omit<
  ReleaseBundleManifest,
  "schemaVersion" | "architectures" | "assets" | "mobile"
> & {
  readonly schemaVersion: 3 | 4 | 5 | 6 | 7 | 8 | typeof RELEASE_BUNDLE_SCHEMA_VERSION;
  readonly architectures: Readonly<
    Partial<Record<ReleaseHistoryArchitecture, ReleaseBundleManifest["architectures"]["arm64"]>>
  >;
  readonly assets: readonly ReleaseArtifactIdentity<ReleaseHistoryArchitecture>[];
  readonly mobile?: ReleaseBundleManifest["mobile"];
};

const parseMobileBuilds = (
  value: unknown,
  identity: BuildIdentity,
): ReleaseBundleManifest["mobile"] => {
  if (!isRecord(value) || JSON.stringify(Object.keys(value).sort()) !== '["android","ios"]')
    throw new Error("Release Bundle mobile builds are invalid.");
  const builds = Object.fromEntries(
    MOBILE_PLATFORMS.map((platform) => {
      const build = value[platform];
      if (!isRecord(build) || !isRecord(build.app) || !isRecord(build.artifact))
        throw new Error(`Release Bundle ${platform} build is invalid.`);
      const parsed: ReleaseBundleMobileBuild = {
        manifestSha256: assertSha(String(build.manifestSha256), `${platform} build manifest`),
        app: {
          id: String(build.app.id),
          version: String(build.app.version),
          build: String(build.app.build),
        },
        artifact: {
          name: String(build.artifact.name),
          bytes: Number(build.artifact.bytes),
          sha256: assertSha(String(build.artifact.sha256), `${platform} build artifact`),
        },
      };
      if (
        !isDeepStrictEqual(parsed.app, mobileAppFor(platform, identity)) ||
        parsed.artifact.name !== mobileArtifactName(platform, identity.version) ||
        !Number.isSafeInteger(parsed.artifact.bytes) ||
        parsed.artifact.bytes <= 0
      )
        throw new Error(`Release Bundle ${platform} build does not match its release identity.`);
      return [platform, parsed];
    }),
  );
  return builds as ReleaseBundleManifest["mobile"];
};

/** Read published history back to the last macOS-only bundle format. */
export function parseReleaseHistoryBundle(value: unknown): ReleaseHistoryBundle {
  return parseBundleManifest(value, "history");
}

export function parseReleaseBundleManifest(value: unknown): ReleaseBundleManifest {
  return parseBundleManifest(value, "current") as ReleaseBundleManifest;
}

export function parseReleaseDistributionBundle(value: unknown): ReleaseDistributionBundle {
  return parseBundleManifest(value, "distribution") as ReleaseDistributionBundle;
}

function parseBundleManifest(
  value: unknown,
  mode: "current" | "distribution" | "history",
): ReleaseHistoryBundle {
  const allowHistory = mode === "history";
  if (!isRecord(value)) throw new Error("Release Bundle manifest is invalid.");
  const candidate = value as Partial<ReleaseHistoryBundle>;
  const macOnlyHistory = allowHistory && candidate.schemaVersion === 3;
  const current = candidate.schemaVersion === RELEASE_BUNDLE_SCHEMA_VERSION;
  const x64Only = current || candidate.schemaVersion === 8;
  const supported = allowHistory
    ? RELEASE_HISTORY_SCHEMA_VERSIONS.includes(candidate.schemaVersion as number)
    : mode === "distribution"
      ? x64Only
      : current;
  const hasCertifiedMobile =
    x64Only || candidate.schemaVersion === 7 || candidate.schemaVersion === 6;
  const hasMacComponentManifest = x64Only || candidate.schemaVersion === 7;
  const hasMobile = hasCertifiedMobile || candidate.schemaVersion === 5;
  const architectures = macOnlyHistory
    ? (["arm64"] as const)
    : x64Only
      ? RELEASE_ARCHITECTURES
      : LEGACY_RELEASE_ARCHITECTURES;
  const windowsArchitectures = architectures.filter((architecture) => architecture !== "arm64");
  if (
    !supported ||
    hasMobile !== (candidate.mobile !== undefined) ||
    typeof candidate.version !== "string" ||
    typeof candidate.tag !== "string" ||
    typeof candidate.sourceSha !== "string" ||
    typeof candidate.sourceTree !== "string" ||
    !candidate.architectures ||
    JSON.stringify(Object.keys(candidate.architectures).sort()) !==
      JSON.stringify([...architectures].sort()) ||
    !candidate.runtimeLocks ||
    !Array.isArray(candidate.assets)
  ) {
    throw new Error("Release Bundle manifest is invalid.");
  }
  const version = normalizeReleaseVersion(candidate.version);
  const hasEmbeddedIdentity = candidate.releaseIdentity !== undefined;
  const releaseIdentity = hasCertifiedMobile
    ? parseReleaseIdentity(candidate.releaseIdentity)
    : (candidate.releaseIdentity ??
      legacyStableIdentity({
        sourceSha: candidate.sourceSha,
        sourceTree: candidate.sourceTree,
        version,
      }));
  if (
    candidate.tag !== releaseIdentity.tag ||
    version !== releaseIdentity.version ||
    candidate.sourceSha !== releaseIdentity.sourceSha ||
    candidate.sourceTree !== releaseIdentity.sourceTree
  )
    throw new Error("Release Bundle source identity does not match its release identity.");
  if (
    !/^[a-f0-9]{40}$/u.test(candidate.sourceSha) ||
    !/^[a-f0-9]{40}$/u.test(candidate.sourceTree)
  ) {
    throw new Error("Release Bundle source identity is invalid.");
  }
  const agentSkills = parseAgentSkillsIdentity(
    candidate.agentSkills,
    "Release Bundle Agent Skills identity",
  );
  for (const architecture of architectures) {
    assertSha(
      candidate.architectures[architecture]!.manifestSha256,
      `${architecture} architecture manifest`,
    );
    assertSha(
      candidate.architectures[architecture]!.preparedBuildGeneration,
      `${architecture} prepared build generation`,
    );
    assertSha(
      candidate.architectures[architecture]!.updateManifestSha256,
      `${architecture} update manifest`,
    );
  }
  assertSha(candidate.runtimeLocks.agentSha256, "Release Bundle Agent runtime lock");
  assertSha(candidate.runtimeLocks.browserSha256, "Release Bundle Browser runtime lock");
  assertSha(candidate.runtimeLocks.sparkleSha256, "Release Bundle Sparkle runtime lock");
  if (candidate.runtimeLocks.ripgrepSha256 !== undefined)
    assertSha(candidate.runtimeLocks.ripgrepSha256, "Release Bundle ripgrep runtime lock");
  if (!macOnlyHistory)
    assertSha(candidate.runtimeLocks.nodeSha256 ?? "", "Release Bundle Node runtime lock");
  const mobile = hasCertifiedMobile
    ? parseMobileBuilds(candidate.mobile, buildIdentityOf(releaseIdentity))
    : undefined;
  const assets = candidate.assets.map((asset) => parseArtifact(asset, architectures));
  const names = assets.map(({ name }) => name);
  if (new Set(names).size !== names.length)
    throw new Error("Release Bundle contains duplicate asset names.");
  const required = [
    ...(releaseIdentity.channel === "stable"
      ? ([
          ["Nodex-latest-arm64.dmg", "dmg", "arm64"],
          ...(hasCertifiedMobile
            ? ([[`Nodex-${version}-arm64.dmg`, "dmg", "arm64"]] as const)
            : []),
        ] as const)
      : ([[`Nodex-${version}-arm64.dmg`, "dmg", "arm64"]] as const)),
    [
      allowHistory
        ? (assets.find(
            (asset) =>
              asset.role === "sparkle-full" &&
              asset.architecture === "arm64" &&
              isSparkleHistoryArchiveName(asset.name, version, "arm64"),
          )?.name ?? sparkleFullArchiveName(version, "arm64"))
        : sparkleFullArchiveName(version, "arm64"),
      "sparkle-full",
      "arm64",
    ],
    ...(hasMacComponentManifest
      ? ([
          [appComponentManifestName(version, "darwin-arm64"), "components-manifest", "arm64"],
        ] as const)
      : []),
    [`Nodex-${version}-appcast-arm64.xml`, "sparkle-appcast", "arm64"],
    [`Nodex-${version}-update-arm64.json`, "sparkle-update-manifest", "arm64"],
    ...windowsArchitectures.flatMap((architecture) => [
      [`Nodex-${version}-${architecture}.exe`, "windows-installer", architecture] as const,
      ...(current
        ? [
            [
              appComponentManifestName(version, "win32-x64"),
              "components-manifest",
              architecture,
            ] as const,
          ]
        : []),
      ...(releaseIdentity.channel === "stable"
        ? [[`Nodex-latest-${architecture}.exe`, "windows-installer", architecture] as const]
        : []),
      [`Nodex-${version}-appcast-${architecture}.xml`, "sparkle-appcast", architecture] as const,
      [
        `Nodex-${version}-update-${architecture}.json`,
        "sparkle-update-manifest",
        architecture,
      ] as const,
    ]),
    ...(hasMobile && candidate.mobile
      ? ([
          [candidate.mobile.android.artifact.name, "android-apk", undefined],
          ...(releaseIdentity.channel === "stable"
            ? ([[ANDROID_LATEST_APK, "android-apk", undefined]] as const)
            : []),
        ] as const)
      : []),
    ...(hasEmbeddedIdentity
      ? [["release-identity.json", "release-identity", undefined] as const]
      : []),
  ] as const;
  if (
    required.some(
      ([name, role, architecture]) =>
        !assets.some(
          (asset) =>
            asset.name === name && asset.role === role && asset.architecture === architecture,
        ),
    )
  ) {
    throw new Error("Release Bundle is missing a required stable application asset.");
  }
  if (hasCertifiedMobile && releaseIdentity.channel === "stable") {
    const versioned = assets.find(({ name }) => name === `Nodex-${version}-arm64.dmg`);
    const alias = assets.find(({ name }) => name === "Nodex-latest-arm64.dmg");
    if (alias?.sha256 !== versioned?.sha256 || alias?.bytes !== versioned?.bytes) {
      throw new Error("Stable DMG alias must have identical bytes to its versioned download.");
    }
  }
  for (const architecture of windowsArchitectures) {
    const versioned = assets.find(({ name }) => name === `Nodex-${version}-${architecture}.exe`);
    const alias = assets.find(({ name }) => name === `Nodex-latest-${architecture}.exe`);
    if (alias && (alias.sha256 !== versioned?.sha256 || alias.bytes !== versioned?.bytes)) {
      throw new Error(
        "Windows stable installer alias must have identical bytes to its versioned installer.",
      );
    }
  }
  if (mobile) {
    const apk = mobile.android.artifact;
    for (const name of [apk.name, ANDROID_LATEST_APK]) {
      const asset = assets.find((candidate) => candidate.name === name);
      if (asset && (asset.sha256 !== apk.sha256 || asset.bytes !== apk.bytes))
        throw new Error("Every Android download must be the exact APK the release certified.");
    }
  }
  const requiredNames = new Set<string>(required.map(([name]) => name));
  for (const asset of assets) {
    if (requiredNames.has(asset.name)) continue;
    const match = /^Nodex-(.+)-to-(.+)-(arm64)\.delta$/u.exec(asset.name);
    let fromVersion: string | null = null;
    try {
      fromVersion = match ? normalizeReleaseVersion(match[1]) : null;
    } catch {
      fromVersion = null;
    }
    if (
      asset.role !== "sparkle-delta" ||
      !match ||
      !fromVersion ||
      match[2] !== version ||
      match[3] !== asset.architecture
    ) {
      throw new Error(`Release Bundle contains an unsupported asset: ${asset.name}.`);
    }
  }
  if (assets.some(({ name }) => name.endsWith(".blockmap") || name === "latest-mac.yml")) {
    throw new Error("Release Bundle contains obsolete electron-updater assets.");
  }
  return {
    ...candidate,
    agentSkills,
    assets,
    ...(mobile ? { mobile } : {}),
    releaseIdentity,
    version,
  } as ReleaseHistoryBundle;
}

const ensureEmptyDirectory = (directory: string): void => {
  if (existsSync(directory) && readdirSync(directory).length > 0) {
    throw new Error(`Release output directory must be empty: ${directory}`);
  }
  mkdirSync(directory, { recursive: true });
};

const commandVersion = (command: string, args: readonly string[]): string => {
  try {
    return execFileSync(command, [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")[0];
  } catch {
    return "unavailable";
  }
};

export function recordArchitectureBuild(options: {
  readonly appPath: string;
  readonly architecture: MacArchitecture;
  readonly cwd: string;
  readonly distDirectory: string;
  readonly outputDirectory: string;
  readonly identityPath: string;
}): ArchitectureBuildManifest {
  const cwd = resolve(options.cwd);
  const buildIdentity = parseBuildIdentity(readJson(resolve(options.identityPath)));
  const version = buildIdentity.version;
  const sourceSha = buildIdentity.sourceSha;
  if (!/^[a-f0-9]{40}$/u.test(sourceSha)) throw new Error("Source SHA must be a full commit SHA.");
  const actualHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  const sourceTree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
    cwd,
    encoding: "utf8",
  }).trim();
  const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd,
    encoding: "utf8",
  }).trim();
  if (actualHead !== sourceSha || sourceTree !== buildIdentity.sourceTree || status) {
    throw new Error("Architecture build must come from the exact clean release identity.");
  }
  if (process.platform !== "darwin" || process.arch !== options.architecture) {
    throw new Error(`Architecture build must run natively on darwin ${options.architecture}.`);
  }

  const output = resolve(options.outputDirectory);
  ensureEmptyDirectory(output);
  const artifacts = (
    [
      [`Nodex-${version}-${options.architecture}.dmg`, "dmg"],
      [sparkleFullArchiveName(version, options.architecture), "sparkle-full"],
    ] as const
  ).map(([name, role]) => {
    const target = join(output, name);
    copyFileSync(join(resolve(options.distDirectory), name), target);
    return artifactIdentity(target, role, options.architecture);
  });

  const componentManifestPath = join(output, appComponentManifestName(version, "darwin-arm64"));
  writeFileSync(
    componentManifestPath,
    `${JSON.stringify(macComponentManifest(buildIdentity), null, 2)}\n`,
  );
  artifacts.push(
    artifactIdentity(componentManifestPath, "components-manifest", options.architecture),
  );

  const preparedPath = join(cwd, ".generated/prepared-electron-build.json");
  const prepared = readJson(preparedPath) as {
    readonly generationId?: unknown;
    readonly product?: { readonly version?: unknown };
    readonly buildIdentity?: unknown;
    readonly source?: {
      readonly baseCommit?: unknown;
      readonly baseTree?: unknown;
      readonly state?: unknown;
    };
  };
  if (
    typeof prepared.generationId !== "string" ||
    prepared.product?.version !== version ||
    JSON.stringify(prepared.buildIdentity) !== JSON.stringify(buildIdentity) ||
    prepared.source?.state !== "clean" ||
    prepared.source.baseCommit !== sourceSha ||
    prepared.source.baseTree !== sourceTree
  ) {
    throw new Error("Prepared Electron build does not match the architecture release identity.");
  }
  const provenancePath = join(
    resolve(options.appPath),
    "Contents/Resources/nodex-build-provenance.json",
  );
  const provenance = readJson(provenancePath) as { readonly agentSkills?: unknown };
  const manifest: ArchitectureBuildManifest = {
    agentSkills: parseAgentSkillsIdentity(provenance.agentSkills, "Packaged Agent Skills identity"),
    architecture: options.architecture,
    updates: "enabled",
    artifacts,
    packageProvenanceSha256: sha256File(provenancePath),
    preparedBuild: {
      generation: prepared.generationId,
      manifestSha256: sha256File(preparedPath),
      state: "clean",
    },
    runner: {
      image: process.env.ImageOS ?? process.env.RUNNER_OS ?? "local",
      imageVersion: process.env.ImageVersion ?? "unknown",
      node: process.version,
      pnpm: commandVersion("pnpm", ["--version"]),
      rust: commandVersion("rustc", ["--version"]),
    },
    runtimeLocks: {
      agentSha256: sha256File(join(cwd, "resources/agent-runtime/codex-app-server.lock.json")),
      browserSha256: sha256File(join(cwd, "resources/browser-runtime/browser-runtime.lock.json")),
      sparkleSha256: sha256File(join(cwd, "resources/sparkle/sparkle.lock.json")),
    },
    schemaVersion: 3,
    buildIdentity,
    sourceSha,
    sourceTree,
    version,
  };
  writeFileSync(
    join(output, "architecture-build.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

export const readArchitectureDirectory = (directory: string): ArchitectureBuildManifest => {
  const root = resolve(directory);
  const manifest = parseArchitectureBuildManifest(readJson(join(root, "architecture-build.json")));
  const target: AppComponentManifestTarget =
    manifest.architecture === "arm64" ? "darwin-arm64" : "win32-x64";
  const componentName = appComponentManifestName(manifest.version, target);
  const expected =
    manifest.architecture === "arm64"
      ? [
          [`Nodex-${manifest.version}-${manifest.architecture}.dmg`, "dmg"],
          [sparkleFullArchiveName(manifest.version, manifest.architecture), "sparkle-full"],
          [componentName, "components-manifest"],
        ]
      : [
          [`Nodex-${manifest.version}-${manifest.architecture}.exe`, "windows-installer"],
          [componentName, "components-manifest"],
        ];
  if (manifest.architecture !== "arm64") {
    const provenancePath = join(root, "windows-build-provenance.json");
    const probePath = join(root, "installed-app-probe.json");
    assertRegularFile(provenancePath);
    assertRegularFile(probePath);
    const provenance = readJson(provenancePath);
    if (
      !isRecord(provenance) ||
      provenance.schemaVersion !== 1 ||
      sha256File(provenancePath) !== manifest.packageProvenanceSha256 ||
      provenance.architecture !== manifest.architecture ||
      provenance.updates !== manifest.updates ||
      !isDeepStrictEqual(provenance.buildIdentity, manifest.buildIdentity) ||
      !isDeepStrictEqual(provenance.artifacts, manifest.artifacts) ||
      !isDeepStrictEqual(provenance.runtimeLocks, manifest.runtimeLocks) ||
      provenance.preparedManifestSha256 !== manifest.preparedBuild.manifestSha256 ||
      provenance.installedProbeSha256 !== sha256File(probePath)
    ) {
      throw new Error(
        "Windows package provenance does not match its architecture manifest and probe.",
      );
    }
  }
  const actual = manifest.artifacts.map(({ name, role }) => [name, role]);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${manifest.architecture} architecture artifacts do not match the release allowlist.`,
    );
  }
  for (const artifact of manifest.artifacts) {
    const actualIdentity = artifactIdentity(
      join(root, artifact.name),
      artifact.role,
      artifact.architecture,
    );
    if (
      artifact.architecture !== manifest.architecture ||
      actualIdentity.bytes !== artifact.bytes ||
      actualIdentity.sha256 !== artifact.sha256
    ) {
      throw new Error(`Architecture artifact ${artifact.name} does not match its manifest.`);
    }
  }
  const components = readComponentManifest(
    join(root, componentName),
    target,
    manifest.buildIdentity,
  );
  if (target === "win32-x64")
    assertWindowsInstalledProbe(
      readJson(join(root, "installed-app-probe.json")),
      "x64",
      components.components,
    );
  return manifest;
};

const readUpdateDirectory = (directory: string, architecture: MacArchitecture, version: string) => {
  const root = resolve(directory);
  const manifestName = `Nodex-${version}-update-${architecture}.json`;
  const manifestPath = join(root, manifestName);
  const manifest = parseSparkleArchitectureUpdateManifest(readJson(manifestPath));
  if (manifest.architecture !== architecture || manifest.target.version !== version) {
    throw new Error(`${architecture} Sparkle manifest does not match the requested release.`);
  }
  for (const identity of [manifest.appcast, ...manifest.deltas]) {
    const filePath = join(root, identity.name);
    assertRegularFile(filePath);
    if (lstatSync(filePath).size !== identity.bytes || sha256File(filePath) !== identity.sha256) {
      throw new Error(`Sparkle artifact ${identity.name} does not match its update manifest.`);
    }
  }
  verifySparkleAppcastContract(readFileSync(join(root, manifest.appcast.name), "utf8"), manifest);
  return { manifest, manifestName, manifestPath, root };
};

export function assembleReleaseBundle(options: {
  readonly arm64Directory: string;
  readonly arm64UpdateDirectory: string;
  readonly windowsX64Directory: string;
  readonly windowsX64UpdateDirectory: string;
  readonly windowsPublicKey?: string;
  readonly androidDirectory: string;
  readonly iosDirectory: string;
  readonly outputDirectory: string;
  readonly identity: ReleaseIdentity;
}): ReleaseBundleManifest {
  const releaseIdentity = parseReleaseIdentity(options.identity);
  const buildIdentity = buildIdentityOf(releaseIdentity);
  const version = releaseIdentity.version;
  const sourceSha = releaseIdentity.sourceSha;
  const output = resolve(options.outputDirectory);
  ensureEmptyDirectory(output);
  const arm64Root = resolve(options.arm64Directory);
  const arm64 = readArchitectureDirectory(arm64Root);
  const arm64Update = readUpdateDirectory(options.arm64UpdateDirectory, "arm64", version);
  if (
    arm64.sourceSha !== sourceSha ||
    arm64.sourceTree !== releaseIdentity.sourceTree ||
    !isDeepStrictEqual(arm64.buildIdentity, buildIdentity) ||
    arm64.updates !== "enabled" ||
    arm64Update.manifest.tag !== releaseIdentity.tag ||
    arm64Update.manifest.sourceSha !== sourceSha ||
    arm64Update.manifest.channel !== releaseIdentity.channel ||
    arm64Update.manifest.target.buildVersion !== releaseIdentity.buildVersion
  ) {
    throw new Error("Architecture and Sparkle builds do not share one release identity.");
  }

  const publicFiles: Array<{
    readonly architecture: ReleaseArchitecture | undefined;
    readonly path: string;
    readonly role: ReleaseArtifactIdentity["role"];
  }> = [];
  const copy = (
    root: string,
    sourceName: string,
    role: ReleaseArtifactIdentity["role"],
    architecture: ReleaseArchitecture | undefined,
    targetName = sourceName,
  ): void => {
    const target = join(output, targetName);
    copyFileSync(join(root, sourceName), target);
    publicFiles.push({ architecture, path: target, role });
  };
  for (const [architecture, architectureRoot, update] of [
    ["arm64", arm64Root, arm64Update],
  ] as const) {
    const fullName = sparkleFullArchiveName(version, architecture);
    const fullPath = join(architectureRoot, fullName);
    if (
      lstatSync(fullPath).size !== update.manifest.full.bytes ||
      sha256File(fullPath) !== update.manifest.full.sha256
    ) {
      throw new Error(`${architecture} full update does not match its Sparkle manifest.`);
    }
    copy(architectureRoot, `Nodex-${version}-${architecture}.dmg`, "dmg", architecture, undefined);
    copy(architectureRoot, fullName, "sparkle-full", architecture);
    copy(
      architectureRoot,
      appComponentManifestName(version, "darwin-arm64"),
      "components-manifest",
      architecture,
    );
    if (releaseIdentity.channel === "stable") {
      copy(
        architectureRoot,
        `Nodex-${version}-${architecture}.dmg`,
        "dmg",
        architecture,
        `Nodex-latest-${architecture}.dmg`,
      );
    }
    copy(update.root, update.manifest.appcast.name, "sparkle-appcast", architecture);
    copy(update.root, update.manifestName, "sparkle-update-manifest", architecture);
    for (const delta of update.manifest.deltas) {
      copy(update.root, delta.name, "sparkle-delta", architecture);
    }
  }

  const windowsTarget = "windows-x64";
  const windowsBuildDirectory = resolve(options.windowsX64Directory);
  const windowsUpdateDirectory = resolve(options.windowsX64UpdateDirectory);
  const windowsBuild = readArchitectureDirectory(windowsBuildDirectory);
  const windowsUpdateName = `Nodex-${version}-update-${windowsTarget}.json`;
  const windowsUpdatePath = join(windowsUpdateDirectory, windowsUpdateName);
  const windowsUpdate = parseWindowsArchitectureUpdateManifest(readJson(windowsUpdatePath));
  if (
    windowsBuild.architecture !== windowsTarget ||
    windowsBuild.updates !== "enabled" ||
    !isDeepStrictEqual(windowsBuild.buildIdentity, buildIdentity) ||
    JSON.stringify(windowsUpdate.releaseIdentity) !== JSON.stringify(releaseIdentity) ||
    windowsUpdate.architecture !== windowsTarget ||
    JSON.stringify(windowsBuild.agentSkills) !== JSON.stringify(arm64.agentSkills) ||
    ["agentSha256", "browserSha256", "sparkleSha256"].some(
      (key) => Reflect.get(windowsBuild.runtimeLocks, key) !== Reflect.get(arm64.runtimeLocks, key),
    )
  ) {
    throw new Error(
      "Windows and macOS builds must share one release identity, Skills tree and runtime locks.",
    );
  }
  const installerPath = join(windowsBuildDirectory, windowsUpdate.full.name);
  const appcastPath = join(windowsUpdateDirectory, windowsUpdate.appcast.name);
  for (const [filePath, identity] of [
    [installerPath, windowsUpdate.full],
    [appcastPath, windowsUpdate.appcast],
  ] as const) {
    assertRegularFile(filePath);
    if (lstatSync(filePath).size !== identity.bytes || sha256File(filePath) !== identity.sha256) {
      throw new Error(`Windows artifact ${identity.name} does not match its update manifest.`);
    }
    verifyFileSignature(
      filePath,
      identity.edSignature,
      options.windowsPublicKey ?? readConfiguredPublicKey(),
    );
  }
  verifySparkleAppcastContract(readFileSync(appcastPath, "utf8"), windowsUpdate);
  copy(windowsBuildDirectory, windowsUpdate.full.name, "windows-installer", windowsTarget);
  copy(
    windowsBuildDirectory,
    appComponentManifestName(version, "win32-x64"),
    "components-manifest",
    windowsTarget,
  );
  if (releaseIdentity.channel === "stable")
    copy(
      windowsBuildDirectory,
      windowsUpdate.full.name,
      "windows-installer",
      windowsTarget,
      windowsInstallerName("latest", "x64"),
    );
  copy(windowsUpdateDirectory, windowsUpdate.appcast.name, "sparkle-appcast", windowsTarget);
  copy(windowsUpdateDirectory, windowsUpdateName, "sparkle-update-manifest", windowsTarget);

  const mobile = Object.fromEntries(
    MOBILE_PLATFORMS.map((platform) => {
      const directory = platform === "android" ? options.androidDirectory : options.iosDirectory;
      const build = readMobileBuildDirectory(directory, platform, buildIdentity);
      if (platform === "android") {
        const root = resolve(directory);
        copy(root, build.manifest.artifact.name, "android-apk", undefined);
        if (releaseIdentity.channel === "stable")
          copy(root, build.manifest.artifact.name, "android-apk", undefined, ANDROID_LATEST_APK);
      } else {
        const testflight = join(output, TESTFLIGHT_DIRECTORY);
        mkdirSync(testflight);
        copyFileSync(build.manifestPath, join(testflight, MOBILE_BUILD_MANIFEST));
        copyFileSync(build.artifactPath, join(testflight, build.manifest.artifact.name));
      }
      return [
        platform,
        {
          manifestSha256: sha256File(build.manifestPath),
          app: build.manifest.app,
          artifact: build.manifest.artifact,
        },
      ];
    }),
  ) as ReleaseBundleManifest["mobile"];

  const identityTarget = join(output, "release-identity.json");
  writeFileSync(identityTarget, `${JSON.stringify(releaseIdentity, null, 2)}\n`, "utf8");
  const assets = [
    ...publicFiles.map(({ architecture, path: filePath, role }) =>
      artifactIdentity(filePath, role, architecture),
    ),
    artifactIdentity(identityTarget, "release-identity"),
  ].sort((left, right) => left.name.localeCompare(right.name));
  const manifest: ReleaseBundleManifest = {
    agentSkills: arm64.agentSkills,
    architectures: {
      "windows-x64": {
        manifestSha256: sha256File(join(windowsBuildDirectory, "architecture-build.json")),
        preparedBuildGeneration: windowsBuild.preparedBuild.generation,
        updateManifestSha256: sha256File(windowsUpdatePath),
      },
      arm64: {
        manifestSha256: sha256File(join(arm64Root, "architecture-build.json")),
        preparedBuildGeneration: arm64.preparedBuild.generation,
        updateManifestSha256: sha256File(arm64Update.manifestPath),
      },
    },
    assets,
    mobile,
    runtimeLocks: {
      ...arm64.runtimeLocks,
      nodeSha256: windowsBuild.runtimeLocks.nodeSha256,
      ...(windowsBuild.runtimeLocks.ripgrepSha256
        ? { ripgrepSha256: windowsBuild.runtimeLocks.ripgrepSha256 }
        : {}),
    },
    schemaVersion: RELEASE_BUNDLE_SCHEMA_VERSION,
    releaseIdentity,
    sourceSha,
    sourceTree: arm64.sourceTree,
    tag: releaseIdentity.tag,
    version,
  };
  parseReleaseBundleManifest(manifest);
  const manifestPath = join(output, "release-bundle.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const checksumEntries = [
    ...assets.map(({ name, sha256 }) => ({ name, sha256 })),
    { name: basename(manifestPath), sha256: sha256File(manifestPath) },
  ].sort((left, right) => left.name.localeCompare(right.name));
  writeFileSync(
    join(output, "SHA256SUMS"),
    `${checksumEntries.map(({ name, sha256 }) => `${sha256}  ${name}`).join("\n")}\n`,
    "utf8",
  );
  return manifest;
}
