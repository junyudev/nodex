/* @effect-diagnostics asyncFunction:off -- Node filesystem adapter for Desktop Tools staging. */
import { chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  BROWSER_RUNTIME_MANIFEST_FILENAME,
  parseBrowserRuntimeManifest,
} from "../../../shared/browser-runtime-metadata";
import { contentFingerprint } from "./content-identity";
import { inventoryRegularFiles, sha256File } from "./pinned-tar-archive";

/** Verify the exact macOS closure and normalize modes without modifying any signed files. */
export async function stageMacBrowserRuntime(
  root: string,
  manifestSha256: string,
  signal: AbortSignal,
): Promise<number> {
  const manifestPath = path.join(root, BROWSER_RUNTIME_MANIFEST_FILENAME);
  const bytes = await readFile(manifestPath, { signal });
  if (contentFingerprint(bytes) !== manifestSha256) {
    throw new Error("Desktop Tools manifest does not match its release lock.");
  }
  const manifest = parseBrowserRuntimeManifest(JSON.parse(bytes.toString("utf8")));
  if (manifest?.targetPlatform !== "darwin" || manifest.targetArch !== "arm64") {
    throw new Error("Desktop Tools manifest does not match this Mac.");
  }
  const files = await inventoryRegularFiles(root, signal);
  if (files.size !== manifest.artifacts.length + 1) {
    throw new Error("Desktop Tools must contain exactly the manifest-declared files.");
  }
  let size = bytes.byteLength;
  for (const artifact of manifest.artifacts) {
    signal.throwIfAborted();
    const entry = files.get(artifact.path);
    const file = path.join(root, artifact.path);
    if (
      entry?.size !== artifact.size ||
      (artifact.executable && (entry.mode & 0o111) === 0) ||
      (await sha256File(file, signal)) !== artifact.sha256
    ) {
      throw new Error("A Desktop Tools file does not match its manifest.");
    }
    await chmod(file, artifact.executable ? 0o755 : 0o644);
    size += entry.size;
  }
  const modules = new Set([
    ...manifest.browserPlugin.nodeModuleDirs,
    ...(manifest.capabilities.computerUse.status === "available"
      ? manifest.capabilities.computerUse.plugin.nodeModuleDirs
      : []),
  ]);
  for (const directory of modules) await mkdir(path.join(root, directory), { recursive: true });
  await chmod(manifestPath, 0o644);
  return size;
}
