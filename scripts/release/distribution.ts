import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { verifyPackagedBuildProvenance } from "../package-provenance.mjs";
import { verifyCodexRuntime } from "../verify-codex-runtime";
import { verifyPackagedNativeRuntimeStructure } from "../verify-native-runtime";
import {
  recordArchitectureBuild,
  type ArchitectureBuildManifest,
  type MacArchitecture,
} from "./bundle";
import { parseReleaseIdentity, type ReleaseIdentity } from "./model";
import { inspectReleaseSource } from "./source";

const run = (
  cwd: string,
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): string =>
  execFileSync(command, [...args], {
    cwd,
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();

const runTask = (
  cwd: string,
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): void => {
  execFileSync(command, [...args], {
    cwd,
    env: environment,
    stdio: "inherit",
  });
};

const notarizeDmg = (cwd: string, dmgPath: string): void => {
  const key = process.env.APPLE_API_KEY;
  const keyId = process.env.APPLE_API_KEY_ID;
  const issuer = process.env.APPLE_API_ISSUER;
  if (!key || !keyId || !issuer) {
    throw new Error("DMG notarization requires App Store Connect API credentials.");
  }
  runTask(cwd, "xcrun", [
    "notarytool",
    "submit",
    dmgPath,
    "--key",
    key,
    "--key-id",
    keyId,
    "--issuer",
    issuer,
    "--wait",
  ]);
  runTask(cwd, "xcrun", ["stapler", "staple", dmgPath]);
  runTask(cwd, "xcrun", ["stapler", "validate", dmgPath]);
  runTask(cwd, "/usr/sbin/spctl", [
    "--assess",
    "--type",
    "open",
    "--context",
    "context:primary-signature",
    "--verbose=4",
    dmgPath,
  ]);
  runTask(cwd, "/usr/bin/codesign", ["--verify", "--verbose=2", dmgPath]);
};

const requireNativeMac = (architecture: MacArchitecture): void => {
  if (process.platform !== "darwin" || process.arch !== architecture) {
    throw new Error(`Release distribution must run natively on darwin ${architecture}.`);
  }
};

const assertSourceIdentity = (cwd: string, identity: ReleaseIdentity): void => {
  const { sourceSha, sourceTree } = identity;
  if (!/^[a-f0-9]{40}$/u.test(sourceSha)) throw new Error("Source SHA must be a full commit SHA.");
  if (!/^[a-f0-9]{40}$/u.test(sourceTree)) throw new Error("Source tree must be a full tree SHA.");
  if (run(cwd, "git", ["rev-parse", "HEAD"]) !== sourceSha) {
    throw new Error("Release distribution checkout does not match the requested source SHA.");
  }
  if (run(cwd, "git", ["rev-parse", "HEAD^{tree}"]) !== sourceTree) {
    throw new Error("Release distribution checkout does not match the requested source tree.");
  }
  if (run(cwd, "git", ["status", "--porcelain", "--untracked-files=normal"])) {
    throw new Error("Release distribution requires a clean source checkout.");
  }
  if (inspectReleaseSource(cwd).packageVersion !== identity.sourceVersion) {
    throw new Error("Release distribution source version does not match the requested version.");
  }
};

const appAtRoot = (root: string): string => {
  const appNames = readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.endsWith(".app"),
    )
    .map(({ name }) => name);
  if (appNames.length !== 1) {
    throw new Error(`Expected exactly one app bundle in ${root}; found ${appNames.length}.`);
  }
  return join(root, appNames[0]);
};

interface VerifiedAppIdentity {
  readonly buildVersion: string;
  readonly bundleId: string;
  readonly provenanceId: string;
  readonly teamIdentifier: string;
  readonly version: string;
}

const readAppIdentity = (appPath: string): Omit<VerifiedAppIdentity, "provenanceId"> => {
  const infoPlist = join(appPath, "Contents/Info.plist");
  const readPlist = (key: string): string =>
    execFileSync("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", infoPlist], {
      encoding: "utf8",
    }).trim();
  const signature = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", appPath], {
    encoding: "utf8",
  });
  if (signature.error || signature.status !== 0) {
    throw new Error(
      `Unable to inspect app signing identity: ${signature.error?.message ?? signature.stderr}`,
    );
  }
  const teamIdentifier = /^TeamIdentifier=(.+)$/mu
    .exec(`${signature.stdout}\n${signature.stderr}`)?.[1]
    ?.trim();
  if (!teamIdentifier || teamIdentifier === "not set") {
    throw new Error("Packaged app does not have a Developer ID team identifier.");
  }
  return {
    buildVersion: readPlist("CFBundleVersion"),
    bundleId: readPlist("CFBundleIdentifier"),
    teamIdentifier,
    version: readPlist("CFBundleShortVersionString"),
  };
};

