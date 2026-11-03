import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Count physical installed files, including ASAR as one file, without following links. */
export function installedPayloadInventory(root) {
  const files = [];
  const visit = (segments) => {
    const file = join(root, ...segments);
    const stat = lstatSync(file);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
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
