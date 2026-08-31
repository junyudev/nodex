import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { inspectOfficialAgentSkillsArtifact } from "./official-agent-skills-artifact.mjs";
import { SOURCE_ONLY_ELECTRON_MAIN_DEPENDENCIES } from "../config/electron-main-runtime-closure";
import { parseReleaseIdentity, type ReleaseIdentity } from "./release/model";

const MANIFEST_SCHEMA_VERSION = 4;
const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const defaultManifestPath = path.join(repositoryRoot, ".generated/prepared-electron-build.json");
const IGNORED_INPUT_DIRECTORY_NAMES = new Set([
  ".generated",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

const REQUIRED_INPUT_PATHS = [
  ".cargo",
  "agent-skills",
  "config",
  "crates",
  "native",
  "packages/codex-app-server-protocol",
  "packages/core-protocol",
  "packages/effect-codex-app-server",
  "resources",
  "scripts",
  "src",
  "third_party/blocknote/packages",
  ".node-version",
  "Cargo.lock",
  "Cargo.toml",
  "LICENSE",
  "electron-builder.yml",
  "electron.vite.config.ts",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "rust-toolchain.toml",
  "tsconfig.json",
  "tsconfig.node.json",
  "tsconfig.web.json",
] as const;

const PREREQUISITE_SOURCE_PATHS = [
  "agent-skills",
  "resources/icon.icon",
  "resources/nodex-icon.svg",
  "resources/third-party/codex",
  "scripts/build-resources.ts",
  "scripts/generate-third-party-notices.ts",
  "scripts/official-agent-skills-artifact.d.mts",
  "scripts/official-agent-skills-artifact.mjs",
  "scripts/official-agent-skills.ts",
  "scripts/sync-app-icons.ts",
  "src/shared/nfm/agent-guide.ts",
  "src/shared/nfm/parser.ts",
  "src/shared/nfm/serializer.ts",
  "src/shared/build-resources.ts",
  "Cargo.lock",
  "Cargo.toml",
  "LICENSE",
  "package.json",
  "pnpm-lock.yaml",
] as const;

interface FileDigest {
  readonly executable: boolean;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

interface PreparedBuildSource {
  readonly baseCommit: string | null;
  readonly baseTree: string | null;
  readonly snapshotDigest: string;
  readonly state: "clean" | "dirty" | "snapshot";
}

interface PreparedBuildProduct {
  readonly name: string;
  readonly version: string;
}

interface PreparedAgentSkills {
  readonly manifestSha256: string;
  readonly treeSha256: string;
}

const escapeRegularExpression = (value: string): string =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const assertMainDependenciesAreBundled = (root: string, outputs: readonly FileDigest[]): void => {
  const mainJavaScriptOutputs = outputs.filter(
    ({ path: outputPath }) =>
      outputPath.startsWith("out/main/") && /\.(?:c|m)?js$/u.test(outputPath),
  );
  for (const dependency of SOURCE_ONLY_ELECTRON_MAIN_DEPENDENCIES) {
    const escapedDependency = escapeRegularExpression(dependency);
    const runtimeLoad = new RegExp(
      String.raw`\brequire\s*\(\s*["']${escapedDependency}(?:/[^"']*)?["']\s*\)`,
      "u",
    );
    for (const output of mainJavaScriptOutputs) {
      const source = readFileSync(path.join(root, output.path), "utf8");
      if (!runtimeLoad.test(source)) continue;
      throw new Error(
        `Prepared Electron Main output externalizes source-only workspace dependency ${dependency}; bundle it before packaging.`,
      );
    }
  }
};

export interface PreparedElectronBuildManifest {
  readonly agentSkills: PreparedAgentSkills;
  readonly buildContext: Record<string, string>;
  readonly generationId: string;
  readonly inputDigest: string;
  readonly outputs: readonly FileDigest[];
  readonly product: PreparedBuildProduct;
  readonly releaseIdentity: ReleaseIdentity | null;
  readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  readonly source: PreparedBuildSource;
}

export interface PreparedElectronBuildOptions {
  readonly manifestPath?: string;
  readonly repositoryRoot: string;
}

const hashFile = (filePath: string): string => {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(filePath, "r");
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
};

const normalizeRelativePath = (root: string, filePath: string): string =>
  path.relative(root, filePath).split(path.sep).join("/");

const collectFiles = (
  root: string,
  entryPath: string,
  ignoreGeneratedInputDirectories = false,
): FileDigest[] => {
  const stats = lstatSync(entryPath);
  if (stats.isSymbolicLink()) {
    throw new Error(`Prepared build inputs and outputs must not be symlinks: ${entryPath}`);
  }
  if (stats.isFile()) {
    return [
      {
        executable: (stats.mode & 0o111) !== 0,
        path: normalizeRelativePath(root, entryPath),
        sha256: hashFile(entryPath),
        size: stats.size,
      },
    ];
  }
  if (!stats.isDirectory()) {
    throw new Error(`Prepared build encountered an unsupported filesystem entry: ${entryPath}`);
  }
  return readdirSync(entryPath, { withFileTypes: true })
    .filter(
      (entry) => !ignoreGeneratedInputDirectories || !IGNORED_INPUT_DIRECTORY_NAMES.has(entry.name),
    )
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) =>
      collectFiles(root, path.join(entryPath, entry.name), ignoreGeneratedInputDirectories),
    );
};

const collectCargoManifests = (currentPath: string): string[] =>
  readdirSync(currentPath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry): string[] => {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) return collectCargoManifests(entryPath);
      if (entry.isFile() && entry.name === "Cargo.toml") return [entryPath];
      return [];
    });

