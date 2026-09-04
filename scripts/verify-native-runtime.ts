import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import {
  readNativeRuntimeManifest,
  sha256File,
  type NativeRuntimeArchitecture,
} from "./native-runtime-manifest";
import {
  compareMacosVersions,
  parseOtoolMinimumMacosVersion,
} from "./agent-runtime-macos-platform-contract";
import { cleanupIsolatedCore } from "./isolated-core-cleanup";
import { verifyPackagedAgentSkills } from "./verify-packaged-agent-skills";
import { layer as mainShutdownLive } from "../src/main/app/MainShutdown";
import {
  InitialProjectBootstrapRuntime,
  live as initialProjectBootstrapLive,
} from "../src/main/initial-project/InitialProjectBootstrapRuntime";
import { resolveInitialProjectJournalPath } from "../src/main/initial-project/initial-project-journal-store";
import {
  acquireIsolatedRunLease,
  ISOLATED_RUN_ID_ENV,
  readIsolatedRunClaim,
} from "../src/main/core-client/isolated-run-ownership";
import {
  CoreSessionAccess,
  live as coreAuthorityLive,
} from "../src/main/core-runtime/CoreAuthority";
import { CoreModules, live as coreModulesLive } from "../src/main/core-runtime/CoreModules";
import { live as coreTransportLive } from "../src/main/core-runtime/CoreTransport";
import {
  make as makeProjectWorkspace,
  ProjectWorkspace,
} from "../src/main/project-application/ProjectWorkspace";
import { decodeXmlCharacterReferences } from "../src/shared/xml-character-references";

export class PackagedNativeRuntimeVerificationError extends Schema.TaggedError<PackagedNativeRuntimeVerificationError>()(
  "PackagedNativeRuntimeVerificationError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const attempt = <A>(operation: string, evaluate: () => A) =>
  Effect.try({
    try: evaluate,
    catch: (cause) => new PackagedNativeRuntimeVerificationError({ operation, cause }),
  });

const attemptPromise = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new PackagedNativeRuntimeVerificationError({ operation, cause }),
  });

export interface PackagedNativeRuntimeStructureOptions {
  readonly appPath: string;
  /** The human-facing CFBundleShortVersionString encoded in the app. */
  readonly expectedVersion: string;
  /** The monotonic Apple CFBundleVersion used for update ordering. */
  readonly expectedBuildVersion: string;
  readonly requireDeveloperId: boolean;
  readonly targetArch: NativeRuntimeArchitecture;
  readonly expectedUpdateChannel?: "disabled" | "stable" | "nightly";
  readonly verifyNotarization: boolean;
  readonly verifySignatures: boolean;
}

export interface PackagedNativeRuntimeSmokeOptions extends PackagedNativeRuntimeStructureOptions {
  readonly launchApp: boolean;
  readonly previousStoreFixturePath?: string;
}

export interface PackagedNativeRuntimeIdentity {
  readonly appPath: string;
  readonly coreSha256: string;
  readonly expectedVersion: string;
  readonly targetArch: NativeRuntimeArchitecture;
}

interface CommandResult {
  readonly stderr: string;
  readonly stdout: string;
}

export type PackagedMacCodeObjectRole =
  | "electron-helper"
  | "main-app"
  | "native-helper"
  | "sparkle";

export interface PackagedMacCodeObjectEntitlements {
  readonly artifactPath: string;
  readonly entitlements: Readonly<Record<string, boolean | "present">>;
  readonly role: PackagedMacCodeObjectRole;
}

const MAC_AUDIO_INPUT_ENTITLEMENT = "com.apple.security.device.audio-input";
const MAC_SANDBOX_MICROPHONE_ENTITLEMENT = "com.apple.security.device.microphone";
const ELECTRON_RUNTIME_ENTITLEMENTS = [
  "com.apple.security.cs.allow-dyld-environment-variables",
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
] as const;

/** Parses the boolean capability shape emitted by `codesign --entitlements :-`. */
export function parseMacCodeSigningEntitlements(
  output: string,
): Readonly<Record<string, boolean | "present">> {
  const entitlements: Record<string, boolean | "present"> = {};
  const entries = output.matchAll(/<key>\s*([^<]+?)\s*<\/key>\s*(?:<(true|false)\s*\/>|<[^>]+>)/gu);
  for (const [, rawKey, booleanValue] of entries) {
    if (!rawKey) continue;
    const key = decodeXmlCharacterReferences(rawKey.trim());
    if (!key || Object.hasOwn(entitlements, key)) {
      throw new Error("Code signing entitlements contain an invalid or duplicate key");
    }
    entitlements[key] = booleanValue ? booleanValue === "true" : "present";
  }
  return entitlements;
}

/** Enforces least privilege across the final signed macOS code-object closure. */
export function assertPackagedMacCodeObjectEntitlements(
  codeObjects: readonly PackagedMacCodeObjectEntitlements[],
): void {
  const mainApps = codeObjects.filter(({ role }) => role === "main-app");
  if (mainApps.length !== 1) {
    throw new Error(`Expected one main app entitlement record, found ${mainApps.length}`);
  }

  const seenPaths = new Set<string>();
  for (const codeObject of codeObjects) {
    if (seenPaths.has(codeObject.artifactPath)) {
      throw new Error(`Duplicate code object entitlement record: ${codeObject.artifactPath}`);
    }
    seenPaths.add(codeObject.artifactPath);

    if (Object.hasOwn(codeObject.entitlements, MAC_SANDBOX_MICROPHONE_ENTITLEMENT)) {
      throw new Error(
        `Hardened runtime code object carries the App Sandbox microphone entitlement: ${codeObject.artifactPath}`,
      );
    }

    if (codeObject.role === "main-app") {
      if (codeObject.entitlements[MAC_AUDIO_INPUT_ENTITLEMENT] !== true) {
        throw new Error(
          `Packaged main app lacks audio-input entitlement: ${codeObject.artifactPath}`,
        );
      }
      continue;
    }

    if (Object.hasOwn(codeObject.entitlements, MAC_AUDIO_INPUT_ENTITLEMENT)) {
      throw new Error(
        `Microphone entitlement leaked outside the main app: ${codeObject.artifactPath}`,
      );
    }

    if (
      (codeObject.role === "native-helper" || codeObject.role === "sparkle") &&
      ELECTRON_RUNTIME_ENTITLEMENTS.some((key) => Object.hasOwn(codeObject.entitlements, key))
    ) {
      throw new Error(
        `Non-Electron code object carries Electron runtime entitlements: ${codeObject.artifactPath}`,
      );
    }
  }
}

const expectedFileArchitecture = (architecture: NativeRuntimeArchitecture): string =>
  architecture === "arm64" ? "arm64" : "x86_64";

const DEFAULT_PREVIOUS_STORE_FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../crates/nodex-core/tests/fixtures/store-v130.db",
);

const STORE_MIGRATION_BACKUP_NAME = /^v([1-9]\d*)-to-v([1-9]\d*)-([a-f0-9]{64})\.db$/u;
const STORE_FIXTURE_NAME = /^store-v([1-9]\d*)\.db$/u;

