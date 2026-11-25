import { spawnSync } from "node:child_process";
import path from "node:path";

interface CargoDependency {
  readonly name: string;
  readonly kind?: string | null;
}

interface CargoPackage {
  readonly dependencies: readonly CargoDependency[];
  readonly id: string;
  readonly manifest_path: string;
  readonly name: string;
}

export interface CargoMetadata {
  readonly packages: readonly CargoPackage[];
  readonly workspace_members: readonly string[];
}

const normalize = (value: string): string => value.replaceAll("\\", "/");

export const selectTouchedRustPackageNames = (
  metadata: CargoMetadata,
  repositoryRoot: string,
  changedPaths: readonly string[],
): readonly string[] => {
  const workspaceIds = new Set(metadata.workspace_members);
  const packages = metadata.packages.filter((candidate) => workspaceIds.has(candidate.id));
  const allNames = packages.map((candidate) => candidate.name).sort();
  if (
    changedPaths.some(
      (candidate) =>
        candidate === "Cargo.toml" ||
        candidate === "Cargo.lock" ||
        candidate === "rust-toolchain.toml",
    )
  )
    return allNames;

  const roots = packages
    .map((candidate) => ({
      name: candidate.name,
      root: normalize(path.relative(repositoryRoot, path.dirname(candidate.manifest_path))),
    }))
    .sort((left, right) => right.root.length - left.root.length);
  const directlyAffected = new Set<string>();
  for (const changedPath of changedPaths.filter((candidate) => candidate.startsWith("crates/"))) {
    const owner = roots.find(
      ({ root }) => changedPath === root || changedPath.startsWith(`${root}/`),
    );
    if (!owner) return allNames;
    directlyAffected.add(owner.name);
  }
  return [...directlyAffected].sort();
};

export function selectAffectedRustPackageNames(
  metadata: CargoMetadata,
  repositoryRoot: string,
  changedPaths: readonly string[],
): readonly string[] {
  const affected = new Set(selectTouchedRustPackageNames(metadata, repositoryRoot, changedPaths));
  const packages = metadata.packages.filter(({ id }) => metadata.workspace_members.includes(id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of packages) {
      if (affected.has(candidate.name)) continue;
      if (!candidate.dependencies.some((dependency) => affected.has(dependency.name))) continue;
      affected.add(candidate.name);
      changed = true;
    }
  }
  return [...affected].sort();
}

const run = (
  command: string,
  args: readonly string[],
  cwd: string,
  captureOutput = false,
): string => {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: captureOutput ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status}.`);
  return captureOutput ? result.stdout : "";
};

/**
 * Integration tests that start another workspace binary need it built even when its package is
 * not affected: the CLI's data tests start Core.
 */
const TEST_BINARY_PREREQUISITES: Readonly<
  Record<string, { readonly package: string; readonly bin: string }>
> = {
  "nodex-cli": { package: "nodex-core-server", bin: "nodex-core" },
};

export function selectRustTestBinaryPrerequisites(
  packages: readonly string[],
): readonly { readonly package: string; readonly bin: string }[] {
  return packages.flatMap((name) => {
    const prerequisite = TEST_BINARY_PREREQUISITES[name];
    return prerequisite && !packages.includes(prerequisite.package) ? [prerequisite] : [];
  });
}

const packageArguments = (packages: readonly string[]): readonly string[] =>
  packages.flatMap((packageName) => ["--package", packageName]);

const main = (): void => {
  const cwd = path.resolve(import.meta.dirname, "../..");
  const kindIndex = process.argv.indexOf("--kind");
  const kind = kindIndex < 0 ? undefined : process.argv[kindIndex + 1];
  if (kind !== "clippy" && kind !== "tests") {
    throw new Error("Usage: run-affected-rust --kind <clippy|tests>.");
  }
  const rawPaths = process.env.CI_CHANGED_PATHS_JSON ?? "[]";
  const parsed: unknown = JSON.parse(rawPaths);
  if (!Array.isArray(parsed) || !parsed.every((candidate) => typeof candidate === "string")) {
    throw new Error("CI_CHANGED_PATHS_JSON must contain a string array.");
  }
  const metadata = JSON.parse(
    run("cargo", ["metadata", "--format-version", "1", "--no-deps"], cwd, true),
  ) as CargoMetadata;
  const packages =
    process.env.CI_RUST_FULL === "true"
      ? metadata.packages
          .filter((candidate) => metadata.workspace_members.includes(candidate.id))
          .map((candidate) => candidate.name)
          .sort()
      : selectAffectedRustPackageNames(metadata, cwd, parsed);
  if (packages.length === 0)
    throw new Error("Rust lanes were selected without an affected workspace package.");
  const selected = packageArguments(packages);

  if (kind === "clippy") {
    run(
      "cargo",
      ["clippy", "--all-targets", "--all-features", ...selected, "--", "-D", "warnings"],
      cwd,
    );
    return;
  }
  for (const prerequisite of selectRustTestBinaryPrerequisites(packages))
    run(
      "cargo",
      ["build", "--all-features", "--package", prerequisite.package, "--bin", prerequisite.bin],
      cwd,
    );
  run("cargo", ["nextest", "run", "--all-features", "--profile", "ci", ...selected], cwd);
  run("cargo", ["test", "--doc", "--all-features", ...selected], cwd);
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