const verifyApp = async (options: {
  readonly appPath: string;
  readonly architecture: MacArchitecture;
  readonly preparedManifestPath: string;
  readonly runtimeCheck:
    | { readonly kind: "smoke"; readonly launchApp: boolean }
    | { readonly kind: "structure" };
  readonly version: string;
  readonly buildVersion: string;
  readonly channel: ReleaseIdentity["channel"];
}): Promise<VerifiedAppIdentity> => {
  const provenance = verifyPackagedBuildProvenance(options.appPath, {
    expectedArch: options.architecture,
    expectedPreparedManifestPath: options.preparedManifestPath,
  });
  if (provenance.product.version !== options.version) {
    throw new Error("Packaged provenance product version does not match the release identity.");
  }
  const appIdentity = readAppIdentity(options.appPath);
  if (appIdentity.buildVersion !== options.buildVersion) {
    throw new Error("Packaged app build version does not match the release identity.");
  }
  await verifyCodexRuntime({
    requireBrowserRuntime: true,
    resourcesPath: join(options.appPath, "Contents/Resources"),
    verifyMacosSignatures: true,
  });
  const runtimeOptions = {
    appPath: options.appPath,
    expectedBuildVersion: options.buildVersion,
    expectedVersion: options.version,
    expectedUpdateChannel: options.channel,
    requireDeveloperId: true,
    targetArch: options.architecture,
    verifyNotarization: true,
    verifySignatures: true,
  } as const;
  if (options.runtimeCheck.kind === "smoke") {
    runTask(process.cwd(), "vp", [
      "exec",
      "tsx",
      "scripts/run-browser-runtime-probe.ts",
      "--resources-path",
      join(options.appPath, "Contents/Resources"),
    ]);
    runTask(process.cwd(), "vp", [
      "exec",
      "tsx",
      "scripts/verify-native-runtime.ts",
      "--app-path",
      options.appPath,
      "--target-arch",
      options.architecture,
      "--expected-version",
      options.version,
      "--expected-build-version",
      options.buildVersion,
      "--expected-update-channel",
      options.channel,
      "--verify-signatures",
      "--require-developer-id",
      "--verify-notarization",
      ...(options.runtimeCheck.launchApp ? ["--launch-app"] : []),
    ]);
  } else {
    verifyPackagedNativeRuntimeStructure(runtimeOptions);
  }
  return { ...appIdentity, provenanceId: provenance.provenanceId };
};

