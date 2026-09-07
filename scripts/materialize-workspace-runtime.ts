import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  WORKSPACE_RUNTIME_MANIFEST,
  workspaceRuntimeManifestSchema,
} from "../src/shared/workspace-dependency-runtime";
import { readWorkspaceDependencyBundle } from "../src/main/platform/node/WorkspaceDependencyBundle";
import { ensureImmutableArtifact, resolveImmutableArtifactPath } from "./immutable-artifact-cache";
import { replaceOwnedDirectory } from "./replace-owned-directory";

const assetSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9_.+-]+$/u),
  url: z.url().refine((url) => new URL(url).protocol === "https:"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  size: z.number().int().positive(),
});
const targetSchema = z.strictObject({
  python: assetSchema,
  wheels: z.array(assetSchema.extend({ package: z.string(), version: z.string() })).min(1),
});
export const workspaceRuntimeLockSchema = z.strictObject({
  schemaVersion: z.literal(1),
  distributionId: z.string(),
  pythonVersion: z.string().regex(/^3\.13\.\d+$/u),
  pythonRelease: z.string(),
  targets: z.strictObject({ arm64: targetSchema, x64: targetSchema }),
});
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const contained = (root: string, target: string) => {
  const child = path.relative(root, target);
  return child !== ".." && !child.startsWith(`..${path.sep}`) && !path.isAbsolute(child);
};

/** Validate names before extraction; verified archives may only populate their staging directory. */
export function validateWorkspaceArchiveEntries(entries: readonly string[]): void {
  for (const entry of entries) {
    const segments = entry.replace(/\/$/u, "").split("/");
    if (
      entry.startsWith("/") ||
      entry.includes("\\") ||
      entry.includes("\0") ||
      segments.some((segment) => !segment || segment === "." || segment === "..")
    )
      throw new Error(`Invalid workspace archive path: ${entry}`);
  }
}

function unpack(archive: string, directory: string): void {
  const entries = execFileSync("tar", ["-tf", archive], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
    .trim()
    .split("\n");
  validateWorkspaceArchiveEntries(entries);
  mkdirSync(directory, { recursive: true });
  execFileSync("tar", ["-xf", archive, "-C", directory]);
}

function verifySourceLinks(root: string, directory = root): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      if (!contained(root, realpathSync(entryPath)) || !statSync(entryPath).isFile())
        throw new Error(`Invalid runtime link: ${entryPath}`);
      continue;
    }
    if (entry.isDirectory()) {
      verifySourceLinks(root, entryPath);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Unsupported runtime entry: ${entryPath}`);
  }
}

function copyRuntimeDirectory(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyRuntimeDirectory(from, to);
      continue;
    }
    copyFileSync(from, to);
    chmodSync(to, statSync(from).mode & 0o777);
  }
}

export function collectWorkspaceRuntimeArtifacts(
  root: string,
  directory = root,
): z.infer<typeof workspaceRuntimeManifestSchema>["artifacts"] {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectWorkspaceRuntimeArtifacts(root, absolute);
      if (!entry.isFile()) throw new Error(`Unsupported staged runtime artifact: ${absolute}`);
      const stats = lstatSync(absolute);
      return [
        {
          path: path.relative(root, absolute).split(path.sep).join("/"),
          size: stats.size,
          sha256: digest(absolute),
          executable: (stats.mode & 0o111) !== 0,
        },
      ];
    });
}

export async function materializeWorkspaceRuntime(options: {
  readonly targetArch: "arm64" | "x64";
  readonly outputPath: string;
  readonly projectRoot?: string;
  readonly lockPath?: string;
}): Promise<void> {
  const repository = options.projectRoot ?? projectRoot;
  const lockPath =
    options.lockPath ??
    path.join(repository, "resources/workspace-runtime/workspace-runtime.lock.json");
  const lock = workspaceRuntimeLockSchema.parse(JSON.parse(readFileSync(lockPath, "utf8")));
  const sourceLockSha256 = digest(lockPath);
  const output = path.resolve(options.outputPath);
  const existing = await readWorkspaceDependencyBundle({
    root: output,
    platform: "darwin",
    arch: options.targetArch,
    node: { executable: "staging", version: "staging" },
  });
  if (
    existing.status === "available" &&
    existing.distributionId === lock.distributionId &&
    JSON.parse(readFileSync(path.join(output, WORKSPACE_RUNTIME_MANIFEST), "utf8"))
      .sourceLockSha256 === sourceLockSha256
  )
    return;
  const target = lock.targets[options.targetArch];
  const download = async (asset: z.infer<typeof assetSchema>) => {
    const destinationPath = resolveImmutableArtifactPath({
      family: "workspace-runtime",
      projectRoot: repository,
      assetName: asset.name,
      archiveSha256: asset.sha256,
    });
    await ensureImmutableArtifact({
      destinationPath,
      expectedSize: asset.size,
      url: asset.url,
      label: asset.name,
      validate: (file) => {
        if (lstatSync(file).size !== asset.size || digest(file) !== asset.sha256)
          throw new Error(`Workspace dependency checksum mismatch: ${asset.name}`);
      },
    });
    return destinationPath;
  };
  const pythonArchive = await download(target.python);
  const wheels: string[] = [];
  for (const wheel of target.wheels) wheels.push(await download(wheel));
  mkdirSync(path.dirname(output), { recursive: true });
  const staging = mkdtempSync(path.join(path.dirname(output), ".workspace-runtime-"));
  try {
    const source = path.join(staging, "source");
    const bundle = path.join(staging, "bundle");
    unpack(pythonArchive, source);
    verifySourceLinks(source);
    copyRuntimeDirectory(source, bundle);
    const sitePackages = "python/lib/python3.13/site-packages";
    for (const wheel of wheels) unpack(wheel, path.join(bundle, sitePackages));
    cpSync(
      path.join(repository, "resources/workspace-runtime/python-licenses"),
      path.join(bundle, "licenses/python"),
      { recursive: true },
    );
    const manifest = workspaceRuntimeManifestSchema.parse({
      schemaVersion: 1,
      targetPlatform: "darwin",
      targetArch: options.targetArch,
      distributionId: lock.distributionId,
      sourceLockSha256,
      pythonVersion: lock.pythonVersion,
      pythonExecutable: "python/bin/python3.13",
      pythonSitePackages: sitePackages,
      libraries: target.wheels.map((wheel) => ({ name: wheel.package, version: wheel.version })),
      artifacts: collectWorkspaceRuntimeArtifacts(bundle),
    });
    writeFileSync(
      path.join(bundle, WORKSPACE_RUNTIME_MANIFEST),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    replaceOwnedDirectory(bundle, output);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arch = args[args.indexOf("--target-arch") + 1];
  if (arch !== "arm64" && arch !== "x64") throw new Error("Use --target-arch arm64|x64");
  const outputIndex = args.indexOf("--out");
  const outputPath =
    outputIndex >= 0
      ? args[outputIndex + 1]
      : path.join(projectRoot, ".generated/workspace-runtime", arch);
  if (!outputPath) throw new Error("Missing --out directory");
  await materializeWorkspaceRuntime({ targetArch: arch, outputPath });
  if (!existsSync(path.join(outputPath, WORKSPACE_RUNTIME_MANIFEST)))
    throw new Error("Missing staged runtime");
  console.log(`Workspace dependencies staged for darwin-${arch}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
