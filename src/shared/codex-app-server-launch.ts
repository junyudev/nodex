/** Native desktop launch grammar for the bundled Codex CLI. */
export const codexCliAppServerArgs = (
  environment: Readonly<Record<string, string | undefined>> = {},
): string[] => {
  const overrides = [
    ["chatgpt_base_url", "CODEX_APP_SERVER_CHATGPT_BASE_URL"],
    ["openai_base_url", "CODEX_APP_SERVER_OPENAI_BASE_URL"],
  ].flatMap(([key, variable]) => {
    const value = environment[variable!]?.trim();
    return value ? ["-c", `${key}=${JSON.stringify(value)}`] : [];
  });
  const features = ["-c", "features.code_mode_host=true"];
  return overrides.length === 0
    ? [...features, "app-server", "--analytics-default-enabled"]
    : ["app-server", ...features, ...overrides, "--analytics-default-enabled"];
};
