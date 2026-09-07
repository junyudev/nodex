/* oxlint-disable effecttsgo/async-function -- Host-owned shell entrypoints are materialized at the Node filesystem boundary. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export const nodexCliShellPaths = (nodexHome: string) => {
  const root = join(nodexHome, "runtime", "agent-cli");
  return { root, bin: join(root, "bin"), bindings: join(root, "bindings") };
};

// Runtime thread IDs are opaque path components, never shell expressions or relative paths.
const bindingPath = (nodexHome: string, threadId: string): string => {
  if (!/^[a-zA-Z0-9_-]+$/.test(threadId)) throw new Error("Invalid CLI task identity");
  return join(nodexCliShellPaths(nodexHome).bindings, threadId);
};

async function writeExecutable(file: string, source: string): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, source, { mode: 0o700, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** One Profile-local dispatcher; each command resolves its own runtime-provided task ID. */
export async function prepareNodexCliShell(nodexHome: string): Promise<void> {
  const paths = nodexCliShellPaths(nodexHome);
  await mkdir(paths.bin, { recursive: true, mode: 0o700 });
  await rm(paths.bindings, { recursive: true, force: true });
  await mkdir(paths.bindings, { recursive: true, mode: 0o700 });
  await writeExecutable(
    join(paths.bin, "nodex"),
    [
      "#!/bin/sh",
      'case "${CODEX_THREAD_ID-}" in',
      '  ""|*[!a-zA-Z0-9_-]*) printf "%s\\n" "Nodex CLI unavailable: no valid task binding." >&2; exit 1 ;;',
      "esac",
      `binding=${shellQuote(paths.bindings)}/"$CODEX_THREAD_ID"`,
      // The pinned runtime sets CODEX_SESSION_ID to the root task ID for subagents,
      // including resumed children. An explicit child binding (also denial) wins.
      'if [ ! -e "$binding" ]; then',
      '  case "${CODEX_SESSION_ID-}" in',
      '    ""|*[!a-zA-Z0-9_-]*) ;;',
      `    *) binding=${shellQuote(paths.bindings)}/"$CODEX_SESSION_ID" ;;`,
      "  esac",
      "fi",
      'if [ ! -x "$binding" ]; then',
      '  printf "%s\\n" "Nodex CLI unavailable for this task. Refresh the task context in Nodex." >&2',
      "  exit 1",
      "fi",
      'exec "$binding" "$@"',
      "",
    ].join("\n"),
  );
}

/** Pin PATH in the runtime shell policy so login-shell snapshots cannot lose the host entrypoint. */
export async function nodexCliShellLaunchArgs(input: {
  nodexHome: string;
  runtimeStateHome: string;
  searchPaths: readonly string[];
  inheritedPath: string;
  homeDirectory: string;
  inheritedZdotdir?: string;
  inheritedBashEnv?: string;
}): Promise<string[]> {
  const source = await readFile(join(input.runtimeStateHome, "config.toml"), "utf8").catch(
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
      throw error;
    },
  );
  const config = parseToml(source);
  const policy = config.shell_environment_policy;
  const set =
    typeof policy === "object" && policy !== null && !Array.isArray(policy) && "set" in policy
      ? policy.set
      : undefined;
  const configuredPath =
    typeof set === "object" && set !== null && !Array.isArray(set) && "PATH" in set
      ? set.PATH
      : undefined;
  const path = [
    nodexCliShellPaths(input.nodexHome).bin,
    ...input.searchPaths,
    typeof configuredPath === "string" ? configuredPath : input.inheritedPath,
  ]
    .filter(Boolean)
    .join(":");
  const value = (key: string): string | undefined => {
    if (typeof set !== "object" || set === null || !(key in set)) return undefined;
    const candidate = (set as Record<string, unknown>)[key];
    return typeof candidate === "string" ? candidate : undefined;
  };
  const paths = nodexCliShellPaths(input.nodexHome);
  const zshHome = join(paths.root, "zsh");
  const bashEnv = join(paths.root, "bash-env");
  const userZdotdir = value("ZDOTDIR") ?? input.inheritedZdotdir ?? input.homeDirectory;
  const userBashEnv = value("BASH_ENV") ?? input.inheritedBashEnv ?? "";
  const command = shellQuote(join(paths.bin, "nodex"));
  const bindCommand = [
    "unalias nodex 2>/dev/null || true",
    `nodex() { ${command} "$@"; }`,
    `export PATH=${shellQuote(paths.bin)}:"$PATH"`,
  ];
  // Zsh reads .zshenv even for non-login shells and may prepend a globally installed
  // CLI ahead of PATH policy. Delegate startup files, then restore the host command.
  // Snapshot restoration retains the same function; it resolves the live task ID.
  await mkdir(zshHome, { recursive: true, mode: 0o700 });
  for (const name of [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"]) {
    await writeExecutable(
      join(zshHome, name),
      [
        `ZDOTDIR=\${NODEX_USER_ZDOTDIR:-${shellQuote(userZdotdir)}}`,
        `if [[ -r "$ZDOTDIR/${name}" ]]; then source "$ZDOTDIR/${name}"; fi`,
        'export NODEX_USER_ZDOTDIR="${ZDOTDIR:-$HOME}"',
        `export ZDOTDIR=${shellQuote(zshHome)}`,
        ...bindCommand,
        "",
      ].join("\n"),
    );
  }
  await writeExecutable(
    bashEnv,
    [
      'if [ -n "${NODEX_USER_BASH_ENV:-}" ] && [ -r "$NODEX_USER_BASH_ENV" ]; then . "$NODEX_USER_BASH_ENV"; fi',
      ...bindCommand,
      "export -f nodex",
      "",
    ].join("\n"),
  );
  const environment = {
    PATH: path,
    ZDOTDIR: zshHome,
    BASH_ENV: bashEnv,
    NODEX_USER_ZDOTDIR: userZdotdir,
    NODEX_USER_BASH_ENV: userBashEnv,
  };
  return Object.entries(environment).flatMap(([key, entry]) => [
    "-c",
    `shell_environment_policy.set.${key}=${JSON.stringify(entry)}`,
  ]);
}

/** Atomically replace this task's routing without changing any other task's binding. */
export async function bindNodexCliShell(input: {
  nodexHome: string;
  threadId: string;
  executable: string;
  profileId: string;
  projectId: string;
}): Promise<void> {
  const file = bindingPath(input.nodexHome, input.threadId);
  await mkdir(nodexCliShellPaths(input.nodexHome).bindings, { recursive: true, mode: 0o700 });
  await writeExecutable(
    file,
    [
      "#!/bin/sh",
      `export NODEX_HOME=${shellQuote(input.nodexHome)}`,
      `exec ${shellQuote(input.executable)} --expect-profile ${shellQuote(input.profileId)} --project ${shellQuote(input.projectId)} "$@"`,
      "",
    ].join("\n"),
  );
}

export async function unbindNodexCliShell(nodexHome: string, threadId: string): Promise<void> {
  const file = bindingPath(nodexHome, threadId);
  await mkdir(nodexCliShellPaths(nodexHome).bindings, { recursive: true, mode: 0o700 });
  await writeExecutable(
    file,
    [
      "#!/bin/sh",
      'printf "%s\\n" "Nodex CLI unavailable for this task. Refresh the task context in Nodex." >&2',
      "exit 1",
      "",
    ].join("\n"),
  );
}
