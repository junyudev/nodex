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

import {
  normalizeReleaseVersion,
  normalizeStableVersion,
  parseReleaseIdentity,
  sha256File,
  type ReleaseIdentity,
} from "./model";
import { verifySparkleAppcastContract } from "./sparkle-appcast-contract";
import { parseSparkleArchitectureUpdateManifest } from "./sparkle-manifest";

export type MacArchitecture = "arm64" | "x64";

export interface ReleaseArtifactIdentity {
  readonly architecture?: MacArchitecture;
  readonly bytes: number;
  readonly name: string;
  readonly role:
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
  readonly agentSkills: AgentSkillsIdentity;
  readonly architecture: MacArchitecture;
  readonly artifacts: readonly ReleaseArtifactIdentity[];
  readonly packageProvenanceSha256: string;
  readonly preparedBuild: {
    readonly generation: string;
    readonly manifestSha256: string;
    readonly state: "clean";
  };
  readonly runner: Readonly<Record<string, string>>;
  readonly runtimeLocks: {
    readonly agentSha256: string;
    readonly browserSha256: string;
    readonly sparkleSha256: string;
  };
  readonly schemaVersion: 2;
  readonly releaseIdentity: ReleaseIdentity;
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly tag: string;
  readonly version: string;
}

export interface ReleaseBundleManifest {
  readonly agentSkills: AgentSkillsIdentity;
  readonly architectures: Readonly<
    Record<
      MacArchitecture,
      {
        readonly manifestSha256: string;
        readonly preparedBuildGeneration: string;
        readonly updateManifestSha256: string;
      }
    >
  >;
  readonly assets: readonly ReleaseArtifactIdentity[];
  readonly runtimeLocks: ArchitectureBuildManifest["runtimeLocks"];
  readonly schemaVersion: 2;
  readonly releaseIdentity: ReleaseIdentity;
  readonly sourceSha: string;
  readonly sourceTree: string;
  readonly tag: string;
  readonly version: string;
}