export const assertContentAddressedStoreMigrationBackup = (
  backupPath: string,
  expected: { readonly sourceRevision: number; readonly targetRevision: number },
): void => {
  const metadata = lstatSync(backupPath);
  const match = STORE_MIGRATION_BACKUP_NAME.exec(basename(backupPath));
  if (!metadata.isFile() || metadata.isSymbolicLink() || !match) {
    throw new Error("Packaged Store migration did not retain one content-addressed backup");
  }
  if (
    Number(match[1]) !== expected.sourceRevision ||
    Number(match[2]) !== expected.targetRevision ||
    expected.targetRevision <= expected.sourceRevision
  ) {
    throw new Error("Packaged Store migration backup transition does not match the runtime");
  }
  if (sha256File(backupPath) !== match[3]) {
    throw new Error("Packaged Store migration backup digest does not match its filename");
  }
};

const storeFixtureRevision = (fixturePath: string): number => {
  const revision = Number(STORE_FIXTURE_NAME.exec(basename(fixturePath))?.[1]);
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new Error("Packaged Store migration fixture must use the canonical store-vN.db name");
  }
  return revision;
};

const currentStoreRevision = (descriptorPath: string): number => {
  const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as {
    readonly actual_store_format?: { readonly version?: unknown };
    readonly manifest?: { readonly store?: { readonly current?: { readonly version?: unknown } } };
  };
  const advertised = descriptor.manifest?.store?.current?.version;
  const actual = descriptor.actual_store_format?.version;
  if (!Number.isSafeInteger(advertised) || !Number.isSafeInteger(actual) || advertised !== actual) {
    throw new Error("Packaged Core published inconsistent Store revision evidence");
  }
  return actual as number;
};

const run = (command: string, arguments_: readonly string[], label: string): CommandResult => {
  const result = spawnSync(command, arguments_, { encoding: "utf8" });
  if (result.error) throw new Error(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `${label} failed with status ${result.status}: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return { stderr: result.stderr, stdout: result.stdout };
};

export function readMacCodeObjectEntitlements(
  artifactPath: string,
): Readonly<Record<string, boolean | "present">> {
  const result = run(
    "codesign",
    ["-d", "--entitlements", ":-", artifactPath],
    `Inspect ${artifactPath} entitlements`,
  );
  return parseMacCodeSigningEntitlements(`${result.stdout}\n${result.stderr}`);
}

const assertRegularExecutable = (filePath: string): void => {
  const metadata = lstatSync(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Native runtime entry must be a regular file: ${filePath}`);
  }
  if ((metadata.mode & 0o111) === 0) {
    throw new Error(`Native runtime entry is not executable: ${filePath}`);
  }
};

const readPlistMinimumMacos = (plistPath: string, label: string): string =>
  run(
    "/usr/bin/plutil",
    ["-extract", "LSMinimumSystemVersion", "raw", "-o", "-", plistPath],
    `Read ${label} minimum macOS`,
  ).stdout.trim();

const assertPlistMinimumMacos = (plistPath: string, expected: string, label: string): void => {
  const minimum = readPlistMinimumMacos(plistPath, label);
  const normalize = (value: string): string => {
    if (!/^\d+(?:\.\d+){0,2}$/u.test(value)) return value;
    const parts = value.split(".");
    return [parts[0], parts[1] ?? "0", parts[2] ?? "0"].join(".");
  };
  if (normalize(minimum) !== normalize(expected)) {
    throw new Error(`${label} minimum macOS is ${minimum}, expected ${expected}`);
  }
};

const assertPlistMinimumNotNewerThan = (
  plistPath: string,
  maximumMacOS: string,
  label: string,
): void => {
  const minimum = readPlistMinimumMacos(plistPath, label);
  if (compareMacosVersions(minimum, maximumMacOS) <= 0) return;
  throw new Error(
    `${label} requires macOS ${minimum}, newer than the product minimum ${maximumMacOS}`,
  );
};

const assertMachO = (
  filePath: string,
  architecture: NativeRuntimeArchitecture,
  minimumMacOS: string,
): void => {
  assertMachOArchitecture(filePath, architecture);
  const loadCommands = run("otool", ["-l", filePath], `Inspect ${filePath} load commands`).stdout;
  if (
    !new RegExp(`LC_BUILD_VERSION[\\s\\S]*?minos ${minimumMacOS.replace(".", "\\.")}\\b`).test(
      loadCommands,
    )
  ) {
    throw new Error(`Native runtime minimum macOS mismatch for ${filePath}`);
  }
};

const assertMachONotNewerThan = (
  filePath: string,
  architecture: NativeRuntimeArchitecture,
  maximumMacOS: string,
): void => {
  const minimumMacOS = parseOtoolMinimumMacosVersion(
    run(
      "otool",
      ["-arch", expectedFileArchitecture(architecture), "-l", filePath],
      `Inspect ${filePath} minimum macOS`,
    ).stdout,
  );
  if (compareMacosVersions(minimumMacOS, maximumMacOS) <= 0) return;
  throw new Error(
    `Packaged nested binary ${filePath} requires macOS ${minimumMacOS}, ` +
      `newer than the product minimum ${maximumMacOS}`,
  );
};

const assertMachOArchitecture = (
  filePath: string,
  architecture: NativeRuntimeArchitecture,
): void => {
  const description = run("file", ["-b", filePath], `Inspect ${filePath}`).stdout.trim();
  const expectedArchitecture = expectedFileArchitecture(architecture);
  if (!description.includes("Mach-O") || !description.includes(expectedArchitecture)) {
    throw new Error(`Native runtime architecture mismatch for ${filePath}: ${description}`);
  }
};

const signatureDetails = (
  artifactPath: string,
): { adhoc: boolean; teamIdentifier: string | null } => {
  run("codesign", ["--verify", "--strict", "--verbose=2", artifactPath], `Verify ${artifactPath}`);
  const display = run("codesign", ["-dv", "--verbose=4", artifactPath], `Inspect ${artifactPath}`);
  const output = `${display.stdout}\n${display.stderr}`;
  const team = /^TeamIdentifier=(.+)$/mu.exec(output)?.[1]?.trim();
  return {
    adhoc: /(?:^|,)adhoc(?:,|\))/mu.test(output) || /^Signature=adhoc$/mu.test(output),
    teamIdentifier: !team || team === "not set" ? null : team,
  };
};

const verifySignatures = (
  appPath: string,
  binaryPaths: readonly string[],
  requireDeveloperId: boolean,
): void => {
  const helperApp = join(appPath, "Contents/Helpers/Nodex Service.app");
  const appSignature = signatureDetails(appPath);
  const nestedSignatures = [...binaryPaths.map(signatureDetails), signatureDetails(helperApp)];
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], "Verify app seal");
  if (!requireDeveloperId) return;
  if (appSignature.adhoc || !appSignature.teamIdentifier) {
    throw new Error("Packaged Nodex.app is not signed with a Developer ID identity");
  }
  for (const signature of nestedSignatures) {
    if (signature.adhoc || signature.teamIdentifier !== appSignature.teamIdentifier) {
      throw new Error("Native runtime signature is inconsistent with the enclosing Nodex.app");
    }
  }
};

