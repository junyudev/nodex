import { delimiter, join } from "node:path";

/** Independent Nodex processes must never adopt the launching Agent's shell. */
export function withoutAgentShell(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...environment };
  const profile = clean.NODEX_AGENT_PROFILE_HOME;
  if (profile) {
    const root = join(profile, "runtime", "agent-cli");
    const path = clean.PATH?.split(delimiter).filter((entry) => entry !== join(root, "bin"));
    if (path) clean.PATH = path.join(delimiter);
    if (clean.BASH_ENV === join(root, "bash-env")) {
      clean.BASH_ENV = clean.NODEX_USER_BASH_ENV || undefined;
    }
    if (clean.ZDOTDIR === join(root, "zsh")) clean.ZDOTDIR = clean.NODEX_USER_ZDOTDIR;
  }
  for (const key of [
    "NODEX_AGENT_ENDPOINT",
    "NODEX_AGENT_CREDENTIAL",
    "NODEX_AGENT_SHELL",
    "NODEX_AGENT_PROFILE_HOME",
    "NODEX_CLI_TASK_ID",
    "CODEX_THREAD_ID",
    "CODEX_SESSION_ID",
    "BASH_FUNC_nodex%%",
    "BASH_FUNC_nodex()",
  ]) {
    delete clean[key];
  }
  for (const key of ["BASH_ENV", "ZDOTDIR"]) {
    if (clean[key] === undefined) delete clean[key];
  }
  return clean;
}
