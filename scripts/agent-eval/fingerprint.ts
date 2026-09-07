import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Stable file-content identity, including nested Skill references and relative filenames. */
export async function directoryFingerprint(directory: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (relative: string): Promise<void> => {
    const entries = await readdir(path.join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const name = path.join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Fingerprint input cannot be a symlink: ${name}`);
      if (entry.isDirectory()) {
        await visit(name);
        continue;
      }
      hash
        .update(name)
        .update("\0")
        .update(await readFile(path.join(directory, name)))
        .update("\0");
    }
  };
  await visit("");
  return hash.digest("hex");
}
