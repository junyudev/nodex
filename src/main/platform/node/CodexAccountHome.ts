import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// State directories include the native writer locks: two accounts cannot become
// independent writers of the same session merely because their credentials differ.
const SHARED_DIRECTORIES = [
  "sessions",
  "archived_sessions",
  "thread-writer-locks",
  "shell_snapshots",
  "worktrees",
  "skills",
  "plugins",
  "cache",
  "agents",
  "attachments",
  "automations",
  "node_repl",
  "rules",
  "prompts",
  "marketplaces",
  "memories",
  "memories-v2",
] as const;
const SHARED_FILES = [
  "config.toml",
  "managed_config.toml",
  "requirements.toml",
  "hooks.json",
  "history.jsonl",
  "AGENTS.md",
] as const;
const MAX_AUTH_FILE_BYTES = 1024 * 1024;
const MAX_HOME_ENTRIES = 1024;

export interface CodexAccountHome {
  readonly mode: "direct" | "overlay";
  readonly sharedHome: string;
  readonly effectiveHome: string;
  readonly directoryIdentity: { readonly device: number; readonly inode: number } | null;
  readonly sharedDirectoryIdentity: { readonly device: number; readonly inode: number } | null;
  readonly sharedEntryNames: readonly string[];
}

function statIfPresent(file: string): Stats | null {
  try {
    return lstatSync(file);
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT")
      return null;
    throw cause;
  }
}

function canonicalDirectory(directory: string): string {
  if (!isAbsolute(directory)) throw new Error("Codex account directories must be absolute paths.");
  const entry = statIfPresent(directory);
  if (entry === null) {
    const suffix: string[] = [];
    let ancestor = resolve(directory);
    while (statIfPresent(ancestor) === null) {
      suffix.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
    if (!statSync(ancestor).isDirectory()) throw new Error(`Not a directory: ${ancestor}`);
    return join(realpathSync(ancestor), ...suffix);
  }
  if (!statSync(directory).isDirectory()) throw new Error(`Not a directory: ${directory}`);
  return realpathSync(directory);
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function assertPrivateFile(file: string, bound?: number): void {
  const entry = statIfPresent(file);
  if (entry === null) return;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1)
    throw new Error(`Codex account file must be a private regular file: ${file}`);
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.ino !== entry.ino ||
      opened.dev !== entry.dev ||
      opened.nlink !== 1
    )
      throw new Error(`Codex account file changed while it was validated: ${file}`);
    if (bound !== undefined && opened.size > bound)
      throw new Error(`Codex account file exceeds ${bound} bytes: ${file}`);
  } finally {
    closeSync(descriptor);
  }
}

function sharedEntries(sharedHome: string): ReadonlySet<string> {
  const entries = new Set<string>([...SHARED_DIRECTORIES, ...SHARED_FILES]);
  if (statIfPresent(sharedHome) === null) return entries;
  // Share the pinned runtime's state/config resources, never unknown account
  // credentials, cloud caches, installation identity or individual SQLite files.
  for (const entry of homeEntries(sharedHome))
    if (entry.endsWith(".config.toml")) entries.add(entry);
  return entries;
}

function homeEntries(home: string): readonly string[] {
  const entries: string[] = [];
  const directory = opendirSync(home);
  try {
    let entry = directory.readSync();
    while (entry !== null) {
      if (entries.length === MAX_HOME_ENTRIES)
        throw new Error(
          `Codex home contains more than ${MAX_HOME_ENTRIES} top-level entries: ${home}`,
        );
      entries.push(entry.name);
      entry = directory.readSync();
    }
    return entries;
  } finally {
    directory.closeSync();
  }
}

function assertSharedEntry(sharedHome: string, accountHome: string, entry: string): void {
  const link = join(accountHome, entry);
  const existing = statIfPresent(link);
  if (existing === null) return;
  if (!existing.isSymbolicLink())
    throw new Error(
      `Codex account directory contains its own ${entry}. Choose a fresh account directory.`,
    );
  if (resolve(dirname(link), readlinkSync(link)) !== join(sharedHome, entry))
    throw new Error(`Codex account directory is linked to a different shared home: ${link}`);
}