const verifyMacCodeObjectEntitlements = (input: {
  readonly appPath: string;
  readonly nativeCodeObjects: readonly string[];
  readonly sparkleCodeObjects: readonly string[];
}): void => {
  const productName = basename(input.appPath, ".app");
  const electronCodeObjects = [
    join(input.appPath, "Contents/Frameworks/Electron Framework.framework"),
    join(input.appPath, `Contents/Frameworks/${productName} Helper.app`),
    join(input.appPath, `Contents/Frameworks/${productName} Helper (GPU).app`),
    join(input.appPath, `Contents/Frameworks/${productName} Helper (Plugin).app`),
    join(input.appPath, `Contents/Frameworks/${productName} Helper (Renderer).app`),
  ];
  for (const artifactPath of electronCodeObjects) {
    if (!existsSync(artifactPath)) {
      throw new Error(`Packaged Electron code-object closure is incomplete: ${artifactPath}`);
    }
  }

  const nativeHelperApp = join(input.appPath, "Contents/Helpers/Nodex Service.app");
  const records: PackagedMacCodeObjectEntitlements[] = [
    {
      artifactPath: input.appPath,
      entitlements: readMacCodeObjectEntitlements(input.appPath),
      role: "main-app",
    },
    ...electronCodeObjects.map((artifactPath) => ({
      artifactPath,
      entitlements: readMacCodeObjectEntitlements(artifactPath),
      role: "electron-helper" as const,
    })),
    ...[...input.nativeCodeObjects, nativeHelperApp].map((artifactPath) => ({
      artifactPath,
      entitlements: readMacCodeObjectEntitlements(artifactPath),
      role: "native-helper" as const,
    })),
    ...input.sparkleCodeObjects.map((artifactPath) => ({
      artifactPath,
      entitlements: readMacCodeObjectEntitlements(artifactPath),
      role: "sparkle" as const,
    })),
  ];
  assertPackagedMacCodeObjectEntitlements(records);
};

const assertSymlinksStayInside = (rootPath: string, currentPath = rootPath): void => {
  const canonicalRoot = realpathSync(rootPath);
  for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
    const entryPath = join(currentPath, entry.name);
    const metadata = lstatSync(entryPath);
    if (metadata.isSymbolicLink()) {
      const target = readlinkSync(entryPath);
      const resolvedTarget = realpathSync(resolve(dirname(entryPath), target));
      const relativeTarget = relative(canonicalRoot, resolvedTarget);
      if (
        target.startsWith("/") ||
        relativeTarget === ".." ||
        relativeTarget.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
        resolve(canonicalRoot, relativeTarget) !== resolvedTarget
      ) {
        throw new Error(`Sparkle framework symlink escapes its root: ${entryPath}`);
      }
      continue;
    }
    if (metadata.isDirectory()) assertSymlinksStayInside(rootPath, entryPath);
  }
};

const verifySparkleRuntime = (
  appPath: string,
  options: PackagedNativeRuntimeStructureOptions,
): readonly string[] => {
  const contentsPath = join(appPath, "Contents");
  const resourcesPath = join(contentsPath, "Resources");
  const manifestPath = join(resourcesPath, "native/sparkle-runtime.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    readonly architecture?: unknown;
    readonly artifacts?: Record<
      string,
      { readonly path?: unknown; readonly sha256?: unknown; readonly size?: unknown }
    >;
    readonly buildChannel?: unknown;
    readonly feedUrls?: Record<string, unknown> | null;
    readonly minimumMacOS?: unknown;
    readonly publicKey?: unknown;
    readonly schemaVersion?: unknown;
    readonly sparkleVersion?: unknown;
  };
  const expectedPaths = {
    autoupdate: "Frameworks/Sparkle.framework/Versions/B/Autoupdate",
    bridge: "Resources/native/nodex-sparkle.node",
    frameworkExecutable: "Frameworks/Sparkle.framework/Versions/B/Sparkle",
    frameworkInfoPlist: "Frameworks/Sparkle.framework/Versions/B/Resources/Info.plist",
    updater: "Frameworks/Sparkle.framework/Versions/B/Updater.app/Contents/MacOS/Updater",
  };
  if (
    manifest.schemaVersion !== 3 ||
    manifest.architecture !== options.targetArch ||
    (manifest.buildChannel !== "disabled" &&
      manifest.buildChannel !== "stable" &&
      manifest.buildChannel !== "nightly") ||
    (options.expectedUpdateChannel && manifest.buildChannel !== options.expectedUpdateChannel) ||
    manifest.minimumMacOS !== "15.0" ||
    manifest.sparkleVersion !== "2.9.4" ||
    typeof manifest.publicKey !== "string" ||
    !manifest.artifacts
  ) {
    throw new Error("Packaged Sparkle runtime manifest is invalid.");
  }
  const expectedFeeds = {
    stable: `https://nodex.jyu.app/updates/stable/${options.targetArch}/appcast.xml`,
    nightly: `https://nodex.jyu.app/updates/nightly/${options.targetArch}/appcast.xml`,
  };
  if (
    (manifest.buildChannel === "disabled" && manifest.feedUrls !== null) ||
    (manifest.buildChannel !== "disabled" &&
      (manifest.feedUrls?.stable !== expectedFeeds.stable ||
        manifest.feedUrls?.nightly !== expectedFeeds.nightly))
  ) {
    throw new Error("Packaged Sparkle feed does not match its channel.");
  }
  for (const [name, relativePath] of Object.entries(expectedPaths)) {
    const identity = manifest.artifacts?.[name];
    const filePath = join(contentsPath, ...relativePath.split("/"));
    const metadata = lstatSync(filePath);
    if (
      identity?.path !== relativePath ||
      identity.sha256 !== sha256File(filePath) ||
      identity.size !== metadata.size ||
      metadata.isSymbolicLink() ||
      !metadata.isFile()
    ) {
      throw new Error(`Packaged Sparkle artifact identity mismatch: ${name}.`);
    }
  }
  const frameworkPath = join(contentsPath, "Frameworks/Sparkle.framework");
  assertSymlinksStayInside(frameworkPath);
  if (
    existsSync(join(frameworkPath, "Versions/B/XPCServices")) ||
    existsSync(join(frameworkPath, "XPCServices"))
  ) {
    throw new Error("Packaged non-sandboxed Sparkle framework must not contain XPC services.");
  }
  const bridgePath = join(resourcesPath, "native/nodex-sparkle.node");
  assertRegularExecutable(bridgePath);
  assertMachO(bridgePath, options.targetArch, "15.0");
  const linkage = run("otool", ["-L", bridgePath], "Inspect Sparkle bridge linkage").stdout;
  const loadCommands = run("otool", ["-l", bridgePath], "Inspect Sparkle bridge rpath").stdout;
  if (
    !linkage.includes("@rpath/Sparkle.framework/Versions/B/Sparkle") ||
    !loadCommands.includes("@loader_path/../../Frameworks")
  ) {
    throw new Error("Packaged Sparkle bridge linkage is invalid.");
  }
  for (const relativePath of [
    expectedPaths.frameworkExecutable,
    expectedPaths.autoupdate,
    expectedPaths.updater,
  ]) {
    const architectures = run(
      "/usr/bin/lipo",
      ["-archs", join(contentsPath, ...relativePath.split("/"))],
      "Inspect Sparkle universal binary",
    )
      .stdout.trim()
      .split(/\s+/u)
      .sort();
    if (JSON.stringify(architectures) !== JSON.stringify(["arm64", "x86_64"])) {
      throw new Error(`Packaged Sparkle framework binary is not universal: ${relativePath}.`);
    }
    assertMachONotNewerThan(
      join(contentsPath, ...relativePath.split("/")),
      options.targetArch,
      "15.0",
    );
  }
  assertPlistMinimumNotNewerThan(
    join(frameworkPath, "Versions/B/Updater.app/Contents/Info.plist"),
    "15.0",
    "Packaged Sparkle updater",
  );
  const appInfoPlist = join(contentsPath, "Info.plist");
  const readAppPlist = (key: string): string =>
    run(
      "/usr/bin/plutil",
      ["-extract", key, "raw", "-o", "-", appInfoPlist],
      `Read ${key}`,
    ).stdout.trim();
  if (
    readAppPlist("SUPublicEDKey") !== manifest.publicKey ||
    readAppPlist("SURequireSignedFeed") !== "true" ||
    readAppPlist("SUVerifyUpdateBeforeExtraction") !== "true"
  ) {
    throw new Error("Packaged Sparkle Info.plist security keys are invalid.");
  }
  const sparkleCodeObjects = [
    bridgePath,
    join(frameworkPath, "Versions/B/Autoupdate"),
    join(frameworkPath, "Versions/B/Updater.app"),
    frameworkPath,
  ];
  return sparkleCodeObjects;
};

