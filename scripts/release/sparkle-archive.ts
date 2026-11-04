import { execFileSync } from "node:child_process";
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync } from "node:fs";
import path from "node:path";

export const sparkleFullArchiveName = (version: string, architecture: string): string =>
  `Nodex-${version}-${architecture}.tar.xz`;

/** ZIP is read only for immutable release history. New full updates always use tar.xz. */
export const isSparkleHistoryArchiveName = (
  name: string,
  version: string,
  architecture: string,
): boolean =>
  name === sparkleFullArchiveName(version, architecture) ||
  name === `Nodex-${version}-${architecture}.zip`;

export function createSparkleArchive(appPath: string, archivePath: string): void {
  const app = path.resolve(appPath);
  const archive = path.resolve(archivePath);
  if (!archive.endsWith(".tar.xz")) throw new Error("Full updates must use tar.xz.");
  if (!app.endsWith(".app") || !lstatSync(app).isDirectory()) {
    throw new Error("Full update source must be an app directory.");
  }
  const entries: string[] = [];
  const visit = (relative: string): void => {
    entries.push(relative);
    const absolute = path.join(path.dirname(app), relative);
    if (!lstatSync(absolute).isDirectory()) return;
    for (const name of readdirSync(absolute).sort()) {
      if (!name.startsWith("._")) visit(path.join(relative, name));
    }
  };
  visit(path.basename(app));
  // Three workers fit the hosted Apple silicon runner. Bound memory without
  // silently reducing preset 9; do not inherit machine-wide xz tuning.
  execFileSync(
    "/bin/bash",
    [
      "-o",
      "pipefail",
      "-c",
      '/usr/bin/tar -cf - --no-recursion --null -T - | xz -9 -T3 --memlimit-compress=4GiB --no-adjust > "$1"',
      "nodex-full-update",
      archive,
    ],
    {
      cwd: path.dirname(app),
      env: { ...process.env, COPYFILE_DISABLE: "1", XZ_DEFAULTS: "", XZ_OPT: "" },
      input: Buffer.from(`${entries.join("\0")}\0`),
      stdio: ["pipe", "ignore", "inherit"],
    },
  );
}

/** Match Sparkle 2.9.4's piped unarchiver, including its auto-detecting -z flag. */
export function extractSparkleArchive(archivePath: string, outputDirectory: string): string {
  const command = archivePath.endsWith(".tar.xz")
    ? ["/usr/bin/tar", "-zxC", outputDirectory]
    : archivePath.endsWith(".zip")
      ? ["/usr/bin/ditto", "-x", "-k", "-", outputDirectory]
      : null;
  if (!command) throw new Error(`Unsupported Sparkle archive: ${archivePath}`);
  mkdirSync(outputDirectory, { recursive: true });
  const input = openSync(archivePath, "r");
  try {
    execFileSync(command[0], command.slice(1), { stdio: [input, "ignore", "inherit"] });
  } finally {
    closeSync(input);
  }
  const apps = readdirSync(outputDirectory, { withFileTypes: true }).filter(
    (entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.endsWith(".app"),
  );
  if (apps.length !== 1) throw new Error(`Expected exactly one app in ${outputDirectory}.`);
  return path.join(outputDirectory, apps[0].name);
}
