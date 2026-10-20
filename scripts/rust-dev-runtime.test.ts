import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  parseRustDepInfo,
  prepareRustDevRuntime,
  rustDevFingerprint,
  rustDevCargoOutputDirectory,
  rustDevInputFiles,
  rustDevRuntimeExecutable,
  usesSharedRustDevRuntime,
  type RustDevCommand,
} from "./rust-dev-runtime";
import { resolveImmutableDirectoryPath } from "./immutable-artifact-cache";

const temporaryRoots: string[] = [];
const binaries = ["nodex-core", "nodex", "nodex-browser-profile-helper"] as const;
const write = (file: string, text: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
function fixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "nodex-rust-cache-"));
  temporaryRoots.push(root);
  write(path.join(root, "Cargo.toml"), "[workspace]\n");
  write(path.join(root, "Cargo.lock"), "version = 4\n");
  write(path.join(root, "crates/core/src/main.rs"), "fn main() {}\n");
  write(path.join(root, "src/shared/block-documents/policy.json"), "{}");
  write(path.join(root, "agent-skills/nodex/references/nested-markdown.md"), "example");
  return root;
}
function buildAdapter(
  options: {
    readonly extraDependency?: string;
    readonly fail?: boolean;
    readonly identity?: string;
    readonly missingSymbols?: boolean;
  } = {},
) {
  const calls: {
    readonly command: string;
    readonly args: readonly string[];
    readonly environment: NodeJS.ProcessEnv;
  }[] = [];
  const run: RustDevCommand = (command, args, input) => {
    calls.push({ command, args, environment: input.environment });
    if (command === "cargo" && args[0] === "build") {
      if (options.fail) throw new Error("compiler failed");
      for (const binary of binaries) {
        const file = path.join(input.cwd, "target/debug", binary);
        write(file, `binary:${binary}`);
        chmodSync(file, 0o755);
        const dependency = path.join(input.cwd, "crates/core/src/main.rs");
        write(
          `${file}.d`,
          `${file}: ${dependency}${options.extraDependency ? ` ${options.extraDependency}` : ""}\n`,
        );
      }
      return "";
    }
    if (command === "xcrun" && args[0] === "dsymutil" && args[1] !== "--version") {
      const output = args[3]!;
      write(
        path.join(output, "Contents/Resources/DWARF", path.basename(args[1]!)),
        "standalone line tables",
      );
      write(path.join(output, "Contents/Info.plist"), "plist");
      return "";
    }
    if (command === "xcrun" && args[0] === "dwarfdump" && args[1] === "--show-sources") {
      if (options.missingSymbols) return "";
      const binary = path.basename(args[2]!);
      const crate =
        binary === "nodex" ? "nodex-cli" : binary === "nodex-core" ? "nodex-core-server" : binary;
      return `./crates/${crate}/src/main.rs`;
    }
    if (command === "xcrun" && args[0] === "dwarfdump")
      return "UUID: 11111111-1111-4111-8111-111111111111 (arm64) binary";
    return options.identity ?? "test-toolchain";
  };
  return {
    run,
    calls,
    builds: () => calls.filter(({ command, args }) => command === "cargo" && args[0] === "build"),
  };
}
const environment = (root: string): NodeJS.ProcessEnv => ({ HOME: root });
const prepare = (root: string, run: RustDevCommand) =>
  prepareRustDevRuntime({
    projectRoot: root,
    environment: environment(root),
    platform: "darwin",
    architecture: "arm64",
    run,
  });