export async function buildMacDistribution(options: {
  readonly architecture: MacArchitecture;
  readonly cwd: string;
  readonly outputDirectory: string;
  readonly identityPath: string;
}): Promise<ArchitectureBuildManifest> {
  const cwd = resolve(options.cwd);
  const identity = parseReleaseIdentity(
    JSON.parse(readFileSync(resolve(options.identityPath), "utf8")) as unknown,
  );
  const version = identity.version;
  requireNativeMac(options.architecture);
  assertSourceIdentity(cwd, identity);

  const releaseEnvironment = {
    ...process.env,
    NODEX_BUILD_VERSION: identity.buildVersion,
    NODEX_RELEASE_IDENTITY_PATH: resolve(options.identityPath),
    NODEX_RELEASE_VERSION: identity.version,
    NODEX_SPARKLE_CHANNEL: identity.channel,
  };

  const prerequisiteScripts = [
    "build-resources:verify",
    "codex:schemas:verify",
    "test:agent-runtime-conformance",
    "test:browser-runtime-conformance",
  ] as const;
  for (const script of prerequisiteScripts) runTask(cwd, "pnpm", ["run", script]);
  runTask(cwd, "pnpm", ["run", "build"], releaseEnvironment);
  runTask(
    cwd,
    "pnpm",
    ["run", `stage:native-runtime:mac:${options.architecture}`],
    releaseEnvironment,
  );
  runTask(
    cwd,
    "pnpm",
    ["exec", "tsx", "scripts/prepared-electron-build.ts", "verify"],
    releaseEnvironment,
  );
  runTask(
    cwd,
    "pnpm",
    [
      "exec",
      "electron-builder",
      "--mac",
      "dmg",
      `--${options.architecture}`,
      "--publish",
      "never",
      `--config.extraMetadata.version=${identity.version}`,
      `--config.buildVersion=${identity.buildVersion}`,
    ],
    releaseEnvironment,
  );
  assertSourceIdentity(cwd, identity);

  const distDirectory = join(cwd, "dist");
  const zipPath = join(distDirectory, `Nodex-${version}-${options.architecture}.zip`);
  const dmgPath = join(distDirectory, `Nodex-${version}-${options.architecture}.dmg`);
  const packagedAppDirectory = join(distDirectory, "mac-arm64");
  const packagedAppPath = appAtRoot(packagedAppDirectory);
  rmSync(zipPath, { force: true });
  runTask(cwd, "/usr/bin/ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    packagedAppPath,
    zipPath,
  ]);
  notarizeDmg(cwd, dmgPath);
  const preparedManifestPath = join(cwd, ".generated/prepared-electron-build.json");
  const temporaryRoot = mkdtempSync(join(tmpdir(), `nodex-distribution-${options.architecture}-`));
  const zipRoot = join(temporaryRoot, "zip");
  const mountRoot = join(temporaryRoot, "dmg");
  let mounted = false;
  try {
    run(cwd, "/usr/bin/ditto", ["-x", "-k", zipPath, zipRoot]);
    const zipAppPath = appAtRoot(zipRoot);
    const zipProvenance = await verifyApp({
      appPath: zipAppPath,
      architecture: options.architecture,
      preparedManifestPath,
      runtimeCheck: { kind: "smoke", launchApp: true },
      version,
      buildVersion: identity.buildVersion,
      channel: identity.channel,
    });

    mkdirSync(mountRoot);
    run(cwd, "/usr/bin/hdiutil", [
      "attach",
      "-nobrowse",
      "-readonly",
      "-mountpoint",
      mountRoot,
      dmgPath,
    ]);
    mounted = true;
    const dmgAppPath = appAtRoot(mountRoot);
    const dmgProvenance = await verifyApp({
      appPath: dmgAppPath,
      architecture: options.architecture,
      preparedManifestPath,
      runtimeCheck: { kind: "structure" },
      version,
      buildVersion: identity.buildVersion,
      channel: identity.channel,
    });
    if (JSON.stringify(zipProvenance) !== JSON.stringify(dmgProvenance)) {
      throw new Error(
        "ZIP and DMG apps do not share one version, bundle, team, and package provenance identity.",
      );
    }

    return recordArchitectureBuild({
      appPath: zipAppPath,
      architecture: options.architecture,
      cwd,
      distDirectory,
      identityPath: options.identityPath,
      outputDirectory: options.outputDirectory,
    });
  } finally {
    if (mounted) {
      try {
        run(cwd, "/usr/bin/hdiutil", ["detach", mountRoot]);
      } catch (error) {
        process.stderr.write(`Unable to detach ${mountRoot}: ${String(error)}\n`);
      }
    }
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}
