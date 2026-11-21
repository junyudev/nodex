import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Count physical installed files, including ASAR as one file, without following links. */
export function installedPayloadInventory(root, { skipSymlinks = false } = {}) {
  const files = [];
  const visit = (segments) => {
    const file = join(root, ...segments);
    const stat = lstatSync(file);
    if (skipSymlinks && stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of readdirSync(file).sort()) visit([...segments, name]);
      return;
    }
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`Installed payload must contain regular files: ${file}`);
    files.push({ path: segments.join("/"), size: stat.size });
  };
  visit([]);
  return {
    bytes: files.reduce((total, file) => total + file.size, 0),
    fileCount: files.length,
    files,
  };
}

// The 1.48 GB baseline loses 92.6 MB for Document Tools and 323.7 MB for
// Claude Code. Keep roughly 8% headroom over the resulting 1.064 GB.
const macInstalledByteBudget = 1_150_000_000;

export function assertMacDocumentToolsDetached(resourcesPath) {
  if (lstatSync(join(resourcesPath, "workspace-runtime"), { throwIfNoEntry: false }))
    throw new Error("Packaged macOS app must not contain Resources/workspace-runtime");
}

export function assertMacInstalledPayloadBudget(appPath) {
  // Framework bundles contain symbolic links to their versioned files.
  const inventory = installedPayloadInventory(appPath, { skipSymlinks: true });
  if (inventory.bytes > macInstalledByteBudget)
    throw new Error(
      `Installed macOS app exceeds its ${macInstalledByteBudget}-byte budget: ${inventory.bytes} bytes`,
    );
  return inventory;
}
