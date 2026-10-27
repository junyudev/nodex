/* @effect-diagnostics asyncFunction:off -- Host-owned shell entrypoints are materialized at the Node filesystem boundary. */
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

type ShellEnvironment = Readonly<Record<string, string | undefined>>;

interface NodexCliShellEnvironmentInput {
  nodexHome: string;
  searchPaths: readonly string[];
  homeDirectory: string;
  inheritedEnvironment: ShellEnvironment;
  configuredEnvironment?: ShellEnvironment;
}

/** A configured user file wins; an inherited Nodex wrapper delegates only to its recorded user file. */
const userStartupPath = (
  inherited: ShellEnvironment,
  configured: ShellEnvironment,
  key: string,
  userKey: string,
  fallback: string,
): string => {
  if (configured[key] === undefined) return inherited[userKey] ?? inherited[key] ?? fallback;
  if (configured[userKey] !== undefined) return configured[userKey];
  if (configured[key] === inherited[key]) return inherited[userKey] ?? configured[key];
  return configured[key];
};

/** Compose the owning Profile's routing last, after configured and inherited user environment. */
export async function composeNodexCliShellEnvironment(
  input: NodexCliShellEnvironmentInput,
): Promise<Record<string, string>> {
  const inherited = input.inheritedEnvironment;
  const configured = input.configuredEnvironment ?? {};
  const paths = nodexCliShellPaths(input.nodexHome);
  const path = [paths.bin, ...input.searchPaths, configured.PATH ?? inherited.PATH ?? ""]
    .filter(Boolean)
    .join(":");
  const zshHome = join(paths.root, "zsh");
  const bashEnv = join(paths.root, "bash-env");
  const userZdotdir = userStartupPath(
    inherited,
    configured,
    "ZDOTDIR",
    "NODEX_USER_ZDOTDIR",
    input.homeDirectory,
  );
  // An empty recorded value means the outer shell had no user BASH_ENV.
  const userBashEnv = userStartupPath(inherited, configured, "BASH_ENV", "NODEX_USER_BASH_ENV", "");
  const routing = {
    NODEX_HOME: input.nodexHome,
    ZDOTDIR: zshHome,
    BASH_ENV: bashEnv,
    NODEX_USER_BASH_ENV: userBashEnv,
  };
  const command = shellQuote(join(paths.bin, "nodex"));
  const bindCommand = [
    ...Object.entries(routing).map(([key, entry]) => `export ${key}=${shellQuote(entry)}`),
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
        ...bindCommand,
        "",
      ].join("\n"),
    );
  }
  await writeExecutable(
    bashEnv,
    [
      ...(userBashEnv
        ? [`if [ -r ${shellQuote(userBashEnv)} ]; then . ${shellQuote(userBashEnv)}; fi`]
        : []),
      `export NODEX_USER_ZDOTDIR=${shellQuote(userZdotdir)}`,
      ...bindCommand,
      "export -f nodex",
      "",
    ].join("\n"),
  );
  return {
    ...routing,
    PATH: path,
    NODEX_USER_ZDOTDIR: userZdotdir,
    // Bash imports exported functions before startup files, including when invoked as sh.
    // Empty definitions prevent an outer function from bypassing this Profile's PATH dispatcher.
    "BASH_FUNC_nodex%%": "",
    "BASH_FUNC_nodex()": "",
  };
}

/** Pin the composed environment in runtime policy so shell snapshots retain the owning entrypoint. */
export async function nodexCliShellLaunchArgs(
  input: Omit<NodexCliShellEnvironmentInput, "configuredEnvironment"> & { codexHome: string },
): Promise<string[]> {
  const source = await readFile(join(input.codexHome, "config.toml"), "utf8").catch(
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
  const configuredEnvironment =
    typeof set === "object" && set !== null && !Array.isArray(set)
      ? Object.fromEntries(Object.entries(set).filter((entry) => typeof entry[1] === "string"))
      : {};
  const environment = await composeNodexCliShellEnvironment({ ...input, configuredEnvironment });
  return Object.entries(environment).flatMap(([key, entry]) => [
    "-c",
    // Codex splits override paths literally on dots; quotes would become part of the key.
    `shell_environment_policy.set.${key}=${JSON.stringify(entry)}`,
  ]);
}

/** Atomically replace this task's routing without changing any other task's binding. */
export async function bindNodexCliShell(input: {
  nodexHome: string;
  threadId: string;
  executable: string;
  profileId: string;
  projectId: string | null;
}): Promise<void> {
  const file = bindingPath(input.nodexHome, input.threadId);
  await mkdir(nodexCliShellPaths(input.nodexHome).bindings, { recursive: true, mode: 0o700 });
  await writeExecutable(
    file,
    [
      "#!/bin/sh",
      `export NODEX_HOME=${shellQuote(input.nodexHome)}`,
      `exec ${shellQuote(input.executable)} --expect-profile ${shellQuote(input.profileId)} ${input.projectId ? `--project ${shellQuote(input.projectId)} ` : ""}"$@"`,
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
