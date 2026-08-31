import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  NATIVE_RUNTIME_BINARY_PATHS,
  sha256File,
  swiftTargetForNativeRuntime,
  type NativeRuntimeArchitecture,
  type NativeRuntimeBinaryName,
  type NativeRuntimeManifest,
} from "./native-runtime-manifest";
import { replaceOwnedDirectory } from "./replace-owned-directory";

type TargetArchitecture = NativeRuntimeArchitecture;

interface Arguments {
  readonly targetArch: TargetArchitecture;
  readonly outputRoot: string;
  readonly signIdentity: string | null;
}

const TARGETS = {
  arm64: "aarch64-apple-darwin",
  x64: "x86_64-apple-darwin",
} as const satisfies Readonly<Record<TargetArchitecture, string>>;

const expectedFileArchitecture = (architecture: TargetArchitecture): string =>
  architecture === "arm64" ? "arm64" : "x86_64";

const parseArguments = (argv: readonly string[]): Arguments => {
  let targetArch: TargetArchitecture | null = null;
  let outputRoot: string | null = null;
  let signIdentity: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    if (value === "--target-arch" && (next === "arm64" || next === "x64")) {
      targetArch = next;
      index += 1;
      continue;
    }
    if (value === "--out" && next) {
      outputRoot = next;
      index += 1;
      continue;
    }
    if (value === "--sign-identity" && next) {
      signIdentity = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete argument: ${value ?? "<missing>"}`);
  }

  if (!targetArch || !outputRoot) {
    throw new Error(
      "usage: stage-rust-core --target-arch arm64|x64 --out <.generated/path> [--sign-identity <identity>]",
    );
  }
  return { targetArch, outputRoot, signIdentity };
};

const assertGeneratedOutput = (repositoryRoot: string, outputRoot: string): string => {
  const generatedRoot = path.join(repositoryRoot, ".generated");
  const resolved = path.resolve(repositoryRoot, outputRoot);
  if (!resolved.startsWith(`${generatedRoot}${path.sep}`)) {
    throw new Error(`Rust runtime staging must stay beneath ${generatedRoot}`);
  }
  return resolved;
};

const assertNotSymlink = (entry: string): void => {
  try {
    if (lstatSync(entry).isSymbolicLink()) {
      throw new Error(`Refusing symlinked staging entry: ${entry}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

const readProductVersion = (repositoryRoot: string): string => {
  const value = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as {
    readonly version?: unknown;
  };
  const version = process.env.NODEX_RELEASE_VERSION ?? value.version;
  if (
    typeof version !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-nightly\.\d{8}\.[1-9]\d*)?$/u.test(version)
  ) {
    throw new Error(
      "Product version must be a stable semantic version or <stable>-nightly.YYYYMMDD.N.",
    );
  }
  return version;
};

const stage = ({ targetArch, outputRoot, signIdentity }: Arguments): void => {
  const repositoryRoot = path.resolve(".");
  const target = TARGETS[targetArch];
  const resolvedOutput = assertGeneratedOutput(repositoryRoot, outputRoot);
  assertNotSymlink(resolvedOutput);
  mkdirSync(resolvedOutput, { recursive: true, mode: 0o755 });
  const stagingRoot = mkdtempSync(path.join(resolvedOutput, ".rust-core-stage-"));
  const binDirectory = path.join(stagingRoot, "bin");
  mkdirSync(binDirectory, { mode: 0o755 });

  try {
    const serviceSource = path.join(repositoryRoot, "resources", "macos", "nodex-service.swift");
    const serviceBuild = path.join(stagingRoot, ".nodex-service.build");
    execFileSync("xcrun", [
      "swiftc",
      "-O",
      "-parse-as-library",
      "-target",
      swiftTargetForNativeRuntime(targetArch),
      serviceSource,
      "-o",
      serviceBuild,
    ]);
    const appshotHelperSource = path.join(
      repositoryRoot,
      "resources",
      "macos",
      "nodex-appshot-helper.swift",
    );
    const appshotHelperBuild = path.join(stagingRoot, ".nodex-appshot-helper.build");
    execFileSync("xcrun", [
      "swiftc",
      "-O",
      "-parse-as-library",
      "-target",
      swiftTargetForNativeRuntime(targetArch),
      appshotHelperSource,
      "-o",
      appshotHelperBuild,
    ]);
    const dictationHelperSource = path.join(
      repositoryRoot,
      "resources",
      "macos",
      "nodex-dictation-helper.swift",
    );
    const dictationHelperBuild = path.join(stagingRoot, ".nodex-dictation-helper.build");
    execFileSync("xcrun", [
      "swiftc",
      "-O",
      "-parse-as-library",
      "-target",
      swiftTargetForNativeRuntime(targetArch),
      dictationHelperSource,
      "-o",
      dictationHelperBuild,
    ]);

    const binaries: ReadonlyArray<{
      readonly name: NativeRuntimeBinaryName;
      readonly source: string;
    }> = [
      {
        name: "nodex-core",
        source: path.join(repositoryRoot, "target", target, "release", "nodex-core"),
      },
      {
        name: "nodex-browser-profile-helper",
        source: path.join(
          repositoryRoot,
          "target",
          target,
          "release",
          "nodex-browser-profile-helper",
        ),
      },
      {
        name: "nodex",
        source: path.join(repositoryRoot, "target", target, "release", "nodex"),
      },
      { name: "nodex-appshot-helper", source: appshotHelperBuild },
      { name: "nodex-dictation-helper", source: dictationHelperBuild },
      { name: "nodex-service", source: serviceBuild },
    ] as const;
    const entries = binaries.map(({ name, source }) => {
      const sourceStats = statSync(source);
      if (!sourceStats.isFile()) throw new Error(`Missing native binary: ${source}`);

      const fileDescription = execFileSync("file", ["-b", source], {
        encoding: "utf8",
      }).trim();
      const architecture = expectedFileArchitecture(targetArch);
      if (!fileDescription.includes("Mach-O") || !fileDescription.includes(architecture)) {
        throw new Error(`${name} has wrong architecture: ${fileDescription}`);
      }

      const loadCommands = execFileSync("otool", ["-l", source], {
        encoding: "utf8",
      });
      if (!/LC_BUILD_VERSION[\s\S]*?minos 15\.0\b/.test(loadCommands)) {
        throw new Error(`${name} does not declare macOS 15.0 compatibility`);
      }

      const destination = path.join(binDirectory, name);
      copyFileSync(source, destination);
      chmodSync(destination, 0o755);
      if (signIdentity) {
        execFileSync("codesign", [
          "--force",
          "--sign",
          signIdentity,
          "--timestamp=none",
          destination,
        ]);
        execFileSync("codesign", ["--verify", "--strict", destination]);
      }

      const stats = statSync(destination);
      if ((stats.mode & 0o777) !== 0o755) {
        throw new Error(`${name} was not staged executable`);
      }
      return {
        bundlePath: NATIVE_RUNTIME_BINARY_PATHS[name],
        file: fileDescription,
        name,
        sourceSha256: sha256File(destination),
        sourceSize: stats.size,
      };
    });

    const manifest: NativeRuntimeManifest = {
      schemaVersion: 4,
      targetPlatform: "darwin",
      targetArch,
      rustTarget: target,
      minimumMacOS: "15.0",
      productVersion: readProductVersion(repositoryRoot),
      binaries: entries,
    };
    writeFileSync(
      path.join(binDirectory, "rust-core-runtime.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    replaceOwnedDirectory(binDirectory, path.join(resolvedOutput, "bin"));
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
};

stage(parseArguments(process.argv.slice(2)));
