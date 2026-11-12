/* @effect-diagnostics asyncFunction:off -- Host-owned shell entrypoints are materialized at the Node filesystem boundary. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { mergeProcessEnvironments } from "./child-process-environment";
import { scrubHostAgentEnvironment, isAgentProviderVariable } from "../../../host/HostAgentPolicy";
import type { ScopedAgentCoreConnection } from "../../../host/ScopedAgentCore";

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
export async function prepareNodexCliShell(
  nodexHome: string,
  platform: string = process.platform,
  executable?: string,
): Promise<void> {
  const paths = nodexCliShellPaths(nodexHome);
  await mkdir(paths.bin, { recursive: true, mode: 0o700 });
  await rm(paths.bindings, { recursive: true, force: true });
  await mkdir(paths.bindings, { recursive: true, mode: 0o700 });
  if (platform === "win32") {
    await writeExecutable(
      join(paths.bin, "nodex-dispatch.ps1"),
      [
        "$ErrorActionPreference = 'Stop'",
        "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
        "$cliArgs = $args",
        "function Refuse($code, $message) {",
        "  $format = if ([Console]::IsOutputRedirected) { 'json' } else { 'text' }",
        "  for ($i = 0; $i -lt $cliArgs.Length; $i++) {",
        "    if ($cliArgs[$i] -eq '--') { break }",
        "    if ($cliArgs[$i] -eq '--json') { $format = 'json'; break }",
        "    if ($cliArgs[$i] -match '^--output-format=(json|text)$') { $format = $Matches[1] }",
        "    if ($cliArgs[$i] -eq '--output-format' -and $i + 1 -lt $cliArgs.Length) { $format = $cliArgs[++$i] }",
        "  }",
        "  if ($format -eq 'json') {",
        "    $json = @{ version = 1; ok = $false; error = @{ code = $code; message = $message } } | ConvertTo-Json -Compress",
        "    [Console]::Error.WriteLine($json)",
        "    [Console]::WriteLine($json)",
        '  } else { [Console]::Error.WriteLine("${code}: $message") }',
        "  exit 2",
        "}",
        `$env:NODEX_AGENT_PROFILE_HOME = '${nodexHome.replaceAll("'", "''")}'`,
        "$env:NODEX_AGENT_SHELL = '1'",
        "function Unbound {",
        ...(executable
          ? [
              "  $env:NODEX_AGENT_ENDPOINT = $null",
              "  $env:NODEX_AGENT_CREDENTIAL = $null",
              `  & '${executable.replaceAll("'", "''")}' @cliArgs`,
              "  exit $LASTEXITCODE",
            ]
          : [
              "  Refuse AGENT_GENERATION_CHANGED 'The Agent CLI binding is unavailable. Resume the Session in Nodex.'",
            ]),
        "}",
        "$id = $env:NODEX_CLI_TASK_ID; if ([string]::IsNullOrEmpty($id)) { $id = $env:CODEX_THREAD_ID }",
        executable
          ? "if ($id -notmatch '^[a-zA-Z0-9_-]+$') { Unbound }"
          : "if ($id -notmatch '^[a-zA-Z0-9_-]+$') { Refuse AGENT_BINDING_MALFORMED 'No valid task binding. Use plain nodex from the active Turn.' }",
        "$bindings = Join-Path (Split-Path $PSScriptRoot -Parent) 'bindings'",
        "$file = Join-Path $bindings $id",
        "if (!(Test-Path -LiteralPath $file) -and !$env:NODEX_CLI_TASK_ID -and $env:CODEX_SESSION_ID -match '^[a-zA-Z0-9_-]+$') { $file = Join-Path $bindings $env:CODEX_SESSION_ID }",
        "if (!(Test-Path -LiteralPath $file -PathType Leaf)) { Unbound }",
        "try { $binding = Get-Content -Raw -LiteralPath $file -Encoding UTF8 | ConvertFrom-Json } catch { Refuse AGENT_BINDING_MALFORMED 'The Agent CLI binding is malformed. Use plain nodex from the active Turn.' }",
        "if (!$binding.executable) { Unbound }",
        "$env:NODEX_AGENT_ENDPOINT = $binding.agentEndpoint",
        "$env:NODEX_AGENT_CREDENTIAL = $binding.agentCredential",
        "& $binding.executable @args",
        "exit $LASTEXITCODE",
        "",
      ].join("\r\n"),
    );
    await writeExecutable(
      join(paths.bin, "nodex.cmd"),
      '@echo off\r\npowershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0nodex-dispatch.ps1" %*\r\nexit /b %errorlevel%\r\n',
    );
    await writeExecutable(
      join(paths.bin, "nodex"),
      '#!/bin/sh\nexec powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$(dirname "$0")/nodex-dispatch.ps1")" "$@"\n',
    );
    return;
  }
  await writeExecutable(
    join(paths.bin, "nodex"),
    [
      "#!/bin/sh",
      "refuse() {",
      "  code=$1 message=$2; shift 2",
      "  if [ -t 1 ]; then format=text; else format=json; fi",
      "  next=false",
      "  for arg do",
      '    case "$arg" in',
      "      --) break ;;",
      "      --json) format=json; break ;;",
      "      --output-format=json|--output-format=text) format=${arg#*=} ;;",
      "      --output-format) next=true; continue ;;",
      '      *) if "$next" && { [ "$arg" = json ] || [ "$arg" = text ]; }; then format=$arg; fi ;;',
      "    esac",
      "    next=false",
      "  done",
      '  if [ "$format" = json ]; then',
      `    diagnostic=$(printf '{"version":1,"ok":false,"error":{"code":"%s","message":"%s"}}' "$code" "$message")`,
      '    printf "%s\\n" "$diagnostic" >&2',
      '    printf "%s\\n" "$diagnostic"',
      "  else",
      '    printf "%s: %s\\n" "$code" "$message" >&2',
      "  fi",
      "  exit 2",
      "}",
      `export NODEX_AGENT_PROFILE_HOME=${shellQuote(nodexHome)}`,
      "export NODEX_AGENT_SHELL=1",
      "unbound() {",
      ...(executable
        ? [
            "  unset NODEX_AGENT_ENDPOINT NODEX_AGENT_CREDENTIAL",
            `  exec ${shellQuote(executable)} "$@"`,
          ]
        : [
            '  refuse AGENT_GENERATION_CHANGED "The Agent CLI binding is unavailable. Resume the Session in Nodex." "$@"',
          ]),
      "}",
      "id=${NODEX_CLI_TASK_ID:-${CODEX_THREAD_ID-}}",
      'case "$id" in',
      executable
        ? '  ""|*[!a-zA-Z0-9_-]*) unbound "$@" ;;'
        : '  ""|*[!a-zA-Z0-9_-]*) refuse AGENT_BINDING_MALFORMED "No valid task binding. Use plain nodex from the active Turn." "$@" ;;',
      "esac",
      `binding=${shellQuote(paths.bindings)}/"$id"`,
      // The pinned runtime sets CODEX_SESSION_ID to the root task ID for subagents,
      // including resumed children. An explicit child binding (also denial) wins.
      'if [ ! -e "$binding" ] && [ -z "${NODEX_CLI_TASK_ID:-}" ]; then',
      '  case "${CODEX_SESSION_ID-}" in',
      '    ""|*[!a-zA-Z0-9_-]*) ;;',
      `    *) binding=${shellQuote(paths.bindings)}/"$CODEX_SESSION_ID" ;;`,
      "  esac",
      "fi",
      'if [ ! -x "$binding" ] || [ ! -s "$binding" ]; then',
      '  unbound "$@"',
      "fi",
      'exec "$binding" "$@"',
      "",
    ].join("\n"),
  );
}

type ShellEnvironment = Readonly<Record<string, string | undefined>>;

interface NodexCliShellEnvironmentInput {
  nodexHome: string;
  platform?: string;
  searchPaths: readonly string[];
  homeDirectory: string;
  inheritedEnvironment: ShellEnvironment;
  configuredEnvironment?: ShellEnvironment;
  /** Headless shells do not inherit administration variables or user startup files. */
  privateCoreHome?: string;
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
  const inherited = input.privateCoreHome
    ? scrubHostAgentEnvironment(input.inheritedEnvironment, input.privateCoreHome)
    : input.inheritedEnvironment;
  const configured = Object.fromEntries(
    Object.entries(input.configuredEnvironment ?? {}).filter(
      ([name, value]) =>
        value !== undefined &&
        (!input.privateCoreHome || isAgentProviderVariable(name, value, input.privateCoreHome)),
    ),
  );
  const paths = nodexCliShellPaths(input.nodexHome);
  const windows = (input.platform ?? process.platform) === "win32";
  const merged = mergeProcessEnvironments(windows ? "win32" : "posix", inherited, configured);
  const path = [paths.bin, ...input.searchPaths, merged.PATH ?? ""]
    .filter(Boolean)
    .join(windows ? ";" : ":");
  if (windows)
    return {
      NODEX_HOME: input.nodexHome,
      NODEX_AGENT_PROFILE_HOME: input.nodexHome,
      PATH: path,
    };
  const zshHome = join(paths.root, "zsh");
  const bashEnv = join(paths.root, "bash-env");
  const userZdotdir = input.privateCoreHome
    ? ""
    : userStartupPath(inherited, configured, "ZDOTDIR", "NODEX_USER_ZDOTDIR", input.homeDirectory);
  // An empty recorded value means the outer shell had no user BASH_ENV.
  const userBashEnv = input.privateCoreHome
    ? ""
    : userStartupPath(inherited, configured, "BASH_ENV", "NODEX_USER_BASH_ENV", "");
  const routing = {
    NODEX_HOME: input.nodexHome,
    NODEX_AGENT_PROFILE_HOME: input.nodexHome,
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
        ...(input.privateCoreHome
          ? []
          : [`if [[ -r "$ZDOTDIR/${name}" ]]; then source "$ZDOTDIR/${name}"; fi`]),
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
  environment.NODEX_AGENT_SHELL = "1";
  if (input.privateCoreHome) {
    const configured = Object.fromEntries(
      Object.entries(configuredEnvironment).filter(([name, value]) =>
        isAgentProviderVariable(name, value, input.privateCoreHome!),
      ),
    );
    // Replace the native table so rejected configured keys cannot survive a dotted override.
    const table = Object.entries({ ...configured, ...environment })
      .map(([name, value]) => `${JSON.stringify(name)}=${JSON.stringify(value)}`)
      .join(",");
    return ["-c", `shell_environment_policy.set={${table}}`];
  }
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
  platform?: string;
  executable: string;
  scopedConnection: ScopedAgentCoreConnection;
}): Promise<void> {
  const file = bindingPath(input.nodexHome, input.threadId);
  await mkdir(nodexCliShellPaths(input.nodexHome).bindings, { recursive: true, mode: 0o700 });
  if ((input.platform ?? process.platform) === "win32") {
    await writeExecutable(
      file,
      JSON.stringify({
        executable: input.executable,
        agentEndpoint: input.scopedConnection.endpoint,
        agentCredential: input.scopedConnection.credential,
      }),
    );
    return;
  }
  await writeExecutable(
    file,
    [
      "#!/bin/sh",
      `export NODEX_AGENT_PROFILE_HOME=${shellQuote(input.nodexHome)}`,
      `export NODEX_AGENT_ENDPOINT=${shellQuote(input.scopedConnection.endpoint)}`,
      `export NODEX_AGENT_CREDENTIAL=${shellQuote(input.scopedConnection.credential)}`,
      `exec ${shellQuote(input.executable)} "$@"`,
      "",
    ].join("\n"),
  );
}

export async function unbindNodexCliShell(
  nodexHome: string,
  threadId: string,
  platform: string = process.platform,
): Promise<void> {
  const file = bindingPath(nodexHome, threadId);
  await mkdir(nodexCliShellPaths(nodexHome).bindings, { recursive: true, mode: 0o700 });
  if (platform === "win32") {
    await writeExecutable(file, "{}");
    return;
  }
  await writeExecutable(file, "");
}