/** Validate the selected account without changing either directory or reading credentials. */
export function inspectCodexAccountHome(input: {
  readonly sharedHome: string;
  readonly accountHome: string | null;
  readonly platform: string;
}): CodexAccountHome {
  const sharedHome = canonicalDirectory(input.sharedHome);
  if (input.accountHome === null)
    return {
      mode: "direct",
      sharedHome,
      effectiveHome: sharedHome,
      directoryIdentity: null,
      sharedDirectoryIdentity: null,
      sharedEntryNames: [],
    };
  if (input.platform === "win32")
    throw new Error(
      "Separate Codex account directories are unavailable on Windows. Use the native account directory.",
    );
  const original = statIfPresent(input.accountHome);
  if (original?.isSymbolicLink())
    throw new Error("Codex account directory must be a real directory, not a symbolic link.");
  const effectiveHome = canonicalDirectory(input.accountHome);
  if (contains(sharedHome, effectiveHome) || contains(effectiveHome, sharedHome))
    throw new Error(
      "Codex account and shared directories must be separate and cannot contain one another.",
    );
  assertPrivateFile(join(effectiveHome, "auth.json"), MAX_AUTH_FILE_BYTES);
  assertPrivateFile(join(effectiveHome, "models_cache.json"));
  // Native index removal replaces this file with rename(). It must stay private;
  // complete paginated history and authoritative names live in shared SQLite.
  assertPrivateFile(join(effectiveHome, "session_index.jsonl"));
  if (statIfPresent(effectiveHome) !== null) {
    const entries = homeEntries(effectiveHome);
    if (entries.some((entry) => /^state_\d+\.sqlite(?:-(?:wal|shm))?$/.test(entry)))
      throw new Error(
        "Codex account directory contains its own conversation database. Choose a fresh account directory.",
      );
    for (const entry of entries)
      if (entry.endsWith(".config.toml")) assertSharedEntry(sharedHome, effectiveHome, entry);
  }
  for (const entry of sharedEntries(sharedHome))
    assertSharedEntry(sharedHome, effectiveHome, entry);
  return {
    mode: "overlay",
    sharedHome,
    effectiveHome,
    directoryIdentity: null,
    sharedDirectoryIdentity: null,
    sharedEntryNames: [],
  };
}

/** Apply an explicit account selection. Never replace files, links, credentials or history. */
export function prepareCodexAccountHome(
  input: Parameters<typeof inspectCodexAccountHome>[0],
): CodexAccountHome {
  const home = inspectCodexAccountHome(input);
  if (input.accountHome === null) return home;
  mkdirSync(home.sharedHome, { recursive: true, mode: 0o700 });
  mkdirSync(home.effectiveHome, { recursive: true, mode: 0o700 });
  for (const entry of SHARED_DIRECTORIES)
    mkdirSync(join(home.sharedHome, entry), { recursive: true, mode: 0o700 });
  const entries = sharedEntries(home.sharedHome);
  // Complete preflight precedes the first link, so an existing conflict cannot
  // partially redirect an independently used account's native state.
  for (const entry of entries) assertSharedEntry(home.sharedHome, home.effectiveHome, entry);
  for (const entry of entries) {
    const link = join(home.effectiveHome, entry);
    if (statIfPresent(link) !== null) continue;
    symlinkSync(join(home.sharedHome, entry), link);
  }
  const directory = statSync(home.effectiveHome);
  const sharedDirectory = statSync(home.sharedHome);
  return {
    ...home,
    directoryIdentity: { device: directory.dev, inode: directory.ino },
    sharedDirectoryIdentity: { device: sharedDirectory.dev, inode: sharedDirectory.ino },
    sharedEntryNames: [...entries],
  };
}

/** Fence process restarts against an account path that was replaced after startup. */
export function assertCodexAccountHomeIdentity(home: CodexAccountHome, platform: string): void {
  if (home.directoryIdentity === null || home.sharedDirectoryIdentity === null) return;
  const checked = inspectCodexAccountHome({
    sharedHome: home.sharedHome,
    accountHome: home.effectiveHome,
    platform,
  });
  const account = statSync(checked.effectiveHome);
  const shared = statSync(checked.sharedHome);
  if (
    account.dev !== home.directoryIdentity.device ||
    account.ino !== home.directoryIdentity.inode ||
    shared.dev !== home.sharedDirectoryIdentity.device ||
    shared.ino !== home.sharedDirectoryIdentity.inode
  )
    throw new Error(
      "Codex account or shared directory changed after startup. Restart Nodex to select it again.",
    );
  for (const entry of home.sharedEntryNames) {
    if (statIfPresent(join(home.effectiveHome, entry)) === null)
      throw new Error(
        `Codex account directory lost its shared ${entry}. Restart Nodex to prepare it again.`,
      );
    assertSharedEntry(home.sharedHome, home.effectiveHome, entry);
  }
}

export function codexAccountHomeEnvironment(
  home: CodexAccountHome,
  environment: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  if (home.mode === "direct") return { ...environment, CODEX_HOME: home.effectiveHome };
  return {
    ...environment,
    CODEX_HOME: home.effectiveHome,
    // Explicit native config retains precedence over this fallback; the shared
    // CLI and every selected account therefore use the same native history store.
    CODEX_SQLITE_HOME: environment.CODEX_SQLITE_HOME?.trim() || home.sharedHome,
  };
}

export function codexAccountHomeLaunchArgs(home: CodexAccountHome): readonly string[] {
  return home.mode === "direct" ? [] : ["-c", 'cli_auth_credentials_store="file"'];
}
