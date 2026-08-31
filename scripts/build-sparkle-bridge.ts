import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { replaceOwnedDirectory } from "./replace-owned-directory";
import { readSparkleReleaseLock, resolveSparkleReleaseLockPath } from "./sparkle-release-lock";
import { materializeSparkleRuntime, verifySparkleToolchain } from "./materialize-sparkle-runtime";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type SparkleRuntimeArchitecture = "arm64" | "x64";
export type SparkleRuntimeChannel = "disabled" | "stable" | "nightly";

export interface SparkleRuntimeManifest {
  readonly artifacts: {
    readonly autoupdate: SparkleArtifactIdentity;
    readonly bridge: SparkleArtifactIdentity;
    readonly frameworkExecutable: SparkleArtifactIdentity;
    readonly frameworkInfoPlist: SparkleArtifactIdentity;
    readonly updater: SparkleArtifactIdentity;
  };
  readonly architecture: SparkleRuntimeArchitecture;
  readonly buildChannel: SparkleRuntimeChannel;
  readonly feedUrls: null | Readonly<Record<"stable" | "nightly", string>>;
  readonly minimumMacOS: "15.0";
  readonly publicKey: string;
  readonly schemaVersion: 3;
  readonly sparkleArchiveSha256: string;
  readonly sparkleVersion: string;
}

export interface SparkleArtifactIdentity {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface BuildSparkleBridgeOptions {
  readonly architecture: SparkleRuntimeArchitecture;
  readonly channel: SparkleRuntimeChannel;
  readonly outputPath: string;
  readonly projectRootPath?: string;
  readonly toolchainPath: string;
}

const feedUrlsFor = (architecture: SparkleRuntimeArchitecture) => ({
  stable: `https://nodex.jyu.app/updates/stable/${architecture}/appcast.xml`,
  nightly: `https://nodex.jyu.app/updates/nightly/${architecture}/appcast.xml`,
});

const readPublicKey = (projectRoot: string): string => {
  const publicKey = readFileSync(
    path.join(projectRoot, "resources", "sparkle", "public-key.txt"),
    "utf8",
  ).trim();
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(publicKey) || Buffer.from(publicKey, "base64").length !== 32) {
    throw new Error("Sparkle public key must be one base64-encoded Ed25519 public key.");
  }
  return publicKey;
};

const sha256File = (filePath: string): string =>
  createHash("sha256").update(readFileSync(filePath)).digest("hex");

