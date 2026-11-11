import { win32 } from "node:path";

/**
 * A desktop host configures its Desktop Tool runtime (Node REPL, Browser, Chrome, Computer Use)
 * through environment variables, so another host's configuration can reach Nodex in two ways:
 * Nodex can be launched from inside that host's process tree, and that host can persist its own
 * `node_repl` server and shell policy in the Codex home Nodex shares. Codex deep-merges Nodex's
 * Thread config over those persisted layers and cannot delete a persisted key.
 *
 * Nodex therefore owns this configuration for its whole process tree:
 * - Every ambient environment Nodex admits drops another host's Desktop Tool bindings: the
 *   private endpoints, executor identities, verifying keys, and trust roots a host publishes to
 *   its own process tree. They are dropped by ownership, whether or not their endpoint is live.
 * - `node_repl` runs in a closed environment. Within the Desktop Tool namespaces it receives
 *   only the variables Nodex declares, whatever the shared Codex home persists.
 */

/**
 * Exact names, because user-facing shells must keep unrelated `BROWSER_USE_*` variables such as
 * those of third-party browser automation libraries.
 */
const DESKTOP_TOOL_HOST_BINDINGS: ReadonlySet<string> = new Set([
  // Browser Use access authorization: a host's signed request endpoint and its executor.
  "BROWSER_USE_ACCESS_EXECUTOR_ID",
  "BROWSER_USE_ACCESS_PIPE_PATH",
  "BROWSER_USE_ACCESS_VERIFYING_IDENTITY",
  // A host's app tools and task workspace services.
  "CODEX_APP_TOOLS_PIPE_PATH",
  "CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY",
  // Node REPL host services and trust roots.
  "NODE_REPL_HOST_SERVICES_PIPE_PATH",
  "NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S",
  "NODE_REPL_TRUSTED_CODE_PATHS",
  // A host's Computer Use service.
  "SKY_CUA_SERVICE_NATIVE_PIPE_PATH",
  "SKY_CUA_NATIVE_PIPE",
  "SKY_CUA_NATIVE_PIPE_DIRECTORY",
  "CODEX_WINDOWS_REGISTERED_CORE",
  "SKY_CUA_SERVICE_PATH",
  // The Browser backends a host advertises to its own shells.
  "BROWSER_USE_AVAILABLE_BACKENDS",
]);

/** The variable namespaces through which a host configures its Desktop Tool runtime. */
export const DESKTOP_TOOL_RUNTIME_NAMESPACES = [
  "BROWSER_AUTH_",
  "BROWSER_USE_",
  "CODEX_APP_TOOLS_",
  "CODEX_TASK_WORKSPACE_",
  "CUA_REPL_",
  "NODE_REPL_",
  "SKY_",
] as const;

type AmbientEnvironment = Readonly<Record<string, string | undefined>>;

const isDesktopToolHostBinding = (name: string, platform: string): boolean =>
  DESKTOP_TOOL_HOST_BINDINGS.has(platform === "win32" ? name.toUpperCase() : name);

/** Names of Desktop Tool bindings that another host left in an ambient environment. */
export function desktopToolHostBindingNames(
  environment: AmbientEnvironment,
  platform: string = process.platform,
): string[] {
  return Object.keys(environment)
    .filter((name) => isDesktopToolHostBinding(name, platform))
    .sort();
}

/** A compact copy of an ambient environment without another host's Desktop Tool bindings. */
export function withoutDesktopToolHostBindings(
  environment: AmbientEnvironment,
  platform: string = process.platform,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && !isDesktopToolHostBinding(entry[0], platform),
    ),
  );
}

/**
 * Starts `codex sandbox` under the vendor-signed Node and stays alive, because the native
 * Browser and Computer Use peers validate the code-signing identity of `node_repl` and its two
 * nearest ancestors: `node_repl -> codex -> node`. Browser peer identity remains independent from
 * the primary app-server's locked release identity.
 *
 * Its first argument lists the variables Nodex declared for `node_repl`. Codex has merged the
 * shared Codex home's persisted server environment into this process, so the launcher drops every
 * undeclared Desktop Tool variable, then pins the sandbox's shell environment policy so the
 * persisted policy can neither add variables nor replace a declared value. `node_repl` receives
 * exactly this process's remaining environment.
 */