const restrictedEnvironment = (home: string): NodeJS.ProcessEnv => ({
  CARGO_HOME: join(home, "unavailable-cargo-home"),
  HOME: home,
  NODEX_CORE_IDLE_TIMEOUT_MS: "2000",
  NODEX_HOME: join(home, "profile"),
  NODEX_LOG_CONSOLE: "false",
  NODEX_LOG_FILE: "true",
  PATH: "/usr/bin:/bin",
  RUSTUP_HOME: join(home, "unavailable-rustup-home"),
  TMPDIR: join(home, "tmp"),
});

const delay = (durationMs: number): Promise<void> =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, durationMs));

const makeDirectoriesOwnerWritable = (directory: string): void => {
  const metadata = lstatSync(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) return;
  chmodSync(directory, 0o700);
  for (const entry of readdirSync(directory)) {
    makeDirectoriesOwnerWritable(join(directory, entry));
  }
};

export const removePrivateTemporaryDirectory = (directory: string): void => {
  if (!existsSync(directory)) return;
  makeDirectoriesOwnerWritable(directory);
  rmSync(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
};

export const assertLegacyPackagedRuntimePathsAbsent = (contentsPath: string): void => {
  const legacyPaths = [
    join(contentsPath, "Resources/agent-runtime"),
    join(contentsPath, "Resources/bin/rg"),
  ];
  for (const legacyPath of legacyPaths) {
    let exists = false;
    try {
      lstatSync(legacyPath);
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (exists) {
      throw new Error(`Packaged runtime contains an obsolete duplicate path: ${legacyPath}`);
    }
  }
};

const waitForRuntimeExit = async (descriptor: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (existsSync(descriptor) && Date.now() < deadline) await delay(25);
  if (existsSync(descriptor)) {
    throw new Error("Packaged Core did not exit after smoke-test cleanup");
  }
};

interface PackagedCoreIdentity {
  readonly pid: number;
  readonly startNonce: string;
}

const readPackagedCoreIdentity = (
  descriptorPath: string,
  expectedArtifactSha256: string,
): PackagedCoreIdentity => {
  const value = JSON.parse(readFileSync(descriptorPath, "utf8")) as {
    readonly artifact?: { readonly sha256?: unknown };
    readonly manifest_digest?: unknown;
    readonly pid?: unknown;
    readonly start_nonce?: unknown;
  };
  if (!Number.isSafeInteger(value.pid) || typeof value.start_nonce !== "string") {
    throw new Error("Packaged Core published an invalid runtime generation identity");
  }
  if (value.artifact?.sha256 !== expectedArtifactSha256) {
    throw new Error("Packaged Core self identity does not match rust-core-runtime.json");
  }
  if (typeof value.manifest_digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.manifest_digest)) {
    throw new Error("Packaged Core published an invalid compatibility manifest digest");
  }
  return { pid: value.pid as number, startNonce: value.start_nonce };
};

export const isPackagedAppReady = (options: {
  readonly descriptorPath: string;
  readonly expectedCoreSha256: string;
  readonly expectedHostPid: number;
  readonly nodexHome: string;
  readonly runId: string;
}): boolean => {
  const claim = readIsolatedRunClaim(options.nodexHome);
  if (!claim || claim.phase !== "ready") return false;
  if (claim.runId !== options.runId || claim.hostPid !== options.expectedHostPid) {
    throw new Error("Packaged Nodex.app readiness belongs to another host generation");
  }
  if (!existsSync(options.descriptorPath)) {
    throw new Error("Packaged Nodex.app became ready without a Core runtime descriptor");
  }
  readPackagedCoreIdentity(options.descriptorPath, options.expectedCoreSha256);
  return true;
};

export const selectPackagedSmokeProjectId = (
  projects: readonly { readonly id: string }[],
): string => {
  if (projects.length !== 1) {
    throw new Error(
      `Packaged CLI smoke expected one bootstrapped Project, found ${projects.length}`,
    );
  }
  const projectId = projects[0]?.id;
  if (
    typeof projectId !== "string" ||
    projectId.length === 0 ||
    projectId.length > 512 ||
    projectId.trim() !== projectId
  ) {
    throw new Error("Packaged CLI smoke bootstrap returned an invalid Project ID");
  }
  return projectId;
};

const withPackagedProjectWorkspace = <A, E, R>(
  environment: NodeJS.ProcessEnv,
  appResourcesPath: string,
  use: (
    workspace: ProjectWorkspace["Service"],
    sessions: CoreSessionAccess["Service"],
  ) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | PackagedNativeRuntimeVerificationError, R | Scope.Scope> =>
  Effect.gen(function* () {
    const nodexHome = environment.NODEX_HOME;
    if (!nodexHome) {
      return yield* new PackagedNativeRuntimeVerificationError({
        operation: "connect-core",
        cause: new Error("Packaged CLI smoke environment omits NODEX_HOME"),
      });
    }
    const authorityContext = yield* Layer.build(
      coreAuthorityLive({ jitter: false }).pipe(
        Layer.provide(
          Layer.merge(
            coreTransportLive({
              appResourcesPath,
              buildId: "packaged-native-runtime-verification",
              environment,
              isPackaged: true,
              nodexHome,
            }),
            mainShutdownLive,
          ),
        ),
      ),
    ).pipe(
      Effect.mapError(
        (cause) => new PackagedNativeRuntimeVerificationError({ operation: "connect-core", cause }),
      ),
    );
    const sessions = Context.get(authorityContext, CoreSessionAccess);
    const coreContext = yield* Layer.build(
      coreModulesLive.pipe(Layer.provide(Layer.succeed(CoreSessionAccess, sessions))),
    );
    const core = Context.get(coreContext, CoreModules);
    const workspace = yield* makeProjectWorkspace.pipe(Effect.provideService(CoreModules, core));
    return yield* use(workspace, sessions);
  });

const bootstrapPackagedCliProject = (
  temporaryRoot: string,
): Effect.Effect<string, PackagedNativeRuntimeVerificationError, ProjectWorkspace | Scope.Scope> =>
  Effect.gen(function* () {
    const workspace = yield* ProjectWorkspace;
    const bootstrapContext = yield* Layer.build(
      initialProjectBootstrapLive({
        projectsDirectory: join(temporaryRoot, "projects"),
        journalPath: resolveInitialProjectJournalPath(join(temporaryRoot, "profile")),
      }).pipe(Layer.provide(Layer.succeed(ProjectWorkspace, workspace))),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new PackagedNativeRuntimeVerificationError({ operation: "bootstrap-project", cause }),
      ),
    );
    yield* Context.get(bootstrapContext, InitialProjectBootstrapRuntime)
      .ensure(() => Effect.void)
      .pipe(
        Effect.mapError(
          (cause) =>
            new PackagedNativeRuntimeVerificationError({ operation: "bootstrap-project", cause }),
        ),
      );
    return yield* workspace.listProjects.pipe(
      Effect.mapError(
        (cause) =>
          new PackagedNativeRuntimeVerificationError({ operation: "list-projects", cause }),
      ),
      Effect.flatMap((projects) =>
        attempt("select-bootstrap-project", () => selectPackagedSmokeProjectId(projects)),
      ),
    );
  });

const shutdownPackagedCoreEffect = (
  sessions: CoreSessionAccess["Service"],
  descriptor: string,
): Effect.Effect<void, PackagedNativeRuntimeVerificationError> =>
  Effect.gen(function* () {
    const response = yield* sessions
      .use("shutdown", (client) => client.shutdown(), { replayAfterRecovery: false })
      .pipe(
        Effect.mapError(
          (cause) =>
            new PackagedNativeRuntimeVerificationError({ operation: "shutdown-core", cause }),
        ),
      );
    if (response.status !== "draining") {
      return yield* new PackagedNativeRuntimeVerificationError({
        operation: "shutdown-core",
        cause: new Error(`Packaged Core rejected smoke-test shutdown with ${response.status}`),
      });
    }
    yield* attemptPromise("await-core-exit", () => waitForRuntimeExit(descriptor));
  });

const smokeNativeRuntime = (
  appPath: string,
  expectedCoreSha256: string,
  expectedVersion: string,
): Effect.Effect<void, PackagedNativeRuntimeVerificationError, Scope.Scope> =>
  Effect.acquireUseRelease(
    attempt("create-smoke-directory", () => mkdtempSync("/tmp/ndx-pkg-")),
    (directory) => {
      const environment = restrictedEnvironment(directory);
      const cli = join(appPath, "Contents/Resources/bin/nodex");
      const linkedCliDirectory = join(directory, "cli-bin");
      const linkedCli = join(linkedCliDirectory, "nodex");
      const descriptor = join(environment.NODEX_HOME!, "run/core/core.json");
      return Effect.gen(function* () {
        yield* attempt("prepare-smoke-directory", () => {
          chmodSync(directory, 0o700);
          mkdirSync(environment.TMPDIR!, { mode: 0o700 });
          mkdirSync(linkedCliDirectory, { mode: 0o700 });
          symlinkSync(cli, linkedCli);
        });
        yield* attempt("verify-cli-core-reuse", () => {
          const version = runWithEnvironment(
            linkedCli,
            ["--version"],
            environment,
            "Run packaged nodex through its installed symlink",
          );
          if (version.stdout.trim() !== `nodex ${expectedVersion}`) {
            throw new Error(
              `Packaged nodex version mismatch: ${version.stdout.trim()}, expected nodex ${expectedVersion}`,
            );
          }
          const doctor = runWithEnvironment(
            linkedCli,
            ["--json", "doctor"],
            environment,
            "Run packaged Core doctor through its installed symlink",
          );
          if ((JSON.parse(doctor.stdout) as { ok?: unknown }).ok !== true) {
            throw new Error("Packaged Core doctor did not return a successful envelope");
          }
          const firstCore = readPackagedCoreIdentity(descriptor, expectedCoreSha256);
          const repeatedDoctor = runWithEnvironment(
            linkedCli,
            ["--json", "doctor"],
            environment,
            "Reuse packaged Core doctor",
          );
          if ((JSON.parse(repeatedDoctor.stdout) as { ok?: unknown }).ok !== true) {
            throw new Error("Repeated packaged Core doctor did not return a successful envelope");
          }
          const reusedCore = readPackagedCoreIdentity(descriptor, expectedCoreSha256);
          if (reusedCore.pid !== firstCore.pid || reusedCore.startNonce !== firstCore.startNonce) {
            throw new Error("Compatible packaged CLI selectors did not reuse one Core generation");
          }
        });
        yield* withPackagedProjectWorkspace(
          environment,
          join(appPath, "Contents/Resources"),
          (workspace, sessions) =>
            Effect.gen(function* () {
              const projectId = yield* bootstrapPackagedCliProject(directory).pipe(
                Effect.provideService(ProjectWorkspace, workspace),
              );
              yield* attempt("verify-cli-project", () => {
                const searchSentinel = "packaged-native-cli-ripgrep-sentinel";
                const searchBodyPath = join(directory, "search-smoke.nested.md");
                writeFileSync(searchBodyPath, `${searchSentinel}\n`, {
                  encoding: "utf8",
                  mode: 0o600,
                });
                const pageCreation = runWithEnvironment(
                  linkedCli,
                  [
                    "--json",
                    "--project",
                    projectId,
                    "page",
                    "create",
                    "--parent",
                    "library",
                    "--title",
                    "Packaged CLI search smoke",
                    "--file",
                    searchBodyPath,
                    "--idempotency-key",
                    "packaged-native-runtime-search-smoke",
                  ],
                  environment,
                  "Create packaged CLI search Page",
                );
                const pageEnvelope = JSON.parse(pageCreation.stdout) as {
                  ok?: unknown;
                  result?: { page_id?: unknown };
                };
                const pageId = pageEnvelope.result?.page_id;
                if (pageEnvelope.ok !== true || typeof pageId !== "string" || pageId.length === 0) {
                  throw new Error("Packaged CLI search Page creation returned an invalid envelope");
                }
                const search = runWithEnvironment(
                  linkedCli,
                  ["--project", projectId, "rg", searchSentinel, `@${pageId}`],
                  environment,
                  "Run packaged CLI ripgrep",
                );
                if (!search.stdout.includes(searchSentinel) || !search.stdout.includes(pageId)) {
                  throw new Error("Packaged CLI ripgrep did not return the created Page");
                }
                const service = runWithEnvironment(
                  linkedCli,
                  ["--json", "service", "status"],
                  environment,
                  "Run packaged ServiceManagement status",
                );
                if ((JSON.parse(service.stdout) as { ok?: unknown }).ok !== true) {
                  throw new Error(
                    "Packaged ServiceManagement status did not return a successful envelope",
                  );
                }
              });
              yield* shutdownPackagedCoreEffect(sessions, descriptor);
            }),
        );
      });
    },
    (directory) =>
      Effect.sync(() => {
        const descriptor = join(directory, "profile/run/core/core.json");
        if (!existsSync(descriptor)) removePrivateTemporaryDirectory(directory);
      }),
  );

const smokePreviousStoreMigration = async (
  appPath: string,
  previousStoreFixturePath: string,
): Promise<void> => {
  const sourceRevision = storeFixtureRevision(previousStoreFixturePath);
  const directory = mkdtempSync("/tmp/ndx-store-migration-pkg-");
  const environment = restrictedEnvironment(directory);
  const profile = environment.NODEX_HOME!;
  const descriptor = join(profile, "run/core/core.json");
  const cli = join(appPath, "Contents/Resources/bin/nodex");
  const linkedCliDirectory = join(directory, "cli-bin");
  const linkedCli = join(linkedCliDirectory, "nodex");
  try {
    chmodSync(directory, 0o700);
    mkdirSync(environment.TMPDIR!, { mode: 0o700 });
    mkdirSync(profile, { mode: 0o700 });
    mkdirSync(linkedCliDirectory, { mode: 0o700 });
    copyFileSync(previousStoreFixturePath, join(profile, "nodex.db"));
    symlinkSync(cli, linkedCli);

    const doctor = runWithEnvironment(
      linkedCli,
      ["--json", "doctor"],
      environment,
      `Migrate the v${sourceRevision} Store baseline through the packaged CLI symlink`,
    );
    if ((JSON.parse(doctor.stdout) as { ok?: unknown }).ok !== true) {
      throw new Error("Migrated packaged Core doctor did not return a successful envelope");
    }
    const backupRoot = join(profile, "backups/core-migrations");
    const backups = readdirSync(backupRoot).filter((entry) => !entry.startsWith("."));
    if (backups.length !== 1) {
      throw new Error("Packaged Store migration did not retain one content-addressed backup");
    }
    assertContentAddressedStoreMigrationBackup(join(backupRoot, backups[0]!), {
      sourceRevision,
      targetRevision: currentStoreRevision(descriptor),
    });
    const reopened = runWithEnvironment(
      linkedCli,
      ["--json", "doctor"],
      environment,
      "Reopen the migrated packaged Store",
    );
    if ((JSON.parse(reopened.stdout) as { ok?: unknown }).ok !== true) {
      throw new Error("Reopened packaged Core doctor did not return a successful envelope");
    }
    if (readdirSync(backupRoot).filter((entry) => !entry.startsWith(".")).length !== 1) {
      throw new Error("Packaged Store migration repeated its backup after reopen");
    }
    await waitForRuntimeExit(descriptor);
  } finally {
    if (!existsSync(descriptor)) {
      removePrivateTemporaryDirectory(directory);
    }
  }
};

const smokeBrowserProfileHelper = (appPath: string): void => {
  const directory = mkdtempSync("/tmp/ndx-browser-profile-helper-");
  try {
    const helper = join(appPath, "Contents/Resources/bin/nodex-browser-profile-helper");
    const result = spawnSync(helper, [], {
      cwd: directory,
      encoding: "utf8",
      env: restrictedEnvironment(directory),
      input: JSON.stringify({
        schemaVersion: 1,
        operation: "read-profile",
        source: "chrome",
        profilePath: join(directory, "missing-profile"),
        includeCookies: true,
        includePasswords: false,
        cookieDomainAllowlist: [],
      }),
      timeout: 5_000,
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        `Packaged Browser Profile helper failed to start: ${
          result.error?.message ?? result.stderr.trim()
        }`,
      );
    }
    const response = JSON.parse(result.stdout) as {
      readonly errorCode?: unknown;
      readonly ok?: unknown;
      readonly schemaVersion?: unknown;
    };
    if (
      response.schemaVersion !== 1 ||
      response.ok !== false ||
      response.errorCode !== "data_unavailable"
    ) {
      throw new Error("Packaged Browser Profile helper returned an invalid envelope");
    }
  } finally {
    removePrivateTemporaryDirectory(directory);
  }
};

const smokeDictationHelper = async (appPath: string): Promise<void> => {
  const helper = join(appPath, "Contents/Resources/bin/nodex-dictation-helper");
  const child = spawn(helper, [], { stdio: ["pipe", "pipe", "pipe"] });
  child.stdout.setEncoding("utf8");
  child.stderr.resume();
  let stdout = "";
  let ready = false;
  let bindingResponse = false;
  let response = false;
  await new Promise<void>((resolveSmoke, rejectSmoke) => {
    const timeout = setTimeout(() => {
      child.kill();
      rejectSmoke(new Error("Packaged dictation helper smoke timed out"));
    }, 5_000);
    const fail = (error: Error): void => {
      clearTimeout(timeout);
      child.kill();
      rejectSmoke(error);
    };
    child.once("error", fail);
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      let newline = stdout.indexOf("\n");
      while (newline >= 0) {
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          fail(new Error("Packaged dictation helper emitted invalid JSON"));
          return;
        }
        if (message.type === "ready" && message.protocolVersion === 2) {
          ready = true;
          child.stdin.write(
            `${JSON.stringify({
              id: "smoke-bindings",
              type: "replaceBindings",
              generation: 1,
              bindings: [],
            })}\n`,
          );
        } else if (
          message.type === "response" &&
          message.id === "smoke-bindings" &&
          message.ok === true &&
          (message.value as Record<string, unknown> | undefined)?.applied === true &&
          (message.value as Record<string, unknown> | undefined)?.generation === 1
        ) {
          bindingResponse = true;
          child.stdin.write(
            `${JSON.stringify({ id: "smoke-capabilities", type: "capabilities" })}\n`,
          );
        } else if (
          message.type === "response" &&
          message.id === "smoke-capabilities" &&
          message.ok === true &&
          typeof (message.value as Record<string, unknown> | undefined)?.inputMonitoring ===
            "boolean" &&
          typeof (message.value as Record<string, unknown> | undefined)?.accessibility === "boolean"
        ) {
          response = true;
          child.stdin.end();
        }
        newline = stdout.indexOf("\n");
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0 && ready && bindingResponse && response) resolveSmoke();
      else rejectSmoke(new Error(`Packaged dictation helper smoke exited with code ${code}`));
    });
  });
};

