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

// Removing 427,579,882 bytes of Codex from the 1,065,875,219-byte signed app
// leaves a 638,295,337-byte baseline. Keep roughly 8% headroom.
const macInstalledByteBudget = 690_000_000;

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