const buildContext = (): Record<string, string> => {
  const viteEnvironment = Object.entries(process.env)
    .filter(([key]) => key.startsWith("VITE_"))
    .sort(([left], [right]) => left.localeCompare(right));
  const sensitiveBuildVariables = [
    "SENTRY_AUTH_TOKEN",
    "SENTRY_ORG",
    "SENTRY_PROJECT",
    "SENTRY_RELEASE",
  ] as const;
  const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
  return Object.fromEntries([
    ["arch", process.arch],
    ["node", process.version],
    ["nodeEnv", process.env.NODE_ENV ?? ""],
    ["platform", process.platform],
    [
      "releaseIdentity",
      process.env.NODEX_RELEASE_IDENTITY_PATH
        ? hashFile(process.env.NODEX_RELEASE_IDENTITY_PATH)
        : "",
    ],
    ...sensitiveBuildVariables.map((key) => [key, digest(process.env[key] ?? "")]),
    ...viteEnvironment.map(([key, value]) => [key, digest(value ?? "")]),
  ]);
};

const digestInventory = (files: readonly FileDigest[], context: Record<string, string>): string =>
  createHash("sha256").update(JSON.stringify({ context, files })).digest("hex");

const sha256Json = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const inputInventory = (root: string): FileDigest[] => {
  const configuredInputs = REQUIRED_INPUT_PATHS.flatMap((relativePath) => {
    const absolutePath = path.join(root, relativePath);
    if (!existsSync(absolutePath)) {
      throw new Error(`Prepared build input is missing: ${relativePath}`);
    }
    return collectFiles(root, absolutePath, true);
  });
  const environmentFiles = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.name === ".env" || entry.name.startsWith(".env."))
    .flatMap((entry) => collectFiles(root, path.join(root, entry.name)));
  return [...configuredInputs, ...environmentFiles].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
};

const currentInputDigest = (root: string): string =>
  digestInventory(inputInventory(root), buildContext());

const currentAgentSkills = (root: string): PreparedAgentSkills => {
  const inspected = inspectOfficialAgentSkillsArtifact(
    path.join(root, ".generated/official-agent-skills"),
  );
  return {
    manifestSha256: inspected.manifestSha256,
    treeSha256: inspected.treeSha256,
  };
};

const readGitValue = (root: string, arguments_: readonly string[]): string | null => {
  const result = spawnSync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value || null;
};

const readSource = (root: string, snapshotDigest: string): PreparedBuildSource => {
  const baseCommit = readGitValue(root, ["rev-parse", "HEAD"]);
  const baseTree = readGitValue(root, ["rev-parse", "HEAD^{tree}"]);
  if (!baseCommit || !baseTree) {
    return {
      baseCommit: null,
      baseTree: null,
      snapshotDigest,
      state: "snapshot",
    };
  }
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return {
    baseCommit,
    baseTree,
    snapshotDigest,
    state: status.status === 0 && status.stdout.trim().length === 0 ? "clean" : "dirty",
  };
};

