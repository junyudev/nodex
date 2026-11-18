import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { posix, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { sha256File } from "./native-runtime-manifest.ts";
import { replaceOwnedDirectory } from "./replace-owned-directory.ts";

const root = resolve(import.meta.dirname, "..");
const crate = "nodex-search-kernel";
const output = resolve(root, "crates", crate, "generated");
const expectedWasmBindgenVersion = "0.2.129";
const stamp = "integrity.sha256";
const outputFiles = [
  "nodex_search_kernel.js",
  "nodex_search_kernel.d.ts",
  "nodex_search_kernel_bg.wasm",
];

interface LockedPackage {
  name: string;
  version: string;
  source?: string;
  checksum?: string;
  dependencies?: string[];
  replace?: string;
}

const digest = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex");

// Resolve Cargo's abbreviated edges before erasing local package versions.
function findLockedPackages(): ReadonlyMap<LockedPackage, readonly LockedPackage[]> {
  const lock = parseToml(readFileSync(resolve(root, "Cargo.lock"), "utf8"));
  if (lock.version !== 4 || !Array.isArray(lock.package)) {
    throw new Error("Unsupported Cargo.lock format");
  }
  const packages = lock.package as unknown as LockedPackage[];
  const visited = new Map<LockedPackage, readonly LockedPackage[]>();
  const resolveReference = (reference: string): LockedPackage => {
    const [name, version, source] = reference.split(" ");
    const matches = packages.filter(
      (candidate) =>
        candidate.name === name &&
        (!version || candidate.version === version) &&
        (!source || `(${candidate.source?.split("#")[0]})` === source),
    );
    if (matches.length !== 1) throw new Error(`Cannot resolve Cargo.lock dependency ${reference}`);
    return matches[0];
  };

  const visit = (entry: LockedPackage) => {
    if (visited.has(entry)) return;
    const references = entry.replace ? [entry.replace] : (entry.dependencies ?? []);
    const targets = references.map(resolveReference);
    visited.set(entry, targets);
    for (const target of targets) visit(target);
  };

  const kernel = packages.find((entry) => entry.name === crate && !entry.source);
  if (!kernel) throw new Error(`Cargo.lock is missing ${crate}`);
  visit(kernel);
  return visited;
}

const lockedPackageKey = ({ name, source, version }: LockedPackage): string =>
  source === undefined ? name : `${name} ${version} (${source})`;

function workspaceManifestForWasm() {
  const manifest = parseToml(readFileSync(resolve(root, "Cargo.toml"), "utf8"));
  const workspace = manifest.workspace as { package?: { version?: string } } | undefined;
  // The local sources do not embed the inherited release version.
  if (workspace?.package) delete workspace.package.version;
  return manifest;
}

function sourceFiles(path: string): string[] {
  return readdirSync(resolve(root, path), { withFileTypes: true }).flatMap((entry) => {
    const child = posix.join(path, entry.name);
    if (entry.isDirectory()) return sourceFiles(child);
    if (entry.isFile()) return [child];
    throw new Error(`Unsupported WASM source entry ${child}`);
  });
}

const presentFiles = (files: readonly string[]): string[] =>
  files.filter((file) => lstatSync(resolve(root, file), { throwIfNoEntry: false }));

function inputDigest(): string {
  // Cargo.lock also includes optional and target-specific edges. Follow the entire
  // kernel closure so lock updates elsewhere in the workspace can stay independent.
  const packages = findLockedPackages();
  const localFiles = [...packages.keys()]
    .filter((entry) => !entry.source)
    .flatMap(({ name }) => {
      const cratePath = `crates/${name}`;
      return [
        `${cratePath}/Cargo.toml`,
        ...presentFiles([`${cratePath}/build.rs`]),
        ...sourceFiles(`${cratePath}/src`),
      ];
    });
  const files = [
    ...presentFiles([".cargo/config", ".cargo/config.toml"]),
    "rust-toolchain.toml",
    "scripts/build-search-kernel-wasm.ts",
    ...localFiles,
  ];
  const normalizedPackages = new Map(
    [...packages].map(([entry, targets]) => {
      const references = targets.map(lockedPackageKey).sort();
      return [
        lockedPackageKey(entry),
        {
          ...entry,
          version: entry.source === undefined ? undefined : entry.version,
          dependencies: entry.replace ? undefined : references,
          replace: entry.replace ? references[0] : undefined,
        },
      ] as const;
    }),
  );
  return digest({
    workspaceManifest: workspaceManifestForWasm(),
    packages: [...normalizedPackages.keys()].sort().map((key) => normalizedPackages.get(key)),
    files: files.sort().map((file) => [file, sha256File(resolve(root, file))]),
  });
}

function integrity(inputs: string, directory: string): string {
  return (
    digest({
      inputs,
      outputs: outputFiles.map((file) => [file, sha256File(resolve(directory, file))]),
    }) + "\n"
  );
}

function generate(): void {
  const wasmBindgenVersion = execFileSync("wasm-bindgen", ["--version"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (wasmBindgenVersion !== `wasm-bindgen ${expectedWasmBindgenVersion}`) {
    throw new Error(
      `wasm-bindgen ${expectedWasmBindgenVersion} is required; found ${wasmBindgenVersion}`,
    );
  }

  const inputs = inputDigest();
  execFileSync(
    "cargo",
    [
      "build",
      "--locked",
      "-p",
      crate,
      "--release",
      "--target",
      "wasm32-unknown-unknown",
      "--features",
      "wasm",
    ],
    { cwd: root, stdio: "inherit" },
  );

  const staging = mkdtempSync(resolve(root, "target/search-kernel-wasm-"));
  try {
    execFileSync(
      "wasm-bindgen",
      [
        resolve(root, "target/wasm32-unknown-unknown/release/nodex_search_kernel.wasm"),
        "--out-dir",
        staging,
        "--target",
        "web",
        "--typescript",
      ],
      { cwd: root, stdio: "inherit" },
    );

    const generatedJavaScript = resolve(staging, "nodex_search_kernel.js");
    const source = readFileSync(generatedJavaScript, "utf8");
    const defaultModule =
      /\n\s*if \(module_or_path === undefined\) \{\n\s*module_or_path = new URL\('nodex_search_kernel_bg\.wasm', import\.meta\.url\);\n\s*\}/;
    if (!defaultModule.test(source)) throw new Error("Unexpected wasm-bindgen module loader");
    writeFileSync(
      generatedJavaScript,
      `/* eslint-disable */\n${source.replace(defaultModule, "")}`,
    );
    rmSync(resolve(staging, "nodex_search_kernel_bg.wasm.d.ts"));

    if (inputs !== inputDigest())
      throw new Error("Search kernel WASM inputs changed during generation");
    writeFileSync(resolve(staging, stamp), integrity(inputs, staging));
    replaceOwnedDirectory(staging, output);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function verify(): void {
  try {
    if (readFileSync(resolve(output, stamp), "utf8") !== integrity(inputDigest(), output)) {
      throw new Error("input or output digest changed");
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `Search kernel WASM is stale (${detail}). Run vp run search-kernel:wasm:generate and commit the generated files.\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write("Search kernel WASM is up to date.\n");
}

const args = process.argv.slice(2);
if (args.length === 0) generate();
else if (args.length === 1 && args[0] === "--check") verify();
else throw new Error("Usage: build-search-kernel-wasm [--check]");
