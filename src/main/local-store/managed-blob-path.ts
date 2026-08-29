import { lstatSync } from "node:fs";
import path from "node:path";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const regularFilePath = (candidate: string): string | null => {
  try {
    const metadata = lstatSync(candidate);
    if (metadata.isSymbolicLink() || !metadata.isFile()) return null;
    return candidate;
  } catch {
    return null;
  }
};

/** Resolves a verified content hash without exposing arbitrary Profile paths. */
export function resolveManagedBlobPath(profileHome: string, contentHash: string): string | null {
  if (!SHA256_PATTERN.test(contentHash)) return null;

  const assetsRoot = path.join(profileHome, "assets");
  const current = regularFilePath(path.join(assetsRoot, `${contentHash}.blob`));
  if (current) return current;

  // Profiles created before the content-addressed filename was simplified may
  // retain reachable blobs under the former physical name.
  return regularFilePath(path.join(assetsRoot, `page-file-${contentHash}.blob`));
}