const readReleaseIdentity = (root: string): ReleaseIdentity | null => {
  const identityPath = process.env.NODEX_RELEASE_IDENTITY_PATH;
  if (!identityPath) return null;
  const identity = parseReleaseIdentity(JSON.parse(readFileSync(identityPath, "utf8")) as unknown);
  if (
    readGitValue(root, ["rev-parse", "HEAD"]) !== identity.sourceSha ||
    readGitValue(root, ["rev-parse", "HEAD^{tree}"]) !== identity.sourceTree
  ) {
    throw new Error("Release Identity does not match the prepared source checkout.");
  }
  return identity;
};

const readProduct = (root: string, identity: ReleaseIdentity | null): PreparedBuildProduct => {
  const value = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
    readonly name?: unknown;
    readonly version?: unknown;
  };
  if (typeof value.name !== "string" || typeof value.version !== "string") {
    throw new Error("Prepared Electron build package metadata is invalid.");
  }
  if (identity && identity.sourceVersion !== value.version) {
    throw new Error("Release Identity sourceVersion does not match package.json.");
  }
  return { name: value.name, version: identity?.version ?? value.version };
};

const generationIdFor = (manifest: Omit<PreparedElectronBuildManifest, "generationId">): string =>
  sha256Json(manifest);

const currentPrerequisiteSourceDigest = (root: string): string => {
  const files = PREREQUISITE_SOURCE_PATHS.flatMap((relativePath) =>
    collectFiles(root, path.join(root, relativePath), true),
  );
  const cargoManifests = collectCargoManifests(path.join(root, "crates")).flatMap((manifestPath) =>
    collectFiles(root, manifestPath),
  );
  return digestInventory(
    [...files, ...cargoManifests].sort((left, right) => left.path.localeCompare(right.path)),
    {},
  );
};

const outputInventory = (root: string): FileDigest[] => {
  const outputRoot = path.join(root, "out");
  if (!existsSync(outputRoot)) {
    throw new Error("Prepared Electron output is missing; run the normal build first.");
  }
  const files = collectFiles(root, outputRoot).sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  if (files.length === 0) {
    throw new Error("Prepared Electron output is empty; run the normal build first.");
  }
  assertMainDependenciesAreBundled(root, files);
  return files;
};

const manifestPathFor = (options: PreparedElectronBuildOptions): string =>
  path.resolve(
    options.manifestPath ??
      path.join(options.repositoryRoot, ".generated/prepared-electron-build.json"),
  );