const runWithEnvironment = (
  command: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  label: string,
): CommandResult => {
  const result = spawnSync(command, arguments_, {
    cwd: environment.HOME,
    encoding: "utf8",
    env: environment,
    timeout: 120_000,
  });
  if (result.error) throw new Error(`${label} could not complete: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `${label} failed with status ${result.status}: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return { stderr: result.stderr, stdout: result.stdout };
};

const PACKAGED_APP_STARTUP_TIMEOUT_MS = 60_000;
const PACKAGED_APP_TERMINATION_TIMEOUT_MS = 10_000;
const PACKAGED_APP_KILL_TIMEOUT_MS = 5_000;
const MAX_PACKAGED_APP_DIAGNOSTIC_CHARS = 32_768;

interface CapturedProcessOutput {
  stderr: string;
  stdout: string;
}

const captureProcessOutput = (child: ChildProcess): CapturedProcessOutput => {
  const output: CapturedProcessOutput = { stderr: "", stdout: "" };
  const append = (key: keyof CapturedProcessOutput, chunk: Buffer | string): void => {
    output[key] = `${output[key]}${String(chunk)}`.slice(-MAX_PACKAGED_APP_DIAGNOSTIC_CHARS);
  };
  child.stdout?.on("data", (chunk: Buffer | string) => append("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer | string) => append("stderr", chunk));
  return output;
};

const readPackagedAppRuntimeLogs = (nodexHome: string): string => {
  const logDirectory = join(nodexHome, "logs");
  if (!existsSync(logDirectory)) return "";
  try {
    return readdirSync(logDirectory)
      .filter((entry) => entry.endsWith(".log"))
      .sort()
      .slice(-4)
      .map((entry) => `== ${entry} ==\n${readFileSync(join(logDirectory, entry), "utf8")}`)
      .join("\n")
      .slice(-MAX_PACKAGED_APP_DIAGNOSTIC_CHARS);
  } catch (error) {
    return `Unable to read packaged app runtime logs: ${String(error)}`;
  }
};

const waitForChildExit = async (child: ChildProcess, timeoutMs: number): Promise<boolean> => {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolvePromise) => {
    const onClose = (): void => {
      clearTimeout(timer);
      resolvePromise(true);
    };
    const timer = setTimeout(() => {
      child.off("close", onClose);
      resolvePromise(false);
    }, timeoutMs);
    child.once("close", onClose);
  });
};

const signalProcessGroup = (child: ChildProcess, signal: NodeJS.Signals): void => {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    child.kill(signal);
  }
};

