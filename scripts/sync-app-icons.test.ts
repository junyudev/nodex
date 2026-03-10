import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(scriptDir, "..");
const iconComposerDir = join(projectRoot, "resources", "icon.icon");

function readDirectorySnapshot(directoryPath: string): string {
  const entries = readdirSync(directoryPath).sort();
  const snapshotParts: string[] = [];

  for (const entry of entries) {
    const absolutePath = join(directoryPath, entry);
    const entryStats = statSync(absolutePath);

    if (entryStats.isDirectory()) {
      snapshotParts.push(readDirectorySnapshot(absolutePath));
      continue;
    }

    snapshotParts.push(`${relative(iconComposerDir, absolutePath)}\n${readFileSync(absolutePath, "utf8")}`);
  }

  return snapshotParts.join("\n---\n");
}

test("sync-app-icons preserves the checked-in Icon Composer package", () => {
  const before = readDirectorySnapshot(iconComposerDir);

  execFileSync("bun", ["run", "scripts/sync-app-icons.ts"], {
    cwd: projectRoot,
    stdio: "pipe",
  });

  const after = readDirectorySnapshot(iconComposerDir);

  expect(after).toBe(before);
});