const SHA_PATTERN = /^[a-f0-9]{64}$/u;
const ARTIFACT_ROLES = new Set<ReleaseArtifactIdentity["role"]>([
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
  sourceVersion: normalizeStableVersion(options.version),
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
  architecture?: MacArchitecture,
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

const parseArtifact = (value: unknown): ReleaseArtifactIdentity => {
  if (!isRecord(value)) throw new Error("Release artifact identity is invalid.");
  const architecture = value.architecture;
  if (
    typeof value.name !== "string" ||
    basename(value.name) !== value.name ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) <= 0 ||
    typeof value.sha256 !== "string" ||
    typeof value.role !== "string" ||
    !ARTIFACT_ROLES.has(value.role as ReleaseArtifactIdentity["role"]) ||
    (architecture !== undefined && architecture !== "arm64" && architecture !== "x64")
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
    candidate.schemaVersion !== 2 ||
    (candidate.architecture !== "arm64" && candidate.architecture !== "x64") ||
    typeof candidate.version !== "string" ||
    typeof candidate.tag !== "string" ||
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
  const version = normalizeReleaseVersion(candidate.version);
  const releaseIdentity = candidate.releaseIdentity
    ? parseReleaseIdentity(candidate.releaseIdentity)
    : legacyStableIdentity({
        sourceSha: candidate.sourceSha,
        sourceTree: candidate.sourceTree,
        version,
      });
  if (
    candidate.tag !== releaseIdentity.tag ||
    version !== releaseIdentity.version ||
    candidate.sourceSha !== releaseIdentity.sourceSha ||
    candidate.sourceTree !== releaseIdentity.sourceTree
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
  assertSha(candidate.packageProvenanceSha256, "package provenance");
  return {
    ...candidate,
    agentSkills: parseAgentSkillsIdentity(
      candidate.agentSkills,
      "Architecture Agent Skills identity",
    ),
    artifacts: candidate.artifacts.map(parseArtifact),
    version,
    releaseIdentity,
  } as ArchitectureBuildManifest;
}

export function parseReleaseBundleManifest(value: unknown): ReleaseBundleManifest {
  if (!isRecord(value)) throw new Error("Release Bundle manifest is invalid.");
  const candidate = value as Partial<ReleaseBundleManifest>;
  if (
    candidate.schemaVersion !== 2 ||
    typeof candidate.version !== "string" ||
    typeof candidate.tag !== "string" ||
    typeof candidate.sourceSha !== "string" ||
    typeof candidate.sourceTree !== "string" ||
    !candidate.architectures?.arm64 ||
    !candidate.architectures.x64 ||
    !candidate.runtimeLocks ||
    !Array.isArray(candidate.assets)
  ) {
    throw new Error("Release Bundle manifest is invalid.");
  }
  const version = normalizeReleaseVersion(candidate.version);
  const hasEmbeddedIdentity = candidate.releaseIdentity !== undefined;
  const releaseIdentity = candidate.releaseIdentity
    ? parseReleaseIdentity(candidate.releaseIdentity)
    : legacyStableIdentity({
        sourceSha: candidate.sourceSha,
        sourceTree: candidate.sourceTree,
        version,
      });
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
  for (const architecture of ["arm64", "x64"] as const) {
    assertSha(
      candidate.architectures[architecture].manifestSha256,
      `${architecture} architecture manifest`,
    );
    assertSha(
      candidate.architectures[architecture].preparedBuildGeneration,
      `${architecture} prepared build generation`,
    );
    assertSha(
      candidate.architectures[architecture].updateManifestSha256,
      `${architecture} update manifest`,
    );
  }
  assertSha(candidate.runtimeLocks.agentSha256, "Release Bundle Agent runtime lock");
  assertSha(candidate.runtimeLocks.browserSha256, "Release Bundle Browser runtime lock");
  assertSha(candidate.runtimeLocks.sparkleSha256, "Release Bundle Sparkle runtime lock");
  const assets = candidate.assets.map(parseArtifact);
  const names = assets.map(({ name }) => name);
  if (new Set(names).size !== names.length)
    throw new Error("Release Bundle contains duplicate asset names.");
  const required = [
    ...(releaseIdentity.channel === "stable"
      ? ([
          ["Nodex-latest-arm64.dmg", "dmg", "arm64"],
          ["Nodex-latest-x64.dmg", "dmg", "x64"],
        ] as const)
      : ([
          [`Nodex-${version}-arm64.dmg`, "dmg", "arm64"],
          [`Nodex-${version}-x64.dmg`, "dmg", "x64"],
        ] as const)),
    [`Nodex-${version}-arm64.zip`, "sparkle-full", "arm64"],
    [`Nodex-${version}-x64.zip`, "sparkle-full", "x64"],
    [`Nodex-${version}-appcast-arm64.xml`, "sparkle-appcast", "arm64"],
    [`Nodex-${version}-appcast-x64.xml`, "sparkle-appcast", "x64"],
    [`Nodex-${version}-update-arm64.json`, "sparkle-update-manifest", "arm64"],
    [`Nodex-${version}-update-x64.json`, "sparkle-update-manifest", "x64"],
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
  const requiredNames = new Set<string>(required.map(([name]) => name));
  for (const asset of assets) {
    if (requiredNames.has(asset.name)) continue;
    const match = /^Nodex-(.+)-to-(.+)-(arm64|x64)\.delta$/u.exec(asset.name);
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
  return { ...candidate, agentSkills, assets, releaseIdentity, version } as ReleaseBundleManifest;
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
  const releaseIdentity = parseReleaseIdentity(readJson(resolve(options.identityPath)));
  const version = releaseIdentity.version;
  const sourceSha = releaseIdentity.sourceSha;
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
  if (actualHead !== sourceSha || sourceTree !== releaseIdentity.sourceTree || status) {
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
      [`Nodex-${version}-${options.architecture}.zip`, "sparkle-full"],
    ] as const
  ).map(([name, role]) => {
    const target = join(output, name);
    copyFileSync(join(resolve(options.distDirectory), name), target);
    return artifactIdentity(target, role, options.architecture);
  });

  const preparedPath = join(cwd, ".generated/prepared-electron-build.json");
  const prepared = readJson(preparedPath) as {
    readonly generationId?: unknown;
    readonly product?: { readonly version?: unknown };
    readonly releaseIdentity?: unknown;
    readonly source?: {
      readonly baseCommit?: unknown;
      readonly baseTree?: unknown;
      readonly state?: unknown;
    };
  };
  if (
    typeof prepared.generationId !== "string" ||
    prepared.product?.version !== version ||
    JSON.stringify(prepared.releaseIdentity) !== JSON.stringify(releaseIdentity) ||
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
    schemaVersion: 2,
    releaseIdentity,
    sourceSha,
    sourceTree,
    tag: releaseIdentity.tag,
    version,
  };
  writeFileSync(
    join(output, "architecture-build.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

const readArchitectureDirectory = (directory: string): ArchitectureBuildManifest => {
  const root = resolve(directory);
  const manifest = parseArchitectureBuildManifest(readJson(join(root, "architecture-build.json")));
  const expected = [
    [`Nodex-${manifest.version}-${manifest.architecture}.dmg`, "dmg"],
    [`Nodex-${manifest.version}-${manifest.architecture}.zip`, "sparkle-full"],
  ];
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
    if (actualIdentity.bytes !== artifact.bytes || actualIdentity.sha256 !== artifact.sha256) {
      throw new Error(`Architecture artifact ${artifact.name} does not match its manifest.`);
    }
  }
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
  readonly outputDirectory: string;
  readonly identityPath?: string;
  readonly sourceSha?: string;
  readonly version?: string;
  readonly x64Directory: string;
  readonly x64UpdateDirectory: string;
}): ReleaseBundleManifest {
  const legacyArchitecture = readJson(
    join(resolve(options.arm64Directory), "architecture-build.json"),
  ) as {
    readonly releaseIdentity?: unknown;
    readonly sourceTree?: unknown;
  };
  const releaseIdentity = options.identityPath
    ? parseReleaseIdentity(readJson(resolve(options.identityPath)))
    : legacyArchitecture.releaseIdentity
      ? parseReleaseIdentity(legacyArchitecture.releaseIdentity)
      : legacyStableIdentity({
          sourceSha: options.sourceSha ?? "",
          sourceTree: String(legacyArchitecture.sourceTree ?? ""),
          version: options.version ?? "",
        });
  const version = releaseIdentity.version;
  const sourceSha = releaseIdentity.sourceSha;
  const output = resolve(options.outputDirectory);
  ensureEmptyDirectory(output);
  const arm64Root = resolve(options.arm64Directory);
  const x64Root = resolve(options.x64Directory);
  const arm64 = readArchitectureDirectory(arm64Root);
  const x64 = readArchitectureDirectory(x64Root);
  const arm64Update = readUpdateDirectory(options.arm64UpdateDirectory, "arm64", version);
  const x64Update = readUpdateDirectory(options.x64UpdateDirectory, "x64", version);
  if (
    arm64.sourceSha !== sourceSha ||
    x64.sourceSha !== sourceSha ||
    arm64.sourceTree !== releaseIdentity.sourceTree ||
    x64.sourceTree !== releaseIdentity.sourceTree ||
    JSON.stringify(arm64.releaseIdentity) !== JSON.stringify(releaseIdentity) ||
    JSON.stringify(x64.releaseIdentity) !== JSON.stringify(releaseIdentity) ||
    arm64.sourceTree !== x64.sourceTree ||
    arm64Update.manifest.sourceSha !== sourceSha ||
    x64Update.manifest.sourceSha !== sourceSha ||
    arm64Update.manifest.channel !== releaseIdentity.channel ||
    x64Update.manifest.channel !== releaseIdentity.channel ||
    arm64Update.manifest.target.buildVersion !== releaseIdentity.buildVersion ||
    x64Update.manifest.target.buildVersion !== releaseIdentity.buildVersion ||
    arm64Update.manifest.target.teamIdentifier !== x64Update.manifest.target.teamIdentifier ||
    JSON.stringify(arm64.agentSkills) !== JSON.stringify(x64.agentSkills) ||
    JSON.stringify(arm64.runtimeLocks) !== JSON.stringify(x64.runtimeLocks)
  ) {
    throw new Error("Architecture and Sparkle builds do not share one release identity.");
  }

  const publicFiles: Array<{
    readonly architecture: MacArchitecture;
    readonly path: string;
    readonly role: ReleaseArtifactIdentity["role"];
  }> = [];
  const copy = (
    root: string,
    sourceName: string,
    role: ReleaseArtifactIdentity["role"],
    architecture: MacArchitecture,
    targetName = sourceName,
  ): void => {
    const target = join(output, targetName);
    copyFileSync(join(root, sourceName), target);
    publicFiles.push({ architecture, path: target, role });
  };
  for (const [architecture, architectureRoot, update] of [
    ["arm64", arm64Root, arm64Update],
    ["x64", x64Root, x64Update],
  ] as const) {
    const fullName = `Nodex-${version}-${architecture}.zip`;
    const fullPath = join(architectureRoot, fullName);
    if (
      lstatSync(fullPath).size !== update.manifest.full.bytes ||
      sha256File(fullPath) !== update.manifest.full.sha256
    ) {
      throw new Error(`${architecture} full update does not match its Sparkle manifest.`);
    }
    copy(
      architectureRoot,
      `Nodex-${version}-${architecture}.dmg`,
      "dmg",
      architecture,
      releaseIdentity.channel === "stable" ? `Nodex-latest-${architecture}.dmg` : undefined,
    );
    copy(architectureRoot, fullName, "sparkle-full", architecture);
    copy(update.root, update.manifest.appcast.name, "sparkle-appcast", architecture);
    copy(update.root, update.manifestName, "sparkle-update-manifest", architecture);
    for (const delta of update.manifest.deltas) {
      copy(update.root, delta.name, "sparkle-delta", architecture);
    }
  }

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
      arm64: {
        manifestSha256: sha256File(join(arm64Root, "architecture-build.json")),
        preparedBuildGeneration: arm64.preparedBuild.generation,
        updateManifestSha256: sha256File(arm64Update.manifestPath),
      },
      x64: {
        manifestSha256: sha256File(join(x64Root, "architecture-build.json")),
        preparedBuildGeneration: x64.preparedBuild.generation,
        updateManifestSha256: sha256File(x64Update.manifestPath),
      },
    },
    assets,
    runtimeLocks: arm64.runtimeLocks,
    schemaVersion: 2,
    releaseIdentity,
    sourceSha,
    sourceTree: arm64.sourceTree,
    tag: releaseIdentity.tag,
    version,
  };
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
