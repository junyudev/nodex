const ENDPOINT_VARIABLES = [
  ["chatgpt_base_url", "CODEX_APP_SERVER_CHATGPT_BASE_URL"],
  ["openai_base_url", "CODEX_APP_SERVER_OPENAI_BASE_URL"],
] as const;

/** An endpoint explicitly supplied to the app retains precedence over shell recovery. */
export const codexAppServerEndpointEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    ENDPOINT_VARIABLES.flatMap(([, variable]) => {
      const value = environment[variable];
      return value === undefined ? [] : [[variable, value]];
    }),
  );

export const codexAppServerEndpointOverrides = (
  environment: Readonly<Record<string, string | undefined>>,
): string[] =>
  ENDPOINT_VARIABLES.flatMap(([key, variable]) => {
    const value = environment[variable]?.trim();
    return value ? ["-c", `${key}=${JSON.stringify(value)}`] : [];
  });

/** Native desktop launch grammar for the bundled Codex CLI. */
export const codexCliAppServerArgs = (
  environment: Readonly<Record<string, string | undefined>> = {},
): string[] => {
  const overrides = codexAppServerEndpointOverrides(environment);
  const features = ["-c", "features.code_mode_host=true"];
  return overrides.length === 0
    ? [...features, "app-server", "--analytics-default-enabled"]
    : ["app-server", ...features, ...overrides, "--analytics-default-enabled"];
};
