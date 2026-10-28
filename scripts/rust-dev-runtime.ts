import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml, type TomlTable } from "smol-toml";
import {
  cloneImmutableDirectory,
  cloneImmutableFile,
  ensureImmutableDirectory,
  immutableDirectoryDigest,
  resolveImmutableDirectoryPath,
} from "./immutable-artifact-cache";
import { replaceOwnedDirectory } from "./replace-owned-directory";

const RECIPE = "rust-dev-runtime-v1";
const BINARIES = ["nodex-core", "nodex", "nodex-browser-profile-helper"] as const;
const CARGO_ARGUMENTS = [
  "build",
  "--locked",
  "-p",
  "nodex-core-server",
  "-p",
  "nodex-cli",
  "-p",
  "nodex-browser-profile-helper",
] as const;
const INPUT_ROOTS = [
  "Cargo.toml",
  "Cargo.lock",
  "rust-toolchain.toml",
  ".cargo",
  "crates",
  "src/shared/block-documents",
  "src/shared/nfm/code-language-catalog-v1.json",
  "agent-skills/nodex",
  "scripts/rust-dev-runtime.ts",
] as const;

export interface RustDevRuntimeContext {
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly projectRoot?: string;
}

/** Custom compiler/profile contexts retain Cargo's ordinary local output and debugging behavior. */
export function usesSharedRustDevRuntime(input: RustDevRuntimeContext): boolean {
  if (input.platform !== "darwin" || input.architecture !== "arm64") return false;
  if (input.environment.CI !== undefined) return false;
  if (!hasSystemNativeTools(input.projectRoot ?? process.cwd(), input.environment)) return false;
  if (input.projectRoot && !hasDefaultCargoConfiguration(input.projectRoot, input.environment))
    return false;
  return !Object.entries(input.environment).some(([name, value]) => {
    if (value === undefined) return false;
    if (
      input.projectRoot &&
      name === "NODEX_CORE_EXECUTABLE" &&
      value === rustDevRuntimeExecutable(input.projectRoot, "nodex-core")
    )
      return false;
    if (
      input.projectRoot &&
      name === "NODEX_BROWSER_PROFILE_HELPER_EXECUTABLE" &&
      value === rustDevRuntimeExecutable(input.projectRoot, "nodex-browser-profile-helper")
    )
      return false;
    if (name.startsWith("CARGO_") && name !== "CARGO_HOME") return true;
    if (
      /^(?:RUSTFLAGS|RUSTDOCFLAGS|RUSTC|RUSTDOC|RUST_LIBC|RUSTUP_TOOLCHAIN|CC|CXX|AR|ARFLAGS|RANLIB|CFLAGS|CXXFLAGS|CPPFLAGS|LDFLAGS|CPATH|C_INCLUDE_PATH|CPLUS_INCLUDE_PATH|LIBRARY_PATH|LD_LIBRARY_PATH|DYLD_LIBRARY_PATH|DYLD_FALLBACK_LIBRARY_PATH|HOST|TARGET|CRATE_CC|CROSS_COMPILE|CXXSTDLIB|PKG_CONFIG|SQLITE|LIBSQLITE3|ZSTD_SYS|BINDGEN|LIBCLANG_PATH|DEP|SDKROOT|DEVELOPER_DIR|NODEX_RELEASE_VERSION|NODEX_CORE_EXECUTABLE|NODEX_BROWSER_PROFILE_HELPER_EXECUTABLE)(?:_|$)/u.test(
        name,
      )
    )
      return true;
    return name === "MACOSX_DEPLOYMENT_TARGET" && value !== "15.0";
  });
}

export const rustDevRuntimeDirectory = (projectRoot: string): string =>
  path.join(projectRoot, ".generated/rust-dev-runtime");

export const rustDevRuntimeExecutable = (
  projectRoot: string,
  binary: (typeof BINARIES)[number],
): string => path.join(rustDevRuntimeDirectory(projectRoot), "bin", binary);

function visitFiles(root: string, relative: string, files: Map<string, string>): void {
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) return;
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error(`Rust build inputs must not be symlinks: ${absolute}`);
  if (stat.isFile()) {
    files.set(relative, createHash("sha256").update(readFileSync(absolute)).digest("hex"));
    return;
  }
  if (!stat.isDirectory()) throw new Error(`Unsupported Rust build input: ${absolute}`);
  for (const name of readdirSync(absolute).sort())
    visitFiles(root, path.join(relative, name), files);
}

/** Includes complete local crate trees and the non-Rust assets embedded in native binaries. */
export function rustDevInputFiles(projectRoot: string): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  for (const relative of INPUT_ROOTS) visitFiles(projectRoot, relative, files);
  return files;
}

