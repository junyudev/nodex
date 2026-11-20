/* @effect-diagnostics asyncFunction:off -- Workspace dependency verification owns filesystem streaming at the Node boundary. */
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  WORKSPACE_RUNTIME_MANIFEST,
  workspaceRuntimeManifestSchema,
  type WorkspaceDependencies,
} from "../../../shared/workspace-dependency-runtime";
import { inventoryRegularFiles, sha256File } from "./pinned-tar-archive";

export interface WorkspaceDependencyBundleInput {
  readonly root: string;
  readonly platform: string;
  readonly arch: string;
  readonly node: { readonly executable: string; readonly version: string } | null;
}

export interface WorkspaceBundleVerification {
  readonly manifestSha256?: string;
  readonly installedComponent?: boolean;
  readonly signal?: AbortSignal;
}

/** Verify the complete closure before it can be published or used as an executable runtime. */
export async function verifyWorkspaceDependencyBundle(
  input: Pick<WorkspaceDependencyBundleInput, "root" | "platform" | "arch">,
  options: WorkspaceBundleVerification = {},
) {
  const { root } = input;
  if (!path.isAbsolute(root)) throw new Error("Workspace runtime root must be absolute");
  if (!(await lstat(root)).isDirectory()) throw new Error("Invalid workspace runtime root");
  const manifestPath = path.join(root, WORKSPACE_RUNTIME_MANIFEST);
  const stats = await lstat(manifestPath);
  if (!stats.isFile() || stats.size > 8 * 1024 * 1024)
    throw new Error("Invalid workspace runtime manifest");
  const raw = await readFile(manifestPath, { signal: options.signal });
  if (
    options.manifestSha256 &&
    createHash("sha256").update(raw).digest("hex") !== options.manifestSha256
  )
    throw new Error("Workspace runtime manifest digest mismatch");
  const manifest = workspaceRuntimeManifestSchema.parse(JSON.parse(raw.toString("utf8")));
  if (manifest.targetArch !== input.arch || manifest.targetPlatform !== input.platform)
    throw new Error("Workspace runtime target mismatch");

  const files = await inventoryRegularFiles(root, options.signal);
  files.delete(WORKSPACE_RUNTIME_MANIFEST);
  let unpackedBytes = raw.byteLength;
  for (const artifact of manifest.artifacts) {
    const file = files.get(artifact.path);
    if (
      !file ||
      file.size !== artifact.size ||
      (process.platform !== "win32" &&
        (((file.mode & 0o111) !== 0) !== artifact.executable ||
          (options.manifestSha256 !== undefined && (file.mode & 0o7022) !== 0)))
    )
      throw new Error(`Invalid workspace runtime artifact: ${artifact.path}`);
    files.delete(artifact.path);
    unpackedBytes += file.size;
    const actual = await sha256File(path.join(root, artifact.path), options.signal);
    if (actual !== artifact.sha256)
      throw new Error(`Workspace runtime integrity mismatch: ${artifact.path}`);
  }
  // The Component store writes its size receipt after verifying the archive.
  if (options.installedComponent) {
    const receiptName = ".installed-size";
    const receipt = files.get(receiptName);
    if (
      receipt?.size !== 8 ||
      (
        await readFile(path.join(root, receiptName), { signal: options.signal })
      ).readBigUInt64LE() !== BigInt(unpackedBytes + 8)
    )
      throw new Error("Invalid Document Tools installation receipt");
    files.delete(receiptName);
  }
  if (files.size !== 0) throw new Error("Workspace runtime contains undeclared files");
  if (
    !manifest.artifacts.some(
      (file) => file.path === manifest.pythonExecutable && file.executable,
    ) ||
    !manifest.artifacts.some((file) => file.path.startsWith(`${manifest.pythonSitePackages}/`))
  )
    throw new Error("Incomplete workspace runtime entrypoints");
  return { manifest, unpackedBytes };
}

export async function readWorkspaceDependencyBundle(
  input: WorkspaceDependencyBundleInput,
  options: WorkspaceBundleVerification = {},
): Promise<WorkspaceDependencies> {
  if (!input.node) return { status: "unavailable", reason: "node_unavailable" };
  try {
    const { manifest } = await verifyWorkspaceDependencyBundle(input, options);
    return {
      status: "available",
      distributionId: manifest.distributionId,
      node: input.node,
      python: {
        executable: path.join(input.root, manifest.pythonExecutable),
        version: manifest.pythonVersion,
        recommendedArgs: ["-I", "-B"],
        sitePackages: path.join(input.root, manifest.pythonSitePackages),
      },
      libraries: manifest.libraries,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT" &&
      "path" in error &&
      (error.path === input.root ||
        error.path === path.join(input.root, WORKSPACE_RUNTIME_MANIFEST))
    )
      return { status: "unavailable", reason: "not_installed" };
    return { status: "unavailable", reason: "invalid_bundle" };
  }
}