export const NODE_REPL_LAUNCHER_SOURCE = `
const { spawn } = require("node:child_process");
const namespaces = ${JSON.stringify(DESKTOP_TOOL_RUNTIME_NAMESPACES)};
const declared = new Set(JSON.parse(process.argv[1]));
const [codex, subcommand, ...commandArgs] = process.argv.slice(2);
const env = {};
for (const [name, value] of Object.entries(process.env)) {
  const upper = name.toUpperCase();
  if (declared.has(name) || !namespaces.some((prefix) => upper.startsWith(prefix))) {
    env[name] = value;
  }
}
const policy = (key, value) => ["-c", "shell_environment_policy." + key + "=" + value];
const child = spawn(
  codex,
  [
    subcommand,
    ...policy("inherit", '"all"'),
    ...policy("ignore_default_excludes", "false"),
    ...policy("exclude", "[]"),
    ...policy("include_only", JSON.stringify(Object.keys(env))),
    ...[...declared]
      .filter((name) => typeof env[name] === "string")
      .flatMap((name) => policy("set." + name, JSON.stringify(env[name]))),
    ...commandArgs,
  ],
  { env, stdio: "inherit" },
);
const forwardedSignals = new Map();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  const handler = () => {
    if (!child.killed) child.kill(signal);
  };
  forwardedSignals.set(signal, handler);
  process.on(signal, handler);
}
child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  for (const [forwardedSignal, handler] of forwardedSignals) {
    process.off(forwardedSignal, handler);
  }
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
`.trim();

/**
 * The complete `node_repl` server definition. Every field whose persisted value would change what
 * runs, or with which inputs, is pinned; Codex merges only presentation and approval preferences.
 */
export function nodeReplServerDefinition(input: {
  readonly windowsJobLauncher?: string;
  readonly codexCliPath: string;
  readonly env: Readonly<Record<string, string>>;
  readonly nodePath: string;
  readonly nodeReplPath: string;
}): {
  args: string[];
  command: string;
  enabled: boolean;
  env: Record<string, string>;
  env_vars: string[];
  startup_timeout_sec: number;
} {
  if (input.windowsJobLauncher) {
    return {
      args: ["--desktop-tools-repl", input.nodeReplPath, JSON.stringify(input.env)],
      command: input.windowsJobLauncher,
      enabled: true,
      env: {},
      env_vars: [] as string[],
      startup_timeout_sec: 120,
    };
  }
  return {
    args: [
      "-e",
      NODE_REPL_LAUNCHER_SOURCE,
      JSON.stringify(Object.keys(input.env).sort()),
      input.codexCliPath,
      "sandbox",
      "-P",
      ":danger-full-access",
      "--",
      input.nodeReplPath,
    ],
    command: input.nodePath,
    enabled: true,
    env: { ...input.env },
    env_vars: [] as string[],
    startup_timeout_sec: 120,
  };
}

const WINDOWS_REPL_SYSTEM_ENV = [
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "TEMP",
  "TMP",
];

/** Only these OS paths are borrowed from Main; Codex and Agent environments cannot add any. */
export function windowsReplSystemEnvironment(environment: AmbientEnvironment) {
  const canonical = new Map(
    Object.entries(environment).map(([key, value]) => [key.toUpperCase(), value]),
  );
  return Object.fromEntries(
    WINDOWS_REPL_SYSTEM_ENV.flatMap((key) => {
      const value = canonical.get(key);
      return value ? [[key, value] as const] : [];
    }),
  );
}

/** The kernel's sandbox CLI must not reload another desktop's shell policy from shared Codex home. */
export const windowsDesktopToolCodexHome = (runtimeStateHome: string): string =>
  win32.join(runtimeStateHome, "desktop-tools", "codex-home");