export function rustDevFingerprint(
  files: ReadonlyMap<string, string>,
  toolchainIdentity: readonly string[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        recipe: RECIPE,
        files: [...files].sort(([a], [b]) => a.localeCompare(b)),
        toolchainIdentity,
      }),
    )
    .digest("hex");
}

/** Cargo emits Make-escaped paths in its top-level binary dependency files. */
export function parseRustDepInfo(text: string): readonly string[] {
  const rule = text.replace(/\\\r?\n/gu, "").split("\n")[0] ?? "";
  const delimiter = rule.indexOf(": ");
  if (delimiter < 0) throw new Error("Invalid Cargo binary dependency file");
  return [...rule.slice(delimiter + 2).matchAll(/(?:\\.|[^\s\\])+/gu)].map(([value]) =>
    value.replace(/\\(.)/gu, "$1"),
  );
}

function assertInputClosure(projectRoot: string, inputs: ReadonlyMap<string, string>): void {
  for (const binary of BINARIES) {
    const dependencyFile = path.join(projectRoot, "target/debug", `${binary}.d`);
    for (const dependency of parseRustDepInfo(readFileSync(dependencyFile, "utf8"))) {
      const relative = path.relative(projectRoot, path.resolve(projectRoot, dependency));
      if (inputs.has(relative)) continue;
      throw new Error(
        `Rust build input is outside the shared-cache fingerprint: ${dependency}. Add its owning input root before caching this build.`,
      );
    }
  }
}

type CommandOptions = {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly inheritOutput?: boolean;
};
export type RustDevCommand = (
  command: string,
  args: readonly string[],
  options: CommandOptions,
) => string;

const executeCommand: RustDevCommand = (command, args, options) =>
  execFileSync(command, [...args], {
    cwd: options.cwd,
    env: options.environment,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: options.inheritOutput ? "inherit" : ["ignore", "pipe", "pipe"],
  })?.trim() ?? "";

