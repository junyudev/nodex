const BASE_ENVIRONMENT_KEYS = new Set(["LANG", "LC_ALL", "PATH", "SHELL", "TERM", "TMPDIR"]);
const PROXY_KEY = /^(?:all|http|https|no)_proxy$/i;
const CREDENTIAL_KEY = /^(?:ANTHROPIC_|CLAUDE_|AWS_|GOOGLE_|CLOUD_ML_)/;

export const selectClaudeAcpEnvironment = (
  source: Readonly<Record<string, string | undefined>>,
  policy: Pick<import("../../../shared/types").AcpAgentInstanceConfig, "credentials" | "proxy">,
  isolatedHome: string | null,
): Readonly<Record<string, string | undefined>> => {
  const selected: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (BASE_ENVIRONMENT_KEYS.has(name)) selected[name] = value;
    if (policy.proxy === "inherit-host" && PROXY_KEY.test(name)) selected[name] = value;
    if (policy.credentials.kind === "inherit-host-profile" && CREDENTIAL_KEY.test(name)) {
      selected[name] = value;
    }
  }
  if (policy.credentials.kind === "inherit-host-profile" && source.HOME !== undefined) {
    selected.HOME = source.HOME;
  }
  if (isolatedHome !== null) {
    selected.HOME = isolatedHome;
    selected.XDG_CONFIG_HOME = isolatedHome;
  }
  return selected;
};