const artifactIdentity = (filePath: string, bundlePath: string): SparkleArtifactIdentity => {
  const metadata = lstatSync(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Sparkle runtime artifact must be a regular file: ${filePath}`);
  }
  return {
    path: bundlePath,
    sha256: sha256File(filePath),
    size: metadata.size,
  };
};

const readMachArchitectures = (binaryPath: string): readonly string[] =>
  execFileSync("/usr/bin/lipo", ["-archs", binaryPath], { encoding: "utf8" })
    .trim()
    .split(/\s+/u)
    .filter(Boolean);

export function verifyStagedSparkleRuntime(
  outputPath: string,
  expected: SparkleRuntimeManifest,
): SparkleRuntimeManifest {
  const root = path.resolve(outputPath);
  const manifest = JSON.parse(
    readFileSync(path.join(root, "sparkle-runtime.json"), "utf8"),
  ) as unknown;
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) {
    throw new Error("Staged Sparkle runtime manifest does not match its build identity.");
  }
  const bridgePath = path.join(root, "nodex-sparkle.node");
  const bridgeMetadata = lstatSync(bridgePath);
  if (
    !bridgeMetadata.isFile() ||
    bridgeMetadata.isSymbolicLink() ||
    (bridgeMetadata.mode & 0o111) === 0
  ) {
    throw new Error("Staged Sparkle bridge must be an executable regular file.");
  }
  const expectedMachArchitecture = expected.architecture === "arm64" ? "arm64" : "x86_64";
  const architectures = readMachArchitectures(bridgePath);
  if (architectures.length !== 1 || architectures[0] !== expectedMachArchitecture) {
    throw new Error(`Sparkle bridge architecture mismatch: ${architectures.join(", ")}.`);
  }
  const frameworkPath = path.join(root, "Sparkle.framework");
  if (!lstatSync(frameworkPath).isDirectory()) {
    throw new Error("Staged Sparkle framework is missing.");
  }
  if (
    existsSync(path.join(frameworkPath, "Versions", "B", "XPCServices")) ||
    existsSync(path.join(frameworkPath, "XPCServices"))
  ) {
    throw new Error("Non-sandboxed Nodex builds must not embed Sparkle XPC services.");
  }
  if (!sha256File(bridgePath)) throw new Error("Sparkle bridge checksum could not be computed.");
  return expected;
}

export async function buildSparkleBridge(
  options: BuildSparkleBridgeOptions,
): Promise<SparkleRuntimeManifest> {
  if (process.platform !== "darwin") {
    throw new Error("Sparkle bridge builds are supported only on macOS.");
  }
  const projectRoot = path.resolve(options.projectRootPath ?? repositoryRoot);
  const lock = readSparkleReleaseLock(resolveSparkleReleaseLockPath(projectRoot));
  const toolchainPath = path.resolve(options.toolchainPath);
  await materializeSparkleRuntime({
    outputPath: toolchainPath,
    projectRootPath: projectRoot,
  });
  verifySparkleToolchain(toolchainPath, lock);

  const nativeSourceRoot = path.join(projectRoot, "native", "macos-sparkle");
  const nativeBuildRoot = path.join(
    projectRoot,
    ".generated",
    "sparkle-native-build",
    options.architecture,
  );
  rmSync(path.join(nativeSourceRoot, "build"), { force: true, recursive: true });
  rmSync(nativeBuildRoot, { force: true, recursive: true });
  mkdirSync(path.join(nativeBuildRoot, "src"), { recursive: true });
  copyFileSync(
    path.join(nativeSourceRoot, "binding.gyp"),
    path.join(nativeBuildRoot, "binding.gyp"),
  );
  copyFileSync(
    path.join(nativeSourceRoot, "src", "nodex_sparkle.mm"),
    path.join(nativeBuildRoot, "src", "nodex_sparkle.mm"),
  );
  const frameworkParent = toolchainPath;
  const electronVersion = (
    JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")) as {
      devDependencies?: Record<string, string>;
    }
  ).devDependencies?.electron;
  if (!electronVersion || !/^\d+\.\d+\.\d+$/u.test(electronVersion)) {
    throw new Error("Electron must be pinned to one exact version before building Sparkle.");
  }

  execFileSync(
    "pnpm",
    [
      "exec",
      "node-gyp",
      "rebuild",
      "--directory",
      nativeBuildRoot,
      `--target=${electronVersion}`,
      `--arch=${options.architecture}`,
      "--dist-url=https://electronjs.org/headers",
      `--sparkle_framework_parent_dir=${frameworkParent}`,
    ],
    {
      cwd: projectRoot,
      env: { ...process.env, MACOSX_DEPLOYMENT_TARGET: "15.0" },
      stdio: "inherit",
    },
  );

  const builtBridgePath = path.join(nativeBuildRoot, "build", "Release", "nodex_sparkle.node");
  const outputPath = path.resolve(options.outputPath);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const stagingParent = mkdtempSync(path.join(path.dirname(outputPath), ".sparkle-runtime-stage-"));
  const stagingRoot = path.join(stagingParent, "runtime");
  mkdirSync(stagingRoot);
  try {
    const stagedFramework = path.join(stagingRoot, "Sparkle.framework");
    execFileSync("/usr/bin/ditto", [
      path.join(toolchainPath, "Sparkle.framework"),
      stagedFramework,
    ]);
    rmSync(path.join(stagedFramework, "Versions", "B", "XPCServices"), {
      force: true,
      recursive: true,
    });
    rmSync(path.join(stagedFramework, "XPCServices"), { force: true });
    const stagedBridge = path.join(stagingRoot, "nodex-sparkle.node");
    copyFileSync(builtBridgePath, stagedBridge);
    chmodSync(stagedBridge, 0o755);

    const publicKey = readPublicKey(projectRoot);
    const manifest: SparkleRuntimeManifest = {
      artifacts: {
        autoupdate: artifactIdentity(
          path.join(stagedFramework, "Versions", "B", "Autoupdate"),
          "Frameworks/Sparkle.framework/Versions/B/Autoupdate",
        ),
        bridge: artifactIdentity(stagedBridge, "Resources/native/nodex-sparkle.node"),
        frameworkExecutable: artifactIdentity(
          path.join(stagedFramework, "Versions", "B", "Sparkle"),
          "Frameworks/Sparkle.framework/Versions/B/Sparkle",
        ),
        frameworkInfoPlist: artifactIdentity(
          path.join(stagedFramework, "Versions", "B", "Resources", "Info.plist"),
          "Frameworks/Sparkle.framework/Versions/B/Resources/Info.plist",
        ),
        updater: artifactIdentity(
          path.join(
            stagedFramework,
            "Versions",
            "B",
            "Updater.app",
            "Contents",
            "MacOS",
            "Updater",
          ),
          "Frameworks/Sparkle.framework/Versions/B/Updater.app/Contents/MacOS/Updater",
        ),
      },
      architecture: options.architecture,
      buildChannel: options.channel,
      feedUrls: options.channel === "disabled" ? null : feedUrlsFor(options.architecture),
      minimumMacOS: "15.0",
      publicKey,
      schemaVersion: 3,
      sparkleArchiveSha256: lock.archive.sha256,
      sparkleVersion: lock.version,
    };
    writeFileSync(
      path.join(stagingRoot, "sparkle-runtime.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    verifyStagedSparkleRuntime(stagingRoot, manifest);
    replaceOwnedDirectory(stagingRoot, outputPath);
    return verifyStagedSparkleRuntime(outputPath, manifest);
  } finally {
    rmSync(stagingParent, { force: true, recursive: true });
  }
}

function parseCliOptions(argv: readonly string[]): BuildSparkleBridgeOptions {
  const args = argv.filter((value) => value !== "--");
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error("Sparkle bridge arguments must be --key value pairs.");
    }
    values.set(key, value);
  }
  const architecture = values.get("--arch");
  const channel = values.get("--channel") ?? "disabled";
  const outputPath = values.get("--out");
  const toolchainPath =
    values.get("--toolchain") ??
    path.join(repositoryRoot, ".generated", "sparkle-toolchain", "2.9.4");
  if (
    (architecture !== "arm64" && architecture !== "x64") ||
    (channel !== "disabled" && channel !== "stable" && channel !== "nightly") ||
    !outputPath
  ) {
    throw new Error(
      "Usage: build-sparkle-bridge.ts --arch <arm64|x64> " +
        "--channel <disabled|stable|nightly> --out <runtime-directory>.",
    );
  }
  return { architecture, channel, outputPath, toolchainPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void buildSparkleBridge(parseCliOptions(process.argv.slice(2))).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