function hasSystemNativeTools(projectRoot: string, environment: NodeJS.ProcessEnv): boolean {
  const directories = (environment.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(path.delimiter);
  return ["cc", "ar", "ranlib", "ld"].every((tool) => {
    const executable = directories
      .map((directory) => path.resolve(projectRoot, directory, tool))
      .find((candidate) => {
        try {
          accessSync(candidate, constants.X_OK);
          return lstatSync(candidate).isFile() || lstatSync(candidate).isSymbolicLink();
        } catch {
          return false;
        }
      });
    return executable === `/usr/bin/${tool}`;
  });
}

function cargoConfigurationFiles(projectRoot: string, environment: NodeJS.ProcessEnv): string[] {
  const configs = new Set<string>();
  const addConfig = (directory: string): void => {
    // Cargo prefers the extensionless file when both names exist.
    const file = ["config", "config.toml"]
      .map((name) => path.join(directory, name))
      .find(existsSync);
    if (file) configs.add(file);
  };
  let directory = projectRoot;
  while (true) {
    addConfig(path.join(directory, ".cargo"));
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const cargoHome = path.resolve(
    projectRoot,
    environment.CARGO_HOME ?? path.join(environment.HOME ?? os.homedir(), ".cargo"),
  );
  addConfig(cargoHome);
  return [...configs];
}

type CargoConfiguration = { readonly file: string; readonly value: TomlTable };

function cargoInclude(
  entry: unknown,
  file: string,
): { readonly file: string; readonly optional: boolean } {
  if (typeof entry === "string")
    return { file: path.resolve(path.dirname(file), entry), optional: false };
  if (
    typeof entry !== "object" ||
    entry === null ||
    !("path" in entry) ||
    typeof entry.path !== "string"
  )
    throw new Error(`Invalid Cargo config include in ${file}`);
  if ("optional" in entry && typeof entry.optional !== "boolean")
    throw new Error(`Invalid optional Cargo config include in ${file}`);
  return {
    file: path.resolve(path.dirname(file), entry.path),
    optional: "optional" in entry && entry.optional === true,
  };
}

/** Highest precedence first: the file itself, then its includes from last to first. */
function cargoConfigurationClosure(
  file: string,
  parents: readonly string[] = [],
): readonly CargoConfiguration[] {
  const canonical = realpathSync(file);
  if (parents.includes(canonical)) throw new Error(`Cargo config include cycle at ${file}`);
  const value = parseToml(readFileSync(file, "utf8"));
  if (value.include === undefined) return [{ file, value }];
  if (!Array.isArray(value.include))
    throw new Error(`Cargo config include must be an array in ${file}`);
  const included = [...value.include].reverse().flatMap((entry) => {
    const include = cargoInclude(entry, file);
    if (include.optional && !existsSync(include.file)) return [];
    return cargoConfigurationClosure(include.file, [...parents, canonical]);
  });
  return [{ file, value }, ...included];
}

/** Cargo configuration paths are relative to the directory containing .cargo, unlike env paths. */
export function rustDevCargoOutputDirectory(
  projectRoot: string,
  environment: NodeJS.ProcessEnv,
  run: RustDevCommand = executeCommand,
): string {
  const configs = cargoConfigurationFiles(projectRoot, environment).flatMap((file) =>
    cargoConfigurationClosure(file),
  );
  const configured = (
    key: string,
  ): { readonly file: string; readonly value: string } | undefined => {
    for (const {
      file,
      value: { build },
    } of configs) {
      if (typeof build !== "object" || build === null || !(key in build)) continue;
      const value = build[key as keyof typeof build];
      if (typeof value !== "string")
        throw new Error(`Nodex dev requires one string build.${key} in ${file}`);
      return { file, value };
    }
    return undefined;
  };
  const targetDir = configured("target-dir");
  const target = environment.CARGO_BUILD_TARGET ?? configured("target")?.value;
  const targetRoot = environment.CARGO_TARGET_DIR ?? environment.CARGO_BUILD_TARGET_DIR;
  const outputRoot =
    targetRoot !== undefined
      ? path.resolve(projectRoot, targetRoot)
      : targetDir
        ? path.resolve(path.dirname(path.dirname(targetDir.file)), targetDir.value)
        : path.join(projectRoot, "target");
  if (!target) return path.join(outputRoot, "debug");
  const resolvedTarget =
    target === "host-tuple"
      ? run("rustc", ["--version", "--verbose"], { cwd: projectRoot, environment }).match(
          /^host:\s*(\S+)$/mu,
        )?.[1]
      : target;
  if (!resolvedTarget) throw new Error("Could not resolve Cargo's host-tuple build target");
  const targetName = resolvedTarget.endsWith(".json")
    ? path.basename(resolvedTarget, ".json")
    : resolvedTarget;
  if (targetName.includes(path.sep) || /\s/u.test(targetName))
    throw new Error("Nodex dev requires one Cargo build target");
  return path.join(outputRoot, targetName, "debug");
}

function hasDefaultCargoConfiguration(
  projectRoot: string,
  environment: NodeJS.ProcessEnv,
): boolean {
  return cargoConfigurationFiles(projectRoot, environment).every((file) => {
    const config = parseToml(readFileSync(file, "utf8"));
    return Object.entries(config).every(([section, value]) => {
      if (section === "build")
        return (
          typeof value === "object" &&
          value !== null &&
          Object.entries(value).every(
            ([key, wrapper]) =>
              key === "rustc-wrapper" &&
              typeof wrapper === "string" &&
              path.basename(wrapper) === "sccache",
          )
        );
      if (section === "env")
        return (
          JSON.stringify(value) ===
          JSON.stringify({
            MACOSX_DEPLOYMENT_TARGET: "15.0",
            RUST_TEST_THREADS: { value: "2", force: false },
          })
        );
      if (section === "target")
        return (
          JSON.stringify(value) ===
          JSON.stringify({
            "aarch64-apple-darwin": { rustflags: ["-C", "link-arg=-mmacosx-version-min=15.0"] },
          })
        );
      return false;
    });
  });
}

function readToolchainIdentity(
  projectRoot: string,
  environment: NodeJS.ProcessEnv,
  run: RustDevCommand,
): string[] {
  const options = { cwd: projectRoot, environment };
  const queries: readonly (readonly [string, readonly string[]])[] = [
    ["rustc", ["--version", "--verbose"]],
    ["cargo", ["--version"]],
    ["xcrun", ["--show-sdk-path"]],
    ["xcrun", ["--show-sdk-build-version"]],
    ["xcrun", ["clang", "--version"]],
    ["xcrun", ["ld", "-version_details"]],
    ["xcrun", ["dsymutil", "--version"]],
  ];
  return [
    ...queries.map(([command, args]) => run(command, args, options)),
    ...cargoConfigurationFiles(projectRoot, environment).map((file) => readFileSync(file, "utf8")),
  ];
}

function validateBundle(directory: string, run: RustDevCommand, options: CommandOptions): void {
  for (const binary of BINARIES) {
    const executable = path.join(directory, "bin", binary);
    if (!lstatSync(executable).isFile() || !(lstatSync(executable).mode & 0o111))
      throw new Error(`Rust development executable is missing or not executable: ${executable}`);
    const dwarf = path.join(`${executable}.dSYM`, "Contents/Resources/DWARF", binary);
    if (!lstatSync(dwarf).isFile() || lstatSync(dwarf).size === 0)
      throw new Error(`Rust development debug symbols are missing: ${dwarf}`);
    const executableUuid = run("xcrun", ["dwarfdump", "--uuid", executable], options).split(" ")[1];
    const dwarfUuid = run("xcrun", ["dwarfdump", "--uuid", dwarf], options).split(" ")[1];
    if (!executableUuid || executableUuid !== dwarfUuid)
      throw new Error(`Rust development debug symbols do not match ${binary}`);
    const sources = run("xcrun", ["dwarfdump", "--show-sources", dwarf], options);
    const crate =
      binary === "nodex" ? "nodex-cli" : binary === "nodex-core" ? "nodex-core-server" : binary;
    if (
      !sources
        .split("\n")
        .some(
          (source) =>
            source === `crates/${crate}/src/main.rs` || source === `./crates/${crate}/src/main.rs`,
        )
    )
      throw new Error(`Rust development debug symbols lack portable source lines for ${binary}`);
  }
}

/**
 * Shares only sealed native dev bundles. Cargo's writable target and incremental state stay local;
 * dSYM generation runs while object files exist, before any consumer can use the bundle.
 */
export async function prepareRustDevRuntime(input: {
  readonly projectRoot: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly run?: RustDevCommand;
}): Promise<{
  readonly cached: boolean;
  readonly fingerprint?: string;
  readonly outputRoot: string;
}> {
  const projectRoot = path.resolve(input.projectRoot);
  const environment = input.environment ?? process.env;
  const run = input.run ?? executeCommand;
  const options = { cwd: projectRoot, environment };
  if (
    !usesSharedRustDevRuntime({
      environment,
      platform: input.platform ?? process.platform,
      architecture: input.architecture ?? process.arch,
      projectRoot,
    })
  ) {
    run("cargo", CARGO_ARGUMENTS, { ...options, inheritOutput: true });
    return {
      cached: false,
      outputRoot: rustDevCargoOutputDirectory(projectRoot, environment, run),
    };
  }
  const identity = readToolchainIdentity(projectRoot, environment, run);
  const inputs = rustDevInputFiles(projectRoot);
  const fingerprint = rustDevFingerprint(inputs, identity);
  const cachePath = resolveImmutableDirectoryPath({
    archiveSha256: fingerprint,
    directoryName: RECIPE,
    family: "rust-dev-runtime",
    projectRoot,
  });
  const outputRoot = rustDevRuntimeDirectory(projectRoot);
  const receiptPath = `${outputRoot}.json`;
  let built = false;
  await ensureImmutableDirectory(
    {
      destinationPath: cachePath,
      label: "Rust development binaries",
      validate: (directory) => validateBundle(directory, run, options),
      generate: (directory) => {
        process.stdout.write("Building shared Rust development binaries\n");
        // Explicit flags keep the repository's deployment floor and make source paths portable.
        const buildEnvironment = {
          ...environment,
          CARGO_ENCODED_RUSTFLAGS: [
            "-C",
            "link-arg=-mmacosx-version-min=15.0",
            `--remap-path-prefix=${projectRoot}=.`,
          ].join("\x1f"),
        };
        run("cargo", CARGO_ARGUMENTS, {
          cwd: projectRoot,
          environment: buildEnvironment,
          inheritOutput: true,
        });
        assertInputClosure(projectRoot, inputs);
        if (rustDevFingerprint(rustDevInputFiles(projectRoot), identity) !== fingerprint)
          throw new Error("Rust build inputs changed while compiling; rerun preparation");
        mkdirSync(path.join(directory, "bin"), { recursive: true });
        for (const binary of BINARIES) {
          const executable = path.join(directory, "bin", binary);
          cloneImmutableFile(path.join(projectRoot, "target/debug", binary), executable);
          run("xcrun", ["dsymutil", executable, "-o", `${executable}.dSYM`], {
            ...options,
            inheritOutput: true,
          });
        }
        built = true;
      },
    },
    (directory) => {
      const digest = immutableDirectoryDigest(directory);
      try {
        const receipt: unknown = JSON.parse(readFileSync(receiptPath, "utf8"));
        if (
          typeof receipt === "object" &&
          receipt !== null &&
          "fingerprint" in receipt &&
          receipt.fingerprint === fingerprint &&
          "digest" in receipt &&
          receipt.digest === digest &&
          immutableDirectoryDigest(outputRoot) === digest
        )
          return;
      } catch {
        /* An absent or damaged output is restored from the verified cache. */
      }
      mkdirSync(path.dirname(outputRoot), { recursive: true });
      const temporary = mkdtempSync(`${outputRoot}.part-`);
      try {
        cloneImmutableDirectory(directory, temporary);
        replaceOwnedDirectory(temporary, outputRoot);
        writeFileSync(receiptPath, `${JSON.stringify({ fingerprint, digest })}\n`);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    },
  );
  process.stdout.write(
    `${built ? "Prepared" : "Reused"} Rust development binaries (${fingerprint.slice(0, 12)})\n`,
  );
  return { cached: !built, fingerprint, outputRoot };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) throw new Error("Usage: rust-dev-runtime.ts");
  void prepareRustDevRuntime({
    projectRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