const stopPackagedApp = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalProcessGroup(child, "SIGTERM");
  if (await waitForChildExit(child, PACKAGED_APP_TERMINATION_TIMEOUT_MS)) return;
  signalProcessGroup(child, "SIGKILL");
  if (await waitForChildExit(child, PACKAGED_APP_KILL_TIMEOUT_MS)) return;
  throw new Error("Packaged Nodex.app process group did not exit after SIGKILL");
};

const waitForPackagedAppReadiness = async (options: {
  readonly child: ChildProcess;
  readonly descriptorPath: string;
  readonly expectedCoreSha256: string;
  readonly nodexHome: string;
  readonly runId: string;
}): Promise<void> => {
  const spawnErrors: Error[] = [];
  const onSpawnError = (error: Error): void => {
    spawnErrors.push(error);
  };
  options.child.once("error", onSpawnError);
  try {
    const deadline = Date.now() + PACKAGED_APP_STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const spawnError = spawnErrors[0];
      if (spawnError) {
        throw new Error(`Packaged Nodex.app could not start: ${spawnError.message}`, {
          cause: spawnError,
        });
      }
      if (options.child.exitCode !== null || options.child.signalCode !== null) {
        throw new Error(
          "Packaged Nodex.app exited during startup " +
            `(code ${String(options.child.exitCode)}, signal ${String(options.child.signalCode)})`,
        );
      }
      if (
        options.child.pid &&
        isPackagedAppReady({
          descriptorPath: options.descriptorPath,
          expectedCoreSha256: options.expectedCoreSha256,
          expectedHostPid: options.child.pid,
          nodexHome: options.nodexHome,
          runId: options.runId,
        })
      ) {
        return;
      }
      await delay(50);
    }
    const phase = readIsolatedRunClaim(options.nodexHome)?.phase ?? "unclaimed";
    throw new Error(
      `Packaged Nodex.app did not become ready within ${PACKAGED_APP_STARTUP_TIMEOUT_MS}ms ` +
        `(isolated host phase: ${phase})`,
    );
  } finally {
    options.child.off("error", onSpawnError);
  }
};

