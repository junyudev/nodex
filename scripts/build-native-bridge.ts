import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyOwnedNativeBridgePlatform } from "./native-bridge-platform-contract";
import {
  NATIVE_RUNTIME_MINIMUM_MACOS,
  type NativeRuntimeArchitecture,
} from "./native-runtime-manifest";

interface NativeBridgeBuild {
  readonly architecture: "arm64";
  readonly name: "clipboard" | "devicecheck" | "notifications";
  readonly script: string;
  readonly repositoryRoot: string;
}

const require = createRequire(import.meta.url);
const implementationPath = fileURLToPath(import.meta.url);
const digestBytes = (contents: Buffer): string =>
  createHash("sha256").update(contents).digest("hex");
const digest = (file: string): string => digestBytes(readFileSync(file));

// Overrides can refer to mutable external compilers, headers, or Gyp extensions.
// Build normally in those environments instead of guessing their dependency closure.
const customBuildEnvironment =
  /^(?:(?:CC|CXX|CPP|AR|LD|LINK)(?:_host|_target)?|MAKE|MAKEFLAGS|MFLAGS|MAKEFILES|CFLAGS|CXXFLAGS|CPPFLAGS|LDFLAGS|ARCHFLAGS|CPATH|C_INCLUDE_PATH|CPLUS_INCLUDE_PATH|LIBRARY_PATH|PYTHON|PYTHONPATH|NODE_GYP_FORCE_PYTHON|GYP_.*|npm_package_config_node_gyp_.*|npm_config_(?:python|nodedir|node_gyp|disturl|devdir|tarball|make|debug|arch|target|runtime|force_process_config))$/iu;

function toolchainIdentity(environment: NodeJS.ProcessEnv): readonly string[] | null {
  if (Object.keys(environment).some((key) => environment[key] && customBuildEnvironment.test(key)))
    return null;
  if (existsSync(path.join(homedir(), ".gyp", "include.gypi"))) return null;
  if (
    /--(?:require|import|(?:experimental-)?loader)\b|(?:^|\s)-r/u.test(
      environment.NODE_OPTIONS ?? "",
    )
  )
    return null;
  try {
    const inspect = (command: string, args: string[]) =>
      execFileSync(command, args, { encoding: "utf8", env: environment, timeout: 5_000 }).trim();
    const sdk = inspect("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
    // Apple tool launchers can export an alias for the selected SDK. Its identity
    // is already tracked below; a genuinely external SDK still requires a rebuild.
    if (environment.SDKROOT && realpathSync(environment.SDKROOT) !== realpathSync(sdk)) return null;
    return [
      inspect("/usr/bin/xcrun", ["--find", "clang++"]),
      inspect("/usr/bin/xcrun", ["clang++", "--version"]),
      sdk,
      inspect("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-build-version"]),
      inspect("python3", ["--version"]),
      inspect("make", ["--version"]),
    ];
  } catch {
    return null;
  }
}

function verifyBinary(binary: string, architecture: NativeRuntimeArchitecture): string {
  const stat = lstatSync(binary);
  if (!stat.isFile() || (stat.mode & 0o111) === 0) {
    throw new Error(`Native bridge must be an executable regular file: ${binary}`);
  }
  verifyOwnedNativeBridgePlatform(binary, architecture);
  return digest(binary);
}

/** Reuse only a verified local output built from the same source and native toolchain. */
export function buildNativeBridge(input: NativeBridgeBuild): "built" | "reused" {
  if (process.platform !== "darwin") throw new Error("Native bridges require macOS");
  const { architecture, name, repositoryRoot } = input;
  const electronVersion = (
    JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as {
      devDependencies: { electron: string };
    }
  ).devDependencies.electron;
  if (!/^\d+\.\d+\.\d+$/u.test(electronVersion)) throw new Error("Electron must be exactly pinned");
  const source = path.join(repositoryRoot, "native", `macos-${name}`);
  const files = ["binding.gyp", `src/nodex_${name}.mm`].map((file) => ({
    file,
    contents: readFileSync(path.join(source, file)),
  }));
  const environment = { ...process.env, MACOSX_DEPLOYMENT_TARGET: NATIVE_RUNTIME_MINIMUM_MACOS };
  const toolchain = toolchainIdentity(environment);
  const identity =
    toolchain === null
      ? null
      : createHash("sha256")
          .update(
            JSON.stringify({
              architecture,
              electronVersion,
              node: process.version,
              nodePath: process.execPath,
              nodeGyp: digest(require.resolve("node-gyp/package.json")),
              toolchain,
              environment: Object.entries(environment)
                .filter(([key]) =>
                  /^(?:PATH|DEVELOPER_DIR|MACOSX_DEPLOYMENT_TARGET|NODE_OPTIONS|npm_config_.*|npm_package_config_node_gyp_.*)$/iu.test(
                    key,
                  ),
                )
                .sort(([left], [right]) => left.localeCompare(right)),
              sources: [
                ...files.map(({ file, contents }) => [file, digestBytes(contents)]),
                ["implementation", digest(implementationPath)],
                ["script", digest(path.join(repositoryRoot, input.script))],
                ["lockfile", digest(path.join(repositoryRoot, "pnpm-lock.yaml"))],
              ],
            }),
          )
          .digest("hex");
  const output = path.join(repositoryRoot, ".generated", `${name}-runtime`, architecture);
  const outputBinary = path.join(output, `nodex-${name}.node`);
  const stampPath = `${outputBinary}.build.json`;
  if (identity !== null) {
    try {
      const stamp = JSON.parse(readFileSync(stampPath, "utf8")) as {
        identity?: unknown;
        sha256?: unknown;
      };
      if (
        stamp.identity === identity &&
        stamp.sha256 === verifyBinary(outputBinary, architecture)
      ) {
        return "reused";
      }
    } catch {
      // Missing, corrupt, or incomplete local outputs are rebuilt from source.
    }
  }

  const buildParent = path.join(repositoryRoot, ".generated", `${name}-native-build`, architecture);
  mkdirSync(buildParent, { recursive: true });
  const buildRoot = mkdtempSync(path.join(buildParent, "build-"));
  try {
    mkdirSync(path.join(buildRoot, "src"));
    for (const { file, contents } of files) writeFileSync(path.join(buildRoot, file), contents);
    execFileSync(
      process.execPath,
      [
        require.resolve("node-gyp/bin/node-gyp.js"),
        "rebuild",
        "--directory",
        buildRoot,
        `--target=${electronVersion}`,
        `--arch=${architecture}`,
        "--dist-url=https://electronjs.org/headers",
      ],
      { cwd: repositoryRoot, env: environment, stdio: "inherit" },
    );
    const binary = path.join(buildRoot, "build", "Release", `nodex_${name}.node`);
    chmodSync(binary, 0o755);
    const sha256 = verifyBinary(binary, architecture);
    // Publish complete files only. A racing or interrupted pair cannot match both hashes.
    const stagedStamp = path.join(buildRoot, "stamp.json");
    if (identity !== null) writeFileSync(stagedStamp, `${JSON.stringify({ identity, sha256 })}\n`);
    mkdirSync(output, { recursive: true });
    renameSync(binary, outputBinary);
    if (identity !== null) renameSync(stagedStamp, stampPath);
    else rmSync(stampPath, { force: true });
    return "built";
  } finally {
    rmSync(buildRoot, { force: true, recursive: true });
  }
}
