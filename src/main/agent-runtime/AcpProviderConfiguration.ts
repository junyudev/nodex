import { join, parse } from "node:path";
import type { AgentRuntimeConfiguration } from "@nodex/agent-runtime/contracts";
import type { AcpAgentInstanceConfig } from "../../shared/acp-agent-settings";

const baseNames = new Set([
  "PATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
]);
const profileNames = new Set([
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
]);
const proxyName = /^(?:all|http|https|no)_proxy$/iu;

/** The host selects the environment once; the Runtime never implicitly inherits its process. */
export function acpProviderConfiguration(input: {
  readonly instance: AcpAgentInstanceConfig;
  readonly inheritedEnvironment: Readonly<Record<string, string | undefined>>;
  readonly environment: Readonly<Record<string, string>>;
  readonly homeDirectory: string;
}) {
  const { instance } = input;
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.inheritedEnvironment)) {
    if (value === undefined) continue;
    const key = name.toUpperCase();
    if (
      baseNames.has(key) ||
      (instance.proxy === "inherit-host" && proxyName.test(name)) ||
      (instance.credentials.kind === "inherit-host-profile" && profileNames.has(key))
    )
      environment[name] = value;
  }
  if (instance.credentials.kind === "isolated-home") {
    const home = instance.credentials.home;
    Object.assign(environment, {
      HOME: home,
      USERPROFILE: home,
      HOMEDRIVE: parse(home).root.replace(/[\\/]$/u, ""),
      HOMEPATH: home.slice(parse(home).root.length - 1),
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
    });
  } else {
    environment.HOME ??= input.homeDirectory;
  }
  // A disabled instance still names the same native profile, without resolving its secrets.
  for (const variable of instance.environment) {
    if (!variable.sensitive && typeof variable.value === "string")
      environment[variable.name] = variable.value;
  }
  if (instance.enabled) Object.assign(environment, input.environment);
  const source = instance.source;
  return {
    driver: "acpRegistry",
    displayName: instance.displayName,
    enabled: instance.enabled,
    environment: Object.entries(environment).map(([name, value]) => ({
      name,
      value,
      sensitive: instance.environment.some((entry) => entry.name === name && entry.sensitive),
    })),
    config: {
      ...(source.kind === "local"
        ? { source: "local", commandPath: source.executable, commandArgs: source.args }
        : {
            source: "registry",
            agentId: source.agentId,
            distribution: source.distribution,
            ...(source.installationId ? { installationId: source.installationId } : {}),
            ...(source.executableOverride ? { commandPath: source.executableOverride } : {}),
          }),
      inheritEnvironment: false,
      agentIdentity: instance.agentDefinitionId,
      discovery: "explicit",
      customModels: instance.customModels,
      ...(instance.authMethodId ? { authMethodId: instance.authMethodId } : {}),
    },
  } satisfies AgentRuntimeConfiguration["providers"][string];
}
