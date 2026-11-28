/* @effect-diagnostics asyncFunction:off -- Node filesystem adapter for Desktop Tools staging. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  BROWSER_RUNTIME_MANIFEST_FILENAME,
  parseBrowserRuntimeManifest,
} from "../../../shared/browser-runtime-metadata";
import { contentFingerprint } from "./content-identity";
import { inventoryRegularFiles, sha256File } from "./pinned-tar-archive";

/** Check the sealed Windows payload before publishing it. Activation also checks native trust. */
export async function stageWindowsBrowserRuntime(
  payloadRoot: string,
  manifestSha256: string,
  signal: AbortSignal,
): Promise<number> {
  const bytes = await readFile(path.join(payloadRoot, BROWSER_RUNTIME_MANIFEST_FILENAME), {
    signal,
  });
  if (contentFingerprint(bytes) !== manifestSha256) {
    throw new Error("Desktop Tools manifest does not match its release lock.");
  }
  const manifest = parseBrowserRuntimeManifest(JSON.parse(bytes.toString("utf8")));
  if (manifest?.targetPlatform !== "win32") {
    throw new Error("Desktop Tools manifest is not for Windows.");
  }
  const files = await inventoryRegularFiles(payloadRoot, signal, [
    BROWSER_RUNTIME_MANIFEST_FILENAME,
    ...manifest.artifacts.map(({ path }) => path),
  ]);
  if (files.size !== manifest.artifacts.length + 1) {
    throw new Error("Desktop Tools must contain exactly the manifest-declared files.");
  }
  let size = bytes.byteLength;
  for (const artifact of manifest.artifacts) {
    signal.throwIfAborted();
    if (
      files.get(artifact.path)?.size !== artifact.size ||
      (await sha256File(path.join(payloadRoot, artifact.path), signal)) !== artifact.sha256
    ) {
      throw new Error("A Desktop Tools file does not match its manifest.");
    }
    size += artifact.size;
  }
  return size;
}