const writeManifest = (manifestPath: string, manifest: PreparedElectronBuildManifest): void => {
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  const temporaryPath = `${manifestPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, manifestPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
};

export function recordPreparedElectronBuild(
  options: PreparedElectronBuildOptions,
  expectedInputDigest?: string,
  expectedAgentSkills?: PreparedAgentSkills,
): PreparedElectronBuildManifest {
  const root = path.resolve(options.repositoryRoot);
  const beforeOutputs = currentInputDigest(root);
  const beforeAgentSkills = currentAgentSkills(root);
  if (expectedInputDigest && beforeOutputs !== expectedInputDigest) {
    throw new Error("Electron build inputs changed while the production build was running.");
  }
  if (
    expectedAgentSkills &&
    JSON.stringify(beforeAgentSkills) !== JSON.stringify(expectedAgentSkills)
  ) {
    throw new Error("Official Agent Skills changed while the production build was running.");
  }
  const outputs = outputInventory(root);
  const afterOutputs = currentInputDigest(root);
  const afterAgentSkills = currentAgentSkills(root);
  if (beforeOutputs !== afterOutputs) {
    throw new Error("Electron build inputs changed while outputs were being recorded.");
  }
  if (JSON.stringify(beforeAgentSkills) !== JSON.stringify(afterAgentSkills)) {
    throw new Error("Official Agent Skills changed while outputs were being recorded.");
  }
  const releaseIdentity = readReleaseIdentity(root);
  const manifestWithoutGeneration = {
    agentSkills: afterAgentSkills,
    buildContext: buildContext(),
    inputDigest: afterOutputs,
    outputs,
    product: readProduct(root, releaseIdentity),
    releaseIdentity,
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    source: readSource(root, afterOutputs),
  } satisfies Omit<PreparedElectronBuildManifest, "generationId">;
  const manifest: PreparedElectronBuildManifest = {
    ...manifestWithoutGeneration,
    generationId: generationIdFor(manifestWithoutGeneration),
  };
  writeManifest(manifestPathFor(options), manifest);
  return manifest;
}

const parseManifest = (value: unknown): PreparedElectronBuildManifest => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Prepared Electron build manifest is invalid.");
  }
  const candidate = value as Partial<PreparedElectronBuildManifest>;
  if (
    candidate.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    typeof candidate.agentSkills !== "object" ||
    candidate.agentSkills === null ||
    typeof candidate.generationId !== "string" ||
    typeof candidate.inputDigest !== "string" ||
    !Array.isArray(candidate.outputs) ||
    typeof candidate.buildContext !== "object" ||
    candidate.buildContext === null ||
    typeof candidate.product !== "object" ||
    candidate.product === null ||
    typeof candidate.source !== "object" ||
    !(candidate.releaseIdentity === null || typeof candidate.releaseIdentity === "object") ||
    candidate.source === null
  ) {
    throw new Error("Prepared Electron build manifest is invalid.");
  }
  const manifest = candidate as PreparedElectronBuildManifest;
  if (manifest.releaseIdentity !== null) parseReleaseIdentity(manifest.releaseIdentity);
  const { generationId, ...manifestWithoutGeneration } = manifest;
  if (generationId !== generationIdFor(manifestWithoutGeneration)) {
    throw new Error("Prepared Electron build generation identity is invalid.");
  }
  return manifest;
};

export function verifyPreparedElectronBuild(
  options: PreparedElectronBuildOptions,
): PreparedElectronBuildManifest {
  const root = path.resolve(options.repositoryRoot);
  const manifestPath = manifestPathFor(options);
  if (!existsSync(manifestPath)) {
    throw new Error("No prepared Electron build is available; run without --reuse-build first.");
  }
  let manifest: PreparedElectronBuildManifest;
  try {
    manifest = parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Prepared Electron")) throw error;
    throw new Error("Prepared Electron build manifest is invalid.", { cause: error });
  }
  if (manifest.inputDigest !== currentInputDigest(root)) {
    throw new Error("Prepared Electron build inputs are stale; run without --reuse-build first.");
  }
  if (JSON.stringify(manifest.agentSkills) !== JSON.stringify(currentAgentSkills(root))) {
    throw new Error("Prepared Electron build uses stale or damaged official Agent Skills.");
  }
  const outputs = outputInventory(root);
  if (JSON.stringify(outputs) !== JSON.stringify(manifest.outputs)) {
    throw new Error(
      "Prepared Electron build outputs are stale or damaged; run without --reuse-build first.",
    );
  }
  return manifest;
}

function runProductionBuild(): void {
  rmSync(defaultManifestPath, { force: true });
  const beforePrerequisites = currentPrerequisiteSourceDigest(repositoryRoot);
  const agentSkillsCommand =
    process.env.NODEX_AGENT_SKILLS_REQUIRE_PREGENERATED === "1"
      ? "agent-skills:verify"
      : "agent-skills:generate";
  for (const script of [agentSkillsCommand, "build-resources:prepare", "sync:icons"]) {
    execFileSync("pnpm", ["--silent", "run", script], {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
  }
  if (beforePrerequisites !== currentPrerequisiteSourceDigest(repositoryRoot)) {
    throw new Error("Build prerequisite inputs changed while generated resources were prepared.");
  }
  const beforeBuild = currentInputDigest(repositoryRoot);
  const agentSkills = currentAgentSkills(repositoryRoot);
  execFileSync("pnpm", ["exec", "electron-vite", "build", "--logLevel", "warn"], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  // SSH hosts cannot load Electron's split Main chunks or its local
  // node_modules tree. Ship one content-addressable, dependency-contained Node
  // worker that can be copied to a trusted remote login over stdin.
  execFileSync(
    "pnpm",
    [
      "exec",
      "esbuild",
      "src/main/worktree-worker/stdio-entry.ts",
      "--bundle",
      "--platform=node",
      "--format=cjs",
      "--target=node20",
      "--outfile=out/main/remote-worktree-worker.cjs",
    ],
    { cwd: repositoryRoot, stdio: "inherit" },
  );
  recordPreparedElectronBuild(
    { repositoryRoot, manifestPath: defaultManifestPath },
    beforeBuild,
    agentSkills,
  );
}

function main(): void {
  const [command, ...extraArguments] = process.argv.slice(2);
  if (extraArguments.length > 0 || (command !== "build" && command !== "verify")) {
    throw new Error("Usage: prepared-electron-build.ts <build|verify>");
  }
  if (command === "build") {
    runProductionBuild();
    return;
  }
  verifyPreparedElectronBuild({ repositoryRoot, manifestPath: defaultManifestPath });
  process.stdout.write("Prepared Electron build verified.\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
