import * as Context from "effect/Context";

/** A trusted, argv-based launcher; no part of this configuration is evaluated by a shell. */
export interface AgentRunner {
  readonly user: string;
  readonly launcher: readonly [string, ...string[]];
}

/** Serve supplies this policy. The personal desktop retains its own execution environment. */
export class HostAgentPolicy extends Context.Service<
  HostAgentPolicy,
  {
    readonly coreHome: string;
    readonly agentRunner?: AgentRunner;
  }
>()("nodex/host/HostAgentPolicy") {}

const PROCESS_VARIABLES = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PATH",
  "TERM",
  "COLORTERM",
  "LANG",
  "TZ",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "SSH_AUTH_SOCK",
]);

/** Inherited host variables are denied by default, including shell startup and Node injection. */
export const scrubHostAgentEnvironment = (
  inherited: Readonly<Record<string, string | undefined>>,
  coreHome: string,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(inherited).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        (PROCESS_VARIABLES.has(entry[0].toUpperCase()) || /^LC_[A-Z_]+$/u.test(entry[0])) &&
        !entry[1].includes(coreHome),
    ),
  );

/** Explicit provider credentials may pass; host capability variables and private paths may not. */
export const isAgentProviderVariable = (name: string, value: string, coreHome: string): boolean =>
  !/^(?:NODEX_|ELECTRON_|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$|ZDOTDIR$|DYLD_|LD_)/iu.test(
    name,
  ) && !value.includes(coreHome);

export const agentProcessLaunch = (
  executable: string,
  args: readonly string[],
  runner?: AgentRunner,
): { readonly executable: string; readonly args: readonly string[] } => {
  if (!runner) return { executable, args };
  const [launcher, ...prefix] = runner.launcher;
  if (!runner.user.trim() || !launcher.trim()) throw new Error("Agent Runner is incomplete");
  return { executable: launcher, args: [...prefix, executable, ...args] };
};
