/* @effect-diagnostics asyncFunction:off -- Node filesystem adapter for seeding a private Component stage. */
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import release from "../../../../resources/agent-runtime/codex-app-server.lock.json";

export type CodexSeedSearch = {
  readonly home: string;
  readonly searchPath: string;
  readonly isolated?: boolean;
};

export async function* codexSeedRoots(
  { home, searchPath, isolated }: CodexSeedSearch,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const commands = [
    ...[...new Set(searchPath.split(path.delimiter).filter(path.isAbsolute))]
      .slice(0, 48)
      .map((directory) => path.join(directory, "codex")),
    path.join(home, ".local/bin/codex"),
    path.join(home, ".codex/packages/standalone/current/bin/codex"),
    path.join(
      home,
      ".codex/packages/standalone/releases",
      `${release.appServerRuntimeVersion}-${release.builds["darwin-arm64"].targetTriple}`,
      "bin/codex",
    ),
    ...(isolated ? [] : ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]),
    ...(isolated ? [home] : [home, "/"]).map((prefix) =>
      path.join(prefix, "Applications/Nodex.app/Contents/Resources/bin/codex"),
    ),
  ];
  const seen = new Set<string>();
  for (const command of new Set(commands)) {
    signal.throwIfAborted();
    const resolved = await realpath(command).catch(() => null);
    if (!resolved || path.basename(resolved) !== "codex") continue;
    const bin = path.dirname(resolved);
    if (path.basename(bin) !== "bin") continue;
    const root = path.dirname(bin);
    if (seen.has(root)) continue;
    seen.add(root);
    yield root;
  }
}

/** Copy only the locked closure. The normal stage verifier authenticates these private copies. */
export async function copyCodexSeed(
  source: string,
  staging: string,
  sizes: Readonly<Record<string, number>>,
  signal: AbortSignal,
): Promise<boolean> {
  const directories = new Set([source]);
  for (const [relative, size] of Object.entries(sizes)) {
    signal.throwIfAborted();
    let directory = source;
    for (const segment of relative.split("/").slice(0, -1)) {
      directory = path.join(directory, segment);
      if (directories.has(directory)) continue;
      if (!(await lstat(directory)).isDirectory()) return false;
      directories.add(directory);
    }
    const info = await lstat(path.join(source, relative));
    if (!info.isFile() || info.size !== size) return false;
  }
  for (const [relative, size] of Object.entries(sizes)) {
    signal.throwIfAborted();
    const destination = path.join(staging, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    // FICLONE falls back to an independent regular copy on filesystems without clone support.
    await copyFile(path.join(source, relative), destination, constants.COPYFILE_FICLONE);
    if ((await lstat(destination)).size !== size) return false;
  }
  return true;
}
