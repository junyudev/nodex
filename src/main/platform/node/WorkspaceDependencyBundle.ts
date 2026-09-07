/* oxlint-disable effecttsgo/async-function -- Bundled dependency verification owns filesystem streaming at the Node boundary. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  WORKSPACE_RUNTIME_MANIFEST,
  workspaceRuntimeManifestSchema,
  type WorkspaceDependencies,
} from "../../../shared/workspace-dependency-runtime";

export interface WorkspaceDependencyBundleInput {
  readonly root: string;
  readonly platform: string;
  readonly arch: string;
  readonly node: { readonly executable: string; readonly version: string } | null;
}

// Filesystem streaming and its Promise lifecycle stay at this Node boundary.
export async function readWorkspaceDependencyBundle(
  input: WorkspaceDependencyBundleInput,
): Promise<WorkspaceDependencies> {
  if (!input.node) return { status: "unavailable", reason: "node_unavailable" };
  if (!path.isAbsolute(input.root)) return { status: "unavailable", reason: "invalid_bundle" };
  const rootPath = path.resolve(input.root);
  const manifestPath = path.join(rootPath, WORKSPACE_RUNTIME_MANIFEST);
  let raw: string;
  try {
    const stats = await lstat(manifestPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 8 * 1024 * 1024)
      return { status: "unavailable", reason: "invalid_bundle" };
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    return {
      status: "unavailable",
      reason:
        error instanceof Error && "code" in error && error.code === "ENOENT"
          ? "not_installed"
          : "invalid_bundle",
    };
  }
  try {
    const root = await lstat(rootPath);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("Invalid runtime root");
    const manifest = workspaceRuntimeManifestSchema.parse(JSON.parse(raw));
    if (manifest.targetArch !== input.arch || manifest.targetPlatform !== input.platform)
      throw new Error("Runtime target mismatch");
    const paths = new Set<string>();
    const directories = new Set<string>();
    for (const artifact of manifest.artifacts) {
      if (paths.has(artifact.path)) throw new Error("Duplicate runtime artifact");
      paths.add(artifact.path);
      const absolute = path.join(rootPath, artifact.path);
      let parent = path.dirname(absolute);
      while (parent !== rootPath && !directories.has(parent)) {
        const stats = await lstat(parent);
        if (!stats.isDirectory() || stats.isSymbolicLink())
          throw new Error("Invalid runtime directory");
        directories.add(parent);
        parent = path.dirname(parent);
      }
      const stats = await lstat(absolute);
      if (
        !stats.isFile() ||
        stats.isSymbolicLink() ||
        stats.size !== artifact.size ||
        (artifact.executable && (stats.mode & 0o111) === 0)
      )
        throw new Error("Invalid runtime artifact");
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(absolute)) hash.update(chunk);
      if (hash.digest("hex") !== artifact.sha256) throw new Error("Runtime integrity mismatch");
    }
    if (
      !paths.has(manifest.pythonExecutable) ||
      !manifest.artifacts.some(
        (artifact) => artifact.path === manifest.pythonExecutable && artifact.executable,
      ) ||
      !manifest.artifacts.some((artifact) =>
        artifact.path.startsWith(`${manifest.pythonSitePackages}/`),
      )
    )
      throw new Error("Incomplete runtime entrypoints");
    return {
      status: "available",
      distributionId: manifest.distributionId,
      node: input.node,
      python: {
        executable: path.join(rootPath, manifest.pythonExecutable),
        version: manifest.pythonVersion,
        recommendedArgs: ["-I", "-B"],
        sitePackages: path.join(rootPath, manifest.pythonSitePackages),
      },
      libraries: manifest.libraries,
    };
  } catch {
    return { status: "unavailable", reason: "invalid_bundle" };
  }
}