function useCache(): void {
  const root = fixture();
  vi.stubEnv("NODEX_BUILD_CACHE_DIR", path.join(root, "cache"));
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("shares exact native inputs across worktrees, retaining independent outputs and standalone symbols", async () => {
  useCache();
  const producer = fixture();
  const consumer = fixture();
  const build = buildAdapter();
  const produced = await prepare(producer, build.run);
  rmSync(path.join(producer, "target"), { recursive: true });
  const reused = await prepare(consumer, build.run);
  expect(produced.cached).toBe(false);
  expect(reused).toMatchObject({ cached: true, fingerprint: produced.fingerprint });
  expect(build.builds()).toHaveLength(1);
  expect(build.builds()[0]!.environment.CARGO_ENCODED_RUSTFLAGS).toContain(
    `--remap-path-prefix=${producer}=.`,
  );
  const executable = rustDevRuntimeExecutable(consumer, "nodex-core");
  expect(
    readFileSync(path.join(`${executable}.dSYM`, "Contents/Resources/DWARF/nodex-core"), "utf8"),
  ).toBe("standalone line tables");
  writeFileSync(executable, "consumer edit");
  expect(readFileSync(rustDevRuntimeExecutable(producer, "nodex-core"), "utf8")).toBe(
    "binary:nodex-core",
  );
  await prepare(consumer, build.run);
  expect(readFileSync(executable, "utf8")).toBe("binary:nodex-core");
  expect(build.builds()).toHaveLength(1);
});

test("invalidates embedded assets, compiler context and crate sources while ignoring unrelated frontend edits", async () => {
  const root = fixture();
  const fingerprint = () => rustDevFingerprint(rustDevInputFiles(root), ["toolchain"]);
  const original = fingerprint();
  write(path.join(root, "src/renderer/page.tsx"), "frontend change");
  expect(fingerprint()).toBe(original);
  write(path.join(root, "src/shared/block-documents/policy.json"), '{"rule":true}');
  expect(fingerprint()).not.toBe(original);
  const policyChanged = fingerprint();
  write(path.join(root, "agent-skills/nodex/references/nested-markdown.md"), "new skill");
  expect(fingerprint()).not.toBe(policyChanged);
  const skillChanged = fingerprint();
  write(path.join(root, "crates/core/src/main.rs"), "fn main() { panic!() }\n");
  expect(fingerprint()).not.toBe(skillChanged);
  expect(rustDevFingerprint(rustDevInputFiles(root), ["another toolchain"])).not.toBe(
    fingerprint(),
  );
});

test("repairs damaged shared symbols and serializes concurrent producers", async () => {
  useCache();
  const first = fixture();
  const second = fixture();
  const build = buildAdapter();
  const [result] = await Promise.all([prepare(first, build.run), prepare(second, build.run)]);
  expect(build.builds()).toHaveLength(1);
  const cache = resolveImmutableDirectoryPath({
    projectRoot: first,
    family: "rust-dev-runtime",
    archiveSha256: result!.fingerprint!,
    directoryName: "rust-dev-runtime-v1",
  });
  writeFileSync(
    path.join(cache, "content/bin/nodex-core.dSYM/Contents/Resources/DWARF/nodex-core"),
    "broken",
  );
  await prepare(second, build.run);
  expect(build.builds()).toHaveLength(2);
});

test("keeps the previous runnable output if new inputs fail to compile or escape the fingerprint", async () => {
  useCache();
  const root = fixture();
  await prepare(root, buildAdapter().run);
  write(path.join(root, "crates/core/src/main.rs"), "changed\n");
  await expect(prepare(root, buildAdapter({ fail: true }).run)).rejects.toThrow("compiler failed");
  expect(readFileSync(rustDevRuntimeExecutable(root, "nodex-core"), "utf8")).toBe(
    "binary:nodex-core",
  );
  const extraDependency = path.join(root, "unregistered.json");
  write(extraDependency, "{}");
  await expect(prepare(root, buildAdapter({ extraDependency }).run)).rejects.toThrow(
    "outside the shared-cache fingerprint",
  );
  expect(readFileSync(rustDevRuntimeExecutable(root, "nodex-core"), "utf8")).toBe(
    "binary:nodex-core",
  );
});

test("refuses a bundle whose matching UUID has no application source lines", async () => {
  useCache();
  const root = fixture();
  await expect(prepare(root, buildAdapter({ missingSymbols: true }).run)).rejects.toThrow(
    "lack portable source lines",
  );
  expect(existsSync(rustDevRuntimeExecutable(root, "nodex-core"))).toBe(false);
});

test.each([
  { CARGO_PROFILE_DEV_DEBUG: "full" },
  { CARGO_TARGET_DIR: "/tmp/other-target" },
  { CARGO_INCREMENTAL: "0" },
  { RUSTFLAGS: "-C opt-level=2" },
  { CC: "/tmp/compiler" },
  { NODEX_RELEASE_VERSION: "1.0.0" },
  { NODEX_CORE_EXECUTABLE: "/tmp/custom-core" },
  { RUSTC_WRAPPER: "" },
  { CPATH: "/tmp/includes" },
  { C_INCLUDE_PATH: "/tmp/includes" },
  { CPLUS_INCLUDE_PATH: "/tmp/includes" },
  { LIBRARY_PATH: "/tmp/libs" },
  { DYLD_LIBRARY_PATH: "/tmp/libs" },
  { SQLITE_MAX_COLUMN: "100" },
  { LIBSQLITE3_FLAGS: "SQLITE_OMIT_DEPRECATED" },
  { ZSTD_SYS_USE_PKG_CONFIG: "1" },
  { HOST_CFLAGS: "-O3" },
  { ARFLAGS: "test" },
  { CI: "true" },
])("bypasses shared outputs for custom context %j", async (custom) => {
  useCache();
  const root = fixture();
  const build = buildAdapter();
  const result = await prepareRustDevRuntime({
    projectRoot: root,
    environment: { ...environment(root), ...custom },
    platform: "darwin",
    architecture: "arm64",
    run: build.run,
  });
  expect(result.cached).toBe(false);
  expect(result.outputRoot).toBe(
    rustDevCargoOutputDirectory(root, { ...environment(root), ...custom }),
  );
  expect(build.builds()).toHaveLength(1);
  expect(build.builds()[0]!.environment.CARGO_ENCODED_RUSTFLAGS).toBeUndefined();
  expect(existsSync(path.join(root, ".generated/rust-dev-runtime"))).toBe(false);
});

test("resolves custom Cargo output paths using environment precedence and configuration-relative paths", () => {
  const root = fixture();
  write(
    path.join(root, ".cargo/config.toml"),
    '[build]\ntarget-dir = "custom-target"\ntarget = "aarch64-apple-darwin"\n',
  );
  expect(rustDevCargoOutputDirectory(root, environment(root))).toBe(
    path.join(root, "custom-target/aarch64-apple-darwin/debug"),
  );
  expect(
    rustDevCargoOutputDirectory(root, { ...environment(root), CARGO_TARGET_DIR: "env-target" }),
  ).toBe(path.join(root, "env-target/aarch64-apple-darwin/debug"));
  expect(
    rustDevCargoOutputDirectory(root, {
      ...environment(root),
      CARGO_TARGET_DIR: "env-target",
      CARGO_BUILD_TARGET: "custom/target.json",
    }),
  ).toBe(path.join(root, "env-target/target/debug"));
  write(path.join(root, ".cargo/config"), '[build]\ntarget-dir = "preferred-target"\n');
  expect(rustDevCargoOutputDirectory(root, environment(root))).toBe(
    path.join(root, "preferred-target/debug"),
  );
  expect(
    rustDevCargoOutputDirectory(
      root,
      { ...environment(root), CARGO_BUILD_TARGET: "host-tuple" },
      () => "host: aarch64-apple-darwin",
    ),
  ).toBe(path.join(root, "preferred-target/aarch64-apple-darwin/debug"));
});

test("resolves included Cargo configs in precedence order with each file's relative paths", () => {
  const root = fixture();
  const config = path.join(root, ".cargo/config.toml");
  write(
    config,
    'include = ["first.toml", "nested/second.toml", { path = "missing.toml", optional = true }]\n',
  );
  write(path.join(root, ".cargo/first.toml"), '[build]\ntarget-dir = "first-target"\n');
  write(
    path.join(root, ".cargo/nested/second.toml"),
    'include = ["../third.toml"]\n[build]\ntarget-dir = "second-target"\n',
  );
  write(path.join(root, ".cargo/third.toml"), '[build]\ntarget-dir = "third-target"\n');
  expect(rustDevCargoOutputDirectory(root, environment(root))).toBe(
    path.join(root, ".cargo/second-target/debug"),
  );
  expect(
    rustDevCargoOutputDirectory(root, { ...environment(root), CARGO_TARGET_DIR: "env-target" }),
  ).toBe(path.join(root, "env-target/debug"));
  write(
    config,
    'include = ["first.toml", "nested/second.toml"]\n[build]\ntarget-dir = "own-target"\n',
  );
  expect(rustDevCargoOutputDirectory(root, environment(root))).toBe(
    path.join(root, "own-target/debug"),
  );
  write(path.join(root, ".cargo/nested/second.toml"), 'include = ["../third.toml"]\n');
  write(config, 'include = ["first.toml", "nested/second.toml"]\n');
  expect(rustDevCargoOutputDirectory(root, environment(root))).toBe(
    path.join(root, "third-target/debug"),
  );
  write(path.join(root, ".cargo/third.toml"), 'include = ["config.toml"]\n');
  expect(() => rustDevCargoOutputDirectory(root, environment(root))).toThrow("include cycle");
});

test("bypasses shared bundles when PATH selects a custom native linker driver", async () => {
  useCache();
  const root = fixture();
  const cc = path.join(root, "bin/cc");
  write(cc, "#!/bin/sh\nexit 1\n");
  chmodSync(cc, 0o755);
  const custom = {
    ...environment(root),
    PATH: `${path.join(root, "bin")}${path.delimiter}/usr/bin:/bin`,
  };
  expect(
    usesSharedRustDevRuntime({
      projectRoot: root,
      environment: custom,
      platform: "darwin",
      architecture: "arm64",
    }),
  ).toBe(false);
  const build = buildAdapter();
  const result = await prepareRustDevRuntime({
    projectRoot: root,
    environment: custom,
    platform: "darwin",
    architecture: "arm64",
    run: build.run,
  });
  expect(result.outputRoot).toBe(path.join(root, "target/debug"));
  expect(build.builds()).toHaveLength(1);
  expect(build.builds()[0]!.environment.CARGO_ENCODED_RUSTFLAGS).toBeUndefined();
});

test("accepts the launcher's staged executable selection and rejects configured custom profiles", () => {
  const root = fixture();
  const context = {
    projectRoot: root,
    platform: "darwin",
    architecture: "arm64",
    environment: {
      ...environment(root),
      NODEX_CORE_EXECUTABLE: rustDevRuntimeExecutable(root, "nodex-core"),
    },
  } as const;
  expect(usesSharedRustDevRuntime(context)).toBe(true);
  expect(usesSharedRustDevRuntime({ ...context, platform: "linux" })).toBe(false);
  expect(usesSharedRustDevRuntime({ ...context, architecture: "x64" })).toBe(false);
  write(path.join(root, ".cargo/config.toml"), '[profile.dev]\ndebug = "full"\n');
  expect(usesSharedRustDevRuntime(context)).toBe(false);
});

test("reads escaped dependency paths without losing spaces or hash characters", () => {
  expect(
    parseRustDepInfo("/tmp/target/nodex: /tmp/source\\ tree/main.rs /tmp/policy\\#1.json\n\n"),
  ).toEqual(["/tmp/source tree/main.rs", "/tmp/policy#1.json"]);
});

test("rejects unknown CLI arguments before starting native preparation", () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(import.meta.resolve("tsx/cli")),
      fileURLToPath(new URL("./rust-dev-runtime.ts", import.meta.url)),
      "--unknown",
    ],
    { encoding: "utf8" },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Usage: rust-dev-runtime.ts");
});
