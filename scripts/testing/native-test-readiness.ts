import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { NativeExecutableId } from "../../config/test-suites.ts";
import { parseRustDepInfo, rustCargoConfigurationInputs } from "../rust-dev-runtime.ts";

type Context = { readonly repositoryRoot: string; readonly env?: NodeJS.ProcessEnv };

interface Preparation {
  readonly executable: string;
  readonly build: string;
  readonly inputs: string;
}

const recordPath = (root: string, artifact: NativeExecutableId) =>
  path.join(root, ".generated/native-test-artifacts", artifact + ".json");

const digest = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
const fileDigest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

function locallyOwned(root: string, file: string) {
  const relative = path.relative(root, file);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

export function nativeTestBuildIdentity({ repositoryRoot: root, env = process.env }: Context) {
  const overrides = Object.entries(env)
    .filter(
      ([name]) =>
        name === "PATH" ||
        (/^CARGO_(?:BUILD_|PROFILE_|TARGET_|HOME$|ENCODED_RUSTFLAGS$)/u.test(name) &&
          name !== "CARGO_BUILD_JOBS" &&
          name !== "CARGO_TARGET_TMPDIR") ||
        /^(?:RUST|CC(?:_|$)|CXX|AR(?:_|$)|CFLAGS|CPPFLAGS|LDFLAGS|LIB|INCLUDE|CL|LINK|SDKROOT|MACOSX_DEPLOYMENT_TARGET|DEVELOPER_DIR|PKG_CONFIG|SQLITE|VCPKG)/u.test(
          name,
        ),
    )
    .sort(([left], [right]) => left.localeCompare(right));
  try {
    return digest([
      execFileSync("rustc", ["--version", "--verbose"], { cwd: root, env, encoding: "utf8" }),
      execFileSync("cargo", ["--version"], { cwd: root, env, encoding: "utf8" }),
      overrides,
      rustCargoConfigurationInputs(root, env).map((file) => [file, fileDigest(file)]),
    ]);
  } catch {
    return undefined;
  }
}

function nativeInputs(root: string, executable: string, builtAfter = Infinity) {
  const canonical = realpathSync(executable);
  if (!locallyOwned(realpathSync(root), canonical)) return undefined;
  const binary = lstatSync(canonical, { bigint: true });
  const binaryName = path.basename(executable, ".exe");
  if (!binary.isFile() || (process.platform !== "win32" && !(binary.mode & 0o111n)))
    return undefined;
  const depInfo = path.join(path.dirname(executable), binaryName + ".d");
  const dependencies = parseRustDepInfo(readFileSync(depInfo, "utf8")).map((file) =>
    path.resolve(root, file),
  );
  if (!dependencies.length || dependencies.some((file) => !locallyOwned(root, file)))
    return undefined;
  const manifests = dependencies.flatMap((file) => {
    const [directory, pkg] = path.relative(root, file).split(path.sep);
    return directory === "crates" && pkg ? [path.join(root, directory, pkg, "Cargo.toml")] : [];
  });
  const inputs = [
    ...new Set([
      ...dependencies,
      ...manifests,
      ...["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"].map((file) => path.join(root, file)),
    ]),
  ].sort();
  const values = inputs.map((file) => {
    const before = lstatSync(file);
    if (!before.isFile() || before.ctimeMs >= builtAfter) return null;
    const hash = fileDigest(file);
    const after = lstatSync(file);
    return before.ino === after.ino && before.ctimeMs === after.ctimeMs ? [file, hash] : null;
  });
  if (values.includes(null)) return undefined;
  const after = lstatSync(canonical, { bigint: true });
  if (binary.ino !== after.ino || binary.ctimeNs !== after.ctimeNs) return undefined;
  return digest([
    root,
    canonical,
    String(binary.ino),
    String(binary.size),
    String(binary.ctimeNs),
    values,
  ]);
}

/** Bind the prepared binary to the Cargo dep-info and build context from its worktree. */
export function recordNativeTestPreparation(
  root: string,
  artifact: NativeExecutableId,
  executable: string,
  build: string,
  startedAt: number,
) {
  const file = recordPath(root, artifact);
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    const inputs = nativeInputs(root, executable, startedAt);
    if (!inputs) return;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(temporary, JSON.stringify({ executable, build, inputs } satisfies Preparation));
    renameSync(temporary, file);
  } catch {
    // The ordinary runner uses Cargo's executable even when it cannot record local readiness.
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function readPreparedNativeTests(
  context: Context,
  artifacts: readonly NativeExecutableId[],
  getBuildIdentity = nativeTestBuildIdentity,
) {
  const root = context.repositoryRoot;
  let build: string | undefined;
  const ready: Partial<Record<NativeExecutableId, string>> = {};
  for (const artifact of artifacts) {
    try {
      const receipt = JSON.parse(readFileSync(recordPath(root, artifact), "utf8")) as Preparation;
      build ??= getBuildIdentity(context);
      if (!build || build !== receipt.build || typeof receipt.inputs !== "string") continue;
      if (nativeInputs(root, receipt.executable) === receipt.inputs)
        ready[artifact] = receipt.executable;
    } catch {
      // Missing or changed preparation evidence leaves this test for CI.
    }
  }
  return ready;
}