const launchAppSmoke = async (appPath: string, expectedCoreSha256: string): Promise<void> => {
  const directory = mkdtempSync("/tmp/ndx-app-");
  const userData = join(directory, "electron-user-data");
  const environment = restrictedEnvironment(directory);
  const executable = join(appPath, "Contents/MacOS/Nodex");
  const nodexHome = environment.NODEX_HOME!;
  const descriptor = join(nodexHome, "run/core/core.json");
  const runId = randomUUID();
  mkdirSync(environment.TMPDIR!, { mode: 0o700 });
  mkdirSync(nodexHome, { mode: 0o700 });
  const lease = acquireIsolatedRunLease({ nodexHome, runId, supervisorPid: process.pid });
  const child = spawn(executable, [`--user-data-dir=${userData}`], {
    cwd: directory,
    detached: true,
    env: { ...environment, [ISOLATED_RUN_ID_ENV]: runId },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = captureProcessOutput(child);
  let startupError: unknown = null;
  const cleanupErrors: unknown[] = [];
  try {
    await waitForPackagedAppReadiness({
      child,
      descriptorPath: descriptor,
      expectedCoreSha256,
      nodexHome,
      runId,
    });
  } catch (error) {
    startupError = error;
  }

  let applicationExited = false;
  try {
    await stopPackagedApp(child);
    applicationExited = true;
  } catch (error) {
    cleanupErrors.push(error);
  }

  const runtimeLogs = readPackagedAppRuntimeLogs(nodexHome);
  let safeToRemove = false;
  if (applicationExited) {
    const coreCleanup = await cleanupIsolatedCore({ lease, nodexHome, runId });
    safeToRemove = coreCleanup.safeToDeleteRunRoot;
    if (!safeToRemove) {
      cleanupErrors.push(
        new Error(
          `Packaged Core cleanup ended with ${coreCleanup.status}: ` +
            (coreCleanup.reason ?? "no reason reported"),
        ),
      );
    }
  }

  if (safeToRemove) {
    try {
      removePrivateTemporaryDirectory(directory);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (startupError || cleanupErrors.length > 0) {
    const diagnostics = [
      startupError instanceof Error ? (startupError.stack ?? startupError.message) : startupError,
      ...cleanupErrors.map((error) => `Cleanup error: ${String(error)}`),
      output.stdout ? `== stdout ==\n${output.stdout}` : "",
      output.stderr ? `== stderr ==\n${output.stderr}` : "",
      runtimeLogs,
      existsSync(directory) ? `Preserved failed packaged smoke Profile: ${directory}` : "",
    ].filter((section): section is string => typeof section === "string" && section.length > 0);
    throw new Error(diagnostics.join("\n\n"), {
      cause: startupError ?? cleanupErrors[0],
    });
  }
};

export function verifyPackagedNativeRuntimeStructure(
  options: PackagedNativeRuntimeStructureOptions,
): PackagedNativeRuntimeIdentity {
  const appPath = resolve(options.appPath);
  verifyPackagedAgentSkills({ appPath });
  const contentsPath = join(appPath, "Contents");
  const manifestPath = join(contentsPath, "Resources/bin/rust-core-runtime.json");
  const manifest = readNativeRuntimeManifest(manifestPath);
  const expectedVersion = options.expectedVersion;
  if (manifest.productVersion !== expectedVersion) {
    throw new Error(
      `Native runtime product version is ${manifest.productVersion}, expected ${expectedVersion}`,
    );
  }
  const infoPlist = join(contentsPath, "Info.plist");
  assertPlistMinimumMacos(infoPlist, manifest.minimumMacOS, "Packaged app");
  const appVersion = run(
    "/usr/bin/plutil",
    ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", infoPlist],
    "Read packaged app version",
  ).stdout.trim();
  if (appVersion !== expectedVersion) {
    throw new Error(`Packaged app version is ${appVersion}, expected ${expectedVersion}`);
  }
  const bundleVersion = run(
    "/usr/bin/plutil",
    ["-extract", "CFBundleVersion", "raw", "-o", "-", infoPlist],
    "Read packaged app bundle version",
  ).stdout.trim();
  if (bundleVersion !== options.expectedBuildVersion) {
    throw new Error(
      `Packaged app bundle version is ${bundleVersion}, expected build version ${options.expectedBuildVersion}`,
    );
  }
  const microphonePurpose = run(
    "/usr/bin/plutil",
    ["-extract", "NSMicrophoneUsageDescription", "raw", "-o", "-", infoPlist],
    "Read packaged microphone usage description",
  ).stdout.trim();
  if (!microphonePurpose) {
    throw new Error("Packaged app microphone usage description is empty");
  }
  if (manifest.targetArch !== options.targetArch) {
    throw new Error(
      `Native runtime manifest is ${manifest.targetArch}, expected ${options.targetArch}`,
    );
  }
  const nativeBinaryPaths = manifest.binaries.map((binary) => {
    const binaryPath = join(contentsPath, ...binary.bundlePath.split("/"));
    assertRegularExecutable(binaryPath);
    const metadata = statSync(binaryPath);
    if (metadata.size !== binary.sourceSize || sha256File(binaryPath) !== binary.sourceSha256) {
      throw new Error(`Native runtime manifest identity mismatch for ${binary.name}`);
    }
    assertMachO(binaryPath, options.targetArch, manifest.minimumMacOS);
    return binaryPath;
  });
  const cliRipgrep = join(contentsPath, "Resources/codex-path/rg");
  assertRegularExecutable(cliRipgrep);
  assertMachOArchitecture(cliRipgrep, options.targetArch);
  nativeBinaryPaths.push(cliRipgrep);
  const clipboardBridge = join(contentsPath, "Resources/native/nodex-clipboard.node");
  assertRegularExecutable(clipboardBridge);
  assertMachO(clipboardBridge, options.targetArch, manifest.minimumMacOS);
  nativeBinaryPaths.push(clipboardBridge);
  const sparkleCodeObjects = verifySparkleRuntime(appPath, options);
  const computerUseInfo = join(
    contentsPath,
    "Resources/browser-runtime/runtime/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/Info.plist",
  );
  if (existsSync(computerUseInfo)) {
    assertPlistMinimumNotNewerThan(
      computerUseInfo,
      manifest.minimumMacOS,
      "Packaged Computer Use app",
    );
  }
  assertLegacyPackagedRuntimePathsAbsent(contentsPath);
  const resourcesService = join(contentsPath, "Resources/bin/nodex-service");
  if (existsSync(resourcesService)) {
    throw new Error("ServiceManagement adapter must only exist inside its nested helper app");
  }
  const helperInfo = join(contentsPath, "Helpers/Nodex Service.app/Contents/Info.plist");
  const helperLaunchAgent = join(
    contentsPath,
    "Helpers/Nodex Service.app/Contents/Library/LaunchAgents/app.jyu.nodex.background-service.core.plist",
  );
  if (!statSync(helperInfo).isFile() || !statSync(helperLaunchAgent).isFile()) {
    throw new Error("Packaged ServiceManagement helper bundle is incomplete");
  }
  assertPlistMinimumMacos(helperInfo, manifest.minimumMacOS, "ServiceManagement helper");
  if (options.verifySignatures) {
    verifySignatures(
      appPath,
      [...nativeBinaryPaths, ...sparkleCodeObjects],
      options.requireDeveloperId,
    );
    verifyMacCodeObjectEntitlements({
      appPath,
      nativeCodeObjects: nativeBinaryPaths,
      sparkleCodeObjects,
    });
  }
  if (options.verifyNotarization) {
    run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath], "Assess notarization");
    run("xcrun", ["stapler", "validate", appPath], "Validate notarization ticket");
  }
  const coreManifest = manifest.binaries.find(({ name }) => name === "nodex-core");
  if (!coreManifest) throw new Error("Native runtime manifest omits nodex-core");
  process.stdout.write(`Verified packaged native runtime structure ${options.targetArch}\n`);
  return {
    appPath,
    coreSha256: coreManifest.sourceSha256,
    expectedVersion,
    targetArch: options.targetArch,
  };
}

const verifyPackagedNativeRuntimeSmoke = (
  options: PackagedNativeRuntimeSmokeOptions,
): Effect.Effect<void, PackagedNativeRuntimeVerificationError, Scope.Scope> =>
  Effect.gen(function* () {
    const identity = yield* attempt("verify-runtime-structure", () =>
      verifyPackagedNativeRuntimeStructure(options),
    );
    yield* smokeNativeRuntime(identity.appPath, identity.coreSha256, identity.expectedVersion);
    yield* attemptPromise("verify-store-migration", () =>
      smokePreviousStoreMigration(
        identity.appPath,
        resolve(options.previousStoreFixturePath ?? DEFAULT_PREVIOUS_STORE_FIXTURE),
      ),
    );
    yield* attempt("verify-browser-profile-helper", () =>
      smokeBrowserProfileHelper(identity.appPath),
    );
    yield* attemptPromise("verify-dictation-helper", () => smokeDictationHelper(identity.appPath));
    if (options.launchApp) {
      yield* attemptPromise("verify-app-launch", () =>
        launchAppSmoke(identity.appPath, identity.coreSha256),
      );
    }
    yield* Effect.sync(() => {
      process.stdout.write(`Verified packaged native runtime smoke ${identity.targetArch}\n`);
    });
  });

const readOption = (arguments_: readonly string[], option: string): string | null => {
  const index = arguments_.indexOf(option);
  if (index < 0) return null;
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${option}`);
  return value;
};

const main = Effect.gen(function* () {
  const options = yield* attempt("parse-arguments", () => {
    const arguments_ = process.argv.slice(2);
    const appPath = readOption(arguments_, "--app-path");
    const targetArch = readOption(arguments_, "--target-arch");
    const expectedVersion = readOption(arguments_, "--expected-version");
    if (!appPath || !expectedVersion || (targetArch !== "arm64" && targetArch !== "x64")) {
      throw new Error(
        "usage: verify-native-runtime --app-path <Nodex.app> --target-arch arm64|x64 " +
          "--expected-version <semver> [--expected-build-version <build>] " +
          "[--previous-store-fixture <store-v130.db>] [--verify-signatures] " +
          "[--require-developer-id] [--verify-notarization] [--launch-app] " +
          "[--expected-update-channel disabled|stable|nightly]",
      );
    }
    const requireDeveloperId = arguments_.includes("--require-developer-id");
    const verifyNotarization = arguments_.includes("--verify-notarization");
    const expectedUpdateChannel = readOption(arguments_, "--expected-update-channel");
    const expectedBuildVersion =
      readOption(arguments_, "--expected-build-version") ?? expectedVersion;
    if (
      expectedUpdateChannel !== null &&
      expectedUpdateChannel !== "disabled" &&
      expectedUpdateChannel !== "stable" &&
      expectedUpdateChannel !== "nightly"
    ) {
      throw new Error("--expected-update-channel must be disabled, stable, or nightly");
    }
    return {
      appPath,
      expectedBuildVersion,
      expectedVersion,
      launchApp: arguments_.includes("--launch-app"),
      previousStoreFixturePath: readOption(arguments_, "--previous-store-fixture") ?? undefined,
      requireDeveloperId,
      targetArch,
      expectedUpdateChannel: expectedUpdateChannel ?? undefined,
      verifyNotarization,
      verifySignatures:
        arguments_.includes("--verify-signatures") || requireDeveloperId || verifyNotarization,
    } satisfies PackagedNativeRuntimeSmokeOptions;
  });
  yield* verifyPackagedNativeRuntimeSmoke(options);
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  NodeRuntime.runMain(Effect.scoped(main));
}
